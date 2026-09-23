import { CATEGORY_KEYS } from '../db.js';
import { addDays, countWeekdays, today, weeksBetween } from '../dates.js';

export const TARGET_UTILIZATION = Number(process.env.TARGET_UTILIZATION || 0.75);

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const emptyCats = () => Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0]));
const placeholders = (arr) => arr.map(() => '?').join(',');

function statusesFor(includeDrafts) {
  return includeDrafts ? ['borrador', 'enviado', 'aprobado', 'rechazado'] : ['enviado', 'aprobado'];
}

export function entryRows(db, { from, to, userIds, projectId, includeDrafts }) {
  if (!userIds.length) return [];
  const statuses = statusesFor(includeDrafts);
  const params = [from, to, ...userIds, ...statuses];
  let projectFilter = '';
  if (projectId) { projectFilter = 'AND p.id = ?'; params.push(projectId); }
  return db.prepare(`
    SELECT e.work_date AS date, e.hours, e.note, ts.week_start AS week, ts.status,
           u.id AS userId, u.name AS userName, u.email AS userEmail, u.area,
           p.id AS projectId, p.code AS projectCode, p.name AS projectName, p.client,
           t.id AS taskId, t.name AS taskName, COALESCE(t.category, p.category) AS category
    FROM time_entries e
    JOIN timesheets ts ON ts.id = e.timesheet_id
    JOIN users u ON u.id = ts.user_id
    JOIN tasks t ON t.id = e.task_id
    JOIN projects p ON p.id = t.project_id
    WHERE e.work_date BETWEEN ? AND ?
      AND u.id IN (${placeholders(userIds)})
      AND ts.status IN (${placeholders(statuses)})
      ${projectFilter}
    ORDER BY e.work_date, u.name, p.name, t.name`).all(...params);
}

