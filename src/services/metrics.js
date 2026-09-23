import { addDays, countWeekdays, isWeekday, today, weeksBetween } from '../dates.js';
import { holidaysBetween } from './timesheets.js';

export const TARGET_EFFICIENCY = Number(process.env.TARGET_EFFICIENCY || process.env.TARGET_UTILIZATION || 0.75);

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const ratio = (a, b) => (b > 0 ? round(a / b, 4) : null);
const placeholders = (arr) => arr.map(() => '?').join(',');

function statusesFor(includeDrafts) {
  return includeDrafts ? ['borrador', 'enviado', 'aprobado', 'rechazado'] : ['enviado', 'aprobado'];
}

export function entryRows(db, { from, to, userIds, projectId, clientId, includeDrafts }) {
  if (!userIds.length) return [];
  const statuses = statusesFor(includeDrafts);
  const params = [from, to, ...userIds, ...statuses];
  let extra = '';
  if (projectId) { extra += ' AND p.id = ?'; params.push(projectId); }
  if (clientId) { extra += ' AND p.client_id = ?'; params.push(clientId); }
  return db.prepare(`
    SELECT e.work_date AS date, e.hours, e.note, ts.week_start AS week, ts.status,
           u.id AS userId, u.name AS userName, u.email AS userEmail, u.area,
           p.id AS projectId, p.code AS projectCode, p.name AS projectName, p.is_internal AS isAdmin,
           c.name AS client, t.id AS taskId, t.name AS taskName, t.reduces_availability AS reduces,
           m.code AS moduleCode, m.name AS moduleName
    FROM time_entries e
    JOIN timesheets ts ON ts.id = e.timesheet_id
    JOIN users u ON u.id = ts.user_id
    JOIN tasks t ON t.id = e.task_id
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN modules m ON m.id = t.module_id
    WHERE e.work_date BETWEEN ? AND ?
      AND u.id IN (${placeholders(userIds)})
      AND ts.status IN (${placeholders(statuses)})
      ${extra}
    ORDER BY e.work_date, u.name, p.name, t.name`).all(...params);
}

/*
 * Definiciones (por consultor y periodo):
 *   Capacidad        = horas semanales / 5 × días hábiles (lun–vie) del periodo
 *   Festivos         = horas semanales / 5 × días festivos hábiles del periodo
 *   Disponibilidad   = capacidad − festivos − horas en tareas administrativas que descuentan disponibilidad
 *   Facturables      = horas en proyectos (todo lo que no es tarea administrativa)
 *   Eficiencia       = facturables / disponibilidad
 */
