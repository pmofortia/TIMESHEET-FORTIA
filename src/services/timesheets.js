import { tx } from '../db.js';
import { addDays, isIsoDate, weekDays, weekStart } from '../dates.js';

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const EDITABLE = new Set(['borrador', 'rechazado']);

const TASK_COLUMNS = `
  t.id AS taskId, t.name AS taskName, t.parent_path AS parentPath, t.wbs, t.start_date AS start, t.finish_date AS finish,
  p.id AS projectId, p.code AS projectCode, p.name AS projectName, p.client,
  COALESCE(t.category, p.category) AS category`;

function getTimesheet(db, userId, week) {
  return db.prepare('SELECT * FROM timesheets WHERE user_id = ? AND week_start = ?').get(userId, week);
}

// Tareas en las que el usuario puede registrar horas: las que tiene asignadas
// en Project y las actividades abiertas a todos (internas, capacitación...).
function allowedTasks(db, userId) {
  return db.prepare(`
    SELECT ${TASK_COLUMNS}, a.planned_hours AS plannedHours, 1 AS assigned
    FROM assignments a JOIN tasks t ON t.id = a.task_id JOIN projects p ON p.id = t.project_id
    WHERE a.user_id = ? AND t.active = 1 AND t.is_summary = 0 AND p.status = 'activo'
    UNION ALL
    SELECT ${TASK_COLUMNS}, NULL AS plannedHours, 0 AS assigned
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.open_to_all = 1 AND t.active = 1 AND t.is_summary = 0 AND p.status = 'activo'
      AND t.id NOT IN (SELECT task_id FROM assignments WHERE user_id = ?)
    ORDER BY projectName, wbs, taskName`).all(userId, userId);
}

export function normalizeWeek(value) {
  if (!isIsoDate(value)) throw new ValidationError('Fecha inválida, usa AAAA-MM-DD');
  return weekStart(value);
}