export function computeMetrics(db, { from, to, userIds, projectId, includeDrafts = false }) {
  const rows = entryRows(db, { from, to, userIds, projectId, includeDrafts });
  const users = userIds.length
    ? db.prepare(`SELECT id, name, area, weekly_capacity FROM users WHERE active = 1 AND tracks_time = 1 AND id IN (${placeholders(userIds)}) ORDER BY name`).all(...userIds)
    : [];
  const weekdays = countWeekdays(from, to);

  const totals = { hours: 0, byCategory: emptyCats() };
  const perUser = new Map(users.map((u) => [u.id, { hours: 0, byCategory: emptyCats() }]));
  const perWeek = new Map(weeksBetween(from, to).map((w) => [w, emptyCats()]));
  const perProject = new Map();

  for (const r of rows) {
    const cat = CATEGORY_KEYS.includes(r.category) ? r.category : 'interno';
    totals.hours += r.hours;
    totals.byCategory[cat] += r.hours;
    const pu = perUser.get(r.userId);
    if (pu) { pu.hours += r.hours; pu.byCategory[cat] += r.hours; }
    const pw = perWeek.get(r.week);
    if (pw) pw[cat] += r.hours;
    if (!perProject.has(r.projectId)) {
      perProject.set(r.projectId, { id: r.projectId, code: r.projectCode, name: r.projectName, client: r.client, category: cat, hours: 0 });
    }
    perProject.get(r.projectId).hours += r.hours;
  }

  // Cargabilidad: horas facturables / horas disponibles. La "neta" descuenta
  // ausencias (vacaciones, incapacidad) de la capacidad.
  const utilization = users.map((u) => {
    const pu = perUser.get(u.id);
    const capacity = round((u.weekly_capacity / 5) * weekdays);
    const billable = pu.byCategory.facturable;
    const absence = pu.byCategory.ausencia;
    const available = Math.max(capacity - absence, 0);
    return {
      userId: u.id,
      name: u.name,
      area: u.area,
      capacity,
      hours: round(pu.hours),
      billable: round(billable),
      absence: round(absence),
      byCategory: Object.fromEntries(Object.entries(pu.byCategory).map(([k, v]) => [k, round(v)])),
      utilization: capacity ? round(billable / capacity, 4) : 0,
      netUtilization: available ? round(billable / available, 4) : 0,
      occupancy: capacity ? round(pu.hours / capacity, 4) : 0,
    };
  });
  // Los KPIs de cargabilidad solo consideran a quien tiene capacidad registrada
  // (p. ej. un líder que no factura puede capturar horas sin sesgar el indicador).
  const capacityTotal = utilization.reduce((s, u) => s + u.capacity, 0);
  const billableTotal = utilization.reduce((s, u) => s + u.billable, 0);
  const absenceTotal = utilization.reduce((s, u) => s + u.absence, 0);

  // Plan vs. real por proyecto (el real es acumulado histórico, no solo del rango).
  const projectIds = [...perProject.keys()];
  const planRows = projectIds.length
    ? db.prepare(`
        SELECT p.id,
          (SELECT COALESCE(SUM(t.planned_hours), 0) FROM tasks t WHERE t.project_id = p.id AND t.is_summary = 0 AND t.active = 1) AS planned,
          (SELECT COALESCE(SUM(e.hours), 0) FROM time_entries e JOIN tasks t ON t.id = e.task_id
             JOIN timesheets ts ON ts.id = e.timesheet_id
             WHERE t.project_id = p.id AND ts.status IN (${placeholders(statusesFor(includeDrafts))})) AS actualToDate,
          (SELECT MIN(start_date) FROM tasks t WHERE t.project_id = p.id) AS start,
          (SELECT MAX(finish_date) FROM tasks t WHERE t.project_id = p.id) AS finish
        FROM projects p WHERE p.id IN (${placeholders(projectIds)})`).all(...statusesFor(includeDrafts), ...projectIds)
    : [];
  const plan = new Map(planRows.map((r) => [r.id, r]));
  const projects = [...perProject.values()]
    .map((p) => {
      const pl = plan.get(p.id) || {};
      return {
        ...p,
        hours: round(p.hours),
        planned: round(pl.planned || 0),
        actualToDate: round(pl.actualToDate || 0),
        consumed: pl.planned ? round(pl.actualToDate / pl.planned, 4) : null,
        start: pl.start || null,
        finish: pl.finish || null,
      };
    })
    .sort((a, b) => b.hours - a.hours);

  // Cumplimiento: semanas ya transcurridas con timesheet enviado o aprobado.
  const lastClosedWeek = addDays(today(), -7);
  const weeks = weeksBetween(from, to).filter((w) => w <= lastClosedWeek);
  const tsRows = users.length && weeks.length
    ? db.prepare(`SELECT user_id, week_start, status FROM timesheets
        WHERE user_id IN (${placeholders(users.map((u) => u.id))}) AND week_start IN (${placeholders(weeks)})`)
        .all(...users.map((u) => u.id), ...weeks)
    : [];
  const tsMap = new Map(tsRows.map((r) => [`${r.user_id}|${r.week_start}`, r.status]));
  let onTime = 0;
  const compliance = users.map((u) => {
    const cells = weeks.map((w) => tsMap.get(`${u.id}|${w}`) || 'sin registrar');
    const done = cells.filter((s) => s === 'enviado' || s === 'aprobado').length;
    onTime += done;
    return { userId: u.id, name: u.name, weeks: cells, done, expected: weeks.length };
  });

  return {
    range: { from, to, weekdays, includeDrafts },
    target: TARGET_UTILIZATION,
    kpis: {
      hours: round(totals.hours),
      billable: round(billableTotal),
      capacity: round(capacityTotal),
      utilization: capacityTotal ? round(billableTotal / capacityTotal, 4) : 0,
      netUtilization: capacityTotal - absenceTotal > 0 ? round(billableTotal / (capacityTotal - absenceTotal), 4) : 0,
      compliance: users.length * weeks.length ? round(onTime / (users.length * weeks.length), 4) : null,
      consultants: users.length,
    },
    byCategory: Object.fromEntries(Object.entries(totals.byCategory).map(([k, v]) => [k, round(v)])),
    weekly: [...perWeek.entries()].map(([week, cats]) => ({ week, ...Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, round(v)])) })),
    utilization,
    projects,
    compliance: { weeks, rows: compliance },
  };
}

export function entriesToCsv(rows) {
  const header = ['fecha', 'semana', 'estatus', 'consultor', 'correo', 'area', 'codigo_proyecto', 'proyecto', 'cliente', 'tarea', 'rubro', 'horas', 'nota'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [r.date, r.week, r.status, r.userName, r.userEmail, r.area, r.projectCode, r.projectName, r.client, r.taskName, r.category, r.hours, r.note]
      .map(esc).join(','));
  return `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`;
}