export function computeMetrics(db, { from, to, userIds, projectId, clientId, includeDrafts = false }) {
  const rows = entryRows(db, { from, to, userIds, projectId, clientId, includeDrafts });
  const users = userIds.length
    ? db.prepare(`SELECT id, name, area, weekly_capacity FROM users
        WHERE active = 1 AND tracks_time = 1 AND id IN (${placeholders(userIds)}) ORDER BY name`).all(...userIds)
    : [];
  const weekdays = countWeekdays(from, to);
  const holidays = holidaysBetween(db, from, to).filter((h) => isWeekday(h.date));

  const blank = () => ({ project: 0, admin: 0, deduct: 0 });
  const perUser = new Map(users.map((u) => [u.id, blank()]));
  const perWeek = new Map(weeksBetween(from, to).map((w) => [w, blank()]));
  const perProject = new Map();
  const perAdminTask = new Map();
  const perModule = new Map();
  let total = 0;

  for (const r of rows) {
    total += r.hours;
    const bucket = r.isAdmin ? (r.reduces ? 'deduct' : 'admin') : 'project';
    const pu = perUser.get(r.userId);
    if (pu) pu[bucket] += r.hours;
    const pw = perWeek.get(r.week);
    if (pw) pw[bucket] += r.hours;
    if (r.isAdmin) {
      const t = perAdminTask.get(r.taskId) || { taskId: r.taskId, name: r.taskName, reducesAvailability: !!r.reduces, hours: 0 };
      t.hours += r.hours;
      perAdminTask.set(r.taskId, t);
    } else {
      const p = perProject.get(r.projectId) || { id: r.projectId, code: r.projectCode, name: r.projectName, client: r.client, hours: 0 };
      p.hours += r.hours;
      perProject.set(r.projectId, p);
      const key = r.moduleCode || '';
      const m = perModule.get(key) || { code: r.moduleCode || null, name: r.moduleName || 'Sin módulo', hours: 0 };
      m.hours += r.hours;
      perModule.set(key, m);
    }
  }

  const people = users.map((u) => {
    const pu = perUser.get(u.id);
    const daily = u.weekly_capacity / 5;
    const capacity = daily * weekdays;
    const holidayHours = daily * holidays.length;
    const availability = Math.max(capacity - holidayHours - pu.deduct, 0);
    const registered = pu.project + pu.admin + pu.deduct;
    return {
      userId: u.id,
      name: u.name,
      area: u.area,
      capacity: round(capacity),
      holidayHours: round(holidayHours),
      deductHours: round(pu.deduct),
      availability: round(availability),
      projectHours: round(pu.project),
      adminHours: round(pu.admin + pu.deduct),
      registered: round(registered),
      unregistered: round(Math.max(capacity - holidayHours - registered, 0)),
      efficiency: ratio(pu.project, availability),
    };
  });
  const sum = (k) => people.reduce((s, p) => s + p[k], 0);

  // Horas vendidas / planeadas / reales acumuladas por proyecto.
  const projectIds = [...perProject.keys()];
  const statuses = statusesFor(includeDrafts);
  const planRows = projectIds.length
    ? db.prepare(`
        SELECT p.id, p.sold_hours AS sold, p.status, p.stage,
          (SELECT COALESCE(SUM(t.planned_hours), 0) FROM tasks t WHERE t.project_id = p.id AND t.is_summary = 0 AND t.active = 1) AS planned,
          (SELECT COALESCE(SUM(e.hours), 0) FROM time_entries e JOIN tasks t ON t.id = e.task_id
             JOIN timesheets ts ON ts.id = e.timesheet_id
             WHERE t.project_id = p.id AND ts.status IN (${placeholders(statuses)})) AS actualToDate
        FROM projects p WHERE p.id IN (${placeholders(projectIds)})`).all(...statuses, ...projectIds)
    : [];
  const plan = new Map(planRows.map((r) => [r.id, r]));
  const projects = [...perProject.values()].map((p) => {
    const pl = plan.get(p.id) || {};
    return {
      ...p,
      hours: round(p.hours),
      status: pl.status,
      stage: pl.stage,
      sold: pl.sold ?? null,
      planned: round(pl.planned || 0),
      actualToDate: round(pl.actualToDate || 0),
      consumedSold: pl.sold ? round(pl.actualToDate / pl.sold, 4) : null,
    };
  }).sort((a, b) => b.hours - a.hours);

  // Cumplimiento: semanas ya transcurridas con timesheet enviado o aprobado.
  const lastClosedWeek = addDays(today(), -7);
  const weeks = weeksBetween(from, to).filter((w) => w <= lastClosedWeek);
  const tsRows = users.length && weeks.length
    ? db.prepare(`SELECT user_id, week_start, status FROM timesheets
        WHERE user_id IN (${placeholders(users.map((u) => u.id))}) AND week_start IN (${placeholders(weeks)})`)
        .all(...users.map((u) => u.id), ...weeks)
    : [];
  const tsMap = new Map(tsRows.map((r) => [`${r.user_id}|${r.week_start}`, r.status]));
  let done = 0;
  const compliance = users.map((u) => {
    const cells = weeks.map((w) => tsMap.get(`${u.id}|${w}`) || 'sin registrar');
    const n = cells.filter((s) => s === 'enviado' || s === 'aprobado').length;
    done += n;
    return { userId: u.id, name: u.name, weeks: cells, done: n, expected: weeks.length };
  });

  const projectTotal = sum('projectHours');
  const availabilityTotal = sum('availability');
  return {
    range: { from, to, weekdays, holidays, includeDrafts },
    target: TARGET_EFFICIENCY,
    kpis: {
      hours: round(total),
      projectHours: round(projectTotal),
      adminHours: round(sum('adminHours')),
      capacity: round(sum('capacity')),
      availability: round(availabilityTotal),
      unregistered: round(sum('unregistered')),
      efficiency: ratio(projectTotal, availabilityTotal),
      compliance: users.length * weeks.length ? round(done / (users.length * weeks.length), 4) : null,
      consultants: users.length,
    },
    people,
    weekly: [...perWeek.entries()].map(([week, b]) => ({ week, project: round(b.project), deduct: round(b.deduct), admin: round(b.admin) })),
    adminTasks: [...perAdminTask.values()].map((t) => ({ ...t, hours: round(t.hours) })).sort((a, b) => b.hours - a.hours),
    modules: [...perModule.values()].map((m) => ({ ...m, hours: round(m.hours) })).sort((a, b) => b.hours - a.hours),
    projects,
    compliance: { weeks, rows: compliance },
  };
}

export function entriesToCsv(rows) {
  const header = ['fecha', 'semana', 'estatus', 'consultor', 'correo', 'area', 'tipo', 'codigo_proyecto', 'proyecto', 'cliente', 'modulo', 'tarea', 'descuenta_disponibilidad', 'horas', 'nota'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [r.date, r.week, r.status, r.userName, r.userEmail, r.area, r.isAdmin ? 'administrativa' : 'proyecto', r.projectCode, r.projectName,
      r.client, r.moduleCode, r.taskName, r.reduces ? 'si' : 'no', r.hours, r.note].map(esc).join(','));
  return `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`;
}