export function loadWeek(db, userId, week) {
  const days = weekDays(week);
  const end = days[6];
  const ts = getTimesheet(db, userId, week);
  const entries = ts ? db.prepare('SELECT task_id, work_date, hours, note FROM time_entries WHERE timesheet_id = ?').all(ts.id) : [];
  const allowed = allowedTasks(db, userId);

  const rows = new Map();
  const toRow = (t) => ({ ...t, hours: {}, note: '' });
  // Tareas asignadas cuyo periodo planeado toca esta semana.
  for (const t of allowed) {
    if (!t.assigned) continue;
    const overlaps = (!t.start || t.start <= end) && (!t.finish || t.finish >= week);
    if (overlaps) rows.set(t.taskId, toRow(t));
  }
  // Tareas con horas ya capturadas (aunque ya no estén asignadas o activas).
  const missing = [...new Set(entries.map((e) => e.task_id))].filter((id) => !rows.has(id));
  for (const id of missing) {
    const known = allowed.find((t) => t.taskId === id);
    const t = known || db.prepare(`SELECT ${TASK_COLUMNS}, NULL AS plannedHours, 0 AS assigned
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(id);
    if (t) rows.set(id, toRow(t));
  }
  for (const e of entries) {
    const row = rows.get(e.task_id);
    row.hours[e.work_date] = e.hours;
    if (e.note && !row.note) row.note = e.note;
  }

  const logged = db.prepare(`SELECT e.task_id, SUM(e.hours) AS h FROM time_entries e
    JOIN timesheets ts ON ts.id = e.timesheet_id WHERE ts.user_id = ? GROUP BY e.task_id`).all(userId);
  const loggedMap = new Map(logged.map((r) => [r.task_id, r.h]));
  const withTotals = (t) => ({ ...t, loggedToDate: loggedMap.get(t.taskId) || 0 });

  const capacity = db.prepare('SELECT weekly_capacity FROM users WHERE id = ?').get(userId)?.weekly_capacity ?? 40;
  return {
    week,
    days,
    prevWeek: addDays(week, -7),
    nextWeek: addDays(week, 7),
    capacity,
    timesheet: ts
      ? { id: ts.id, status: ts.status, submittedAt: ts.submitted_at, reviewedAt: ts.reviewed_at, reviewComment: ts.review_comment }
      : { id: null, status: 'borrador' },
    rows: [...rows.values()].map(withTotals),
    available: allowed.filter((t) => !rows.has(t.taskId)).map(withTotals),
  };
}

export function saveWeek(db, userId, week, rows) {
  if (!Array.isArray(rows)) throw new ValidationError('Formato inválido: se esperaba una lista de renglones');
  const days = new Set(weekDays(week));
  return tx(db, () => {
    let ts = getTimesheet(db, userId, week);
    if (ts && !EDITABLE.has(ts.status)) throw new ValidationError(`El timesheet está ${ts.status} y ya no se puede editar`, 409);
    if (!ts) {
      db.prepare('INSERT INTO timesheets (user_id, week_start) VALUES (?, ?)').run(userId, week);
      ts = getTimesheet(db, userId, week);
    }

    const allowedIds = new Set(allowedTasks(db, userId).map((t) => t.taskId));
    const previousIds = new Set(
      db.prepare('SELECT DISTINCT task_id FROM time_entries WHERE timesheet_id = ?').all(ts.id).map((r) => r.task_id),
    );
    const perDay = {};
    const clean = [];
    const seen = new Set();
    for (const row of rows) {
      const taskId = Number(row.taskId);
      if (seen.has(taskId)) throw new ValidationError('Hay una tarea repetida en el timesheet');
      seen.add(taskId);
      if (!allowedIds.has(taskId) && !previousIds.has(taskId)) {
        throw new ValidationError(`No tienes asignada la tarea ${taskId}; pide a tu líder que te asigne en Project`, 403);
      }
      const note = row.note ? String(row.note).slice(0, 500) : null;
      for (const [date, raw] of Object.entries(row.hours || {})) {
        if (raw === '' || raw == null) continue;
        if (!days.has(date)) throw new ValidationError(`La fecha ${date} no pertenece a la semana ${week}`);
        const hours = Number(raw);
        if (!Number.isFinite(hours) || hours < 0 || hours > 24) throw new ValidationError(`Horas inválidas el ${date}: ${raw}`);
        const rounded = Math.round(hours * 4) / 4; // cuartos de hora
        if (rounded === 0) continue;
        perDay[date] = (perDay[date] || 0) + rounded;
        if (perDay[date] > 24) throw new ValidationError(`El ${date} suma más de 24 horas`);
        clean.push([ts.id, taskId, date, rounded, note]);
      }
    }
    db.prepare('DELETE FROM time_entries WHERE timesheet_id = ?').run(ts.id);
    const ins = db.prepare('INSERT INTO time_entries (timesheet_id, task_id, work_date, hours, note) VALUES (?, ?, ?, ?, ?)');
    for (const args of clean) ins.run(...args);
    return { id: ts.id, entries: clean.length };
  });
}

export function submitWeek(db, userId, week) {
  const ts = getTimesheet(db, userId, week);
  if (!ts) throw new ValidationError('No hay horas capturadas en esta semana');
  if (!EDITABLE.has(ts.status)) throw new ValidationError(`El timesheet ya está ${ts.status}`, 409);
  const total = db.prepare('SELECT COALESCE(SUM(hours), 0) AS h FROM time_entries WHERE timesheet_id = ?').get(ts.id).h;
  if (total <= 0) throw new ValidationError('No puedes enviar un timesheet sin horas');
  db.prepare(`UPDATE timesheets SET status = 'enviado', submitted_at = datetime('now'), reviewed_by = NULL,
    reviewed_at = NULL WHERE id = ?`).run(ts.id);
  return { status: 'enviado', total };
}

export function reviewTimesheet(db, reviewerId, id, action, comment) {
  const ts = db.prepare('SELECT * FROM timesheets WHERE id = ?').get(id);
  if (!ts) throw new ValidationError('Timesheet no encontrado', 404);
  const transitions = {
    aprobar: { from: ['enviado'], to: 'aprobado' },
    rechazar: { from: ['enviado', 'aprobado'], to: 'rechazado' },
    reabrir: { from: ['enviado', 'aprobado', 'rechazado'], to: 'borrador' },
  };
  const t = transitions[action];
  if (!t) throw new ValidationError('Acción inválida');
  if (!t.from.includes(ts.status)) throw new ValidationError(`No se puede ${action} un timesheet ${ts.status}`, 409);
  if (action === 'rechazar' && !String(comment || '').trim()) throw new ValidationError('Indica el motivo del rechazo');
  db.prepare(`UPDATE timesheets SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_comment = ? WHERE id = ?`)
    .run(t.to, reviewerId, comment ? String(comment).slice(0, 1000) : null, id);
  return { status: t.to };
}
