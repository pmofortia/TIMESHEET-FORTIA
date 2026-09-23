// Aplica a la base de datos un plan de proyecto ya parseado (desde MSPDI o CSV).
// Es idempotente: reimportar el mismo archivo actualiza tareas y asignaciones
// sin duplicar, y las tareas que ya no vienen en el archivo se desactivan
// (no se borran, para conservar las horas ya registradas contra ellas).
import { CATEGORY_KEYS } from '../db.js';

export const normalizeName = (s) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

export function codeFromName(name) {
  return normalizeName(name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'PROY';
}

function uniqueCode(db, base) {
  let code = base;
  for (let i = 2; db.prepare('SELECT 1 FROM projects WHERE code = ?').get(code); i++) code = `${base}-${i}`;
  return code;
}

function buildUserMatcher(db) {
  const users = db.prepare('SELECT id, name, email FROM users WHERE active = 1').all();
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
  const byName = new Map(users.map((u) => [normalizeName(u.name), u]));
  return ({ email, name }) => (email && byEmail.get(email.toLowerCase())) || (name && byName.get(normalizeName(name))) || null;
}

/**
 * @param plan { name, code?, client?, category?, tasks:[{uid,name,wbs,outlineLevel,parentPath,start,finish,work,isSummary}],
 *               resources:[{uid,name,email}], assignments:[{taskUid,resourceUid,work}] }
 * @param opts { projectId?, source, dryRun? }
 */
export function applyPlan(db, plan, opts) {
  const summary = {
    project: null,
    created: false,
    tasksCreated: 0,
    tasksUpdated: 0,
    tasksDeactivated: 0,
    assignments: 0,
    matchedResources: [],
    unmatchedResources: [],
    warnings: [],
  };

  let project;
  if (opts.projectId) {
    project = db.prepare('SELECT * FROM projects WHERE id = ?').get(opts.projectId);
    if (!project) throw new Error('El proyecto destino no existe');
  } else {
    project =
      (plan.code && db.prepare('SELECT * FROM projects WHERE code = ?').get(plan.code)) ||
      db.prepare('SELECT * FROM projects WHERE lower(name) = lower(?)').get(plan.name);
  }
  const category = CATEGORY_KEYS.includes(plan.category) ? plan.category : 'facturable';
  if (!project) {
    const code = uniqueCode(db, plan.code || codeFromName(plan.name));
    const r = db
      .prepare('INSERT INTO projects (code, name, client, category, source, last_import_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))')
      .run(code, plan.name, plan.client || null, category, opts.source);
    project = db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid);
    summary.created = true;
  } else {
    db.prepare(`UPDATE projects SET source = ?, last_import_at = datetime('now'), client = COALESCE(client, ?) WHERE id = ?`)
      .run(opts.source, plan.client || null, project.id);
  }
  summary.project = { id: project.id, code: project.code, name: project.name };

  const existing = new Map(
    db.prepare('SELECT id, external_uid FROM tasks WHERE project_id = ?').all(project.id).map((t) => [t.external_uid, t.id]),
  );
  const insertTask = db.prepare(`INSERT INTO tasks
    (project_id, external_uid, name, wbs, outline_level, parent_path, start_date, finish_date, planned_hours, is_summary, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const updateTask = db.prepare(`UPDATE tasks SET name = ?, wbs = ?, outline_level = ?, parent_path = ?, start_date = ?,
    finish_date = ?, planned_hours = ?, is_summary = ?, active = 1 WHERE id = ?`);

  const taskIds = new Map();
  for (const t of plan.tasks) {
    const args = [t.name, t.wbs ?? null, t.outlineLevel ?? 1, t.parentPath ?? null, t.start ?? null, t.finish ?? null, t.work ?? 0, t.isSummary ? 1 : 0];
    if (t.start && t.finish && t.start > t.finish) summary.warnings.push(`La tarea "${t.name}" termina antes de iniciar`);
    if (existing.has(t.uid)) {
      updateTask.run(...args, existing.get(t.uid));
      taskIds.set(t.uid, existing.get(t.uid));
      summary.tasksUpdated++;
    } else {
      const r = insertTask.run(project.id, t.uid, ...args);
      taskIds.set(t.uid, Number(r.lastInsertRowid));
      summary.tasksCreated++;
    }
  }
  const deactivate = db.prepare('UPDATE tasks SET active = 0 WHERE id = ? AND active = 1');
  for (const [uid, id] of existing) {
    if (!taskIds.has(uid) && deactivate.run(id).changes) summary.tasksDeactivated++;
  }

  const matchUser = buildUserMatcher(db);
  const resourceUser = new Map();
  for (const r of plan.resources) {
    const u = matchUser(r);
    if (u) {
      resourceUser.set(r.uid, u.id);
      summary.matchedResources.push({ resource: r.name, user: u.name });
    } else {
      summary.unmatchedResources.push({ resource: r.name, email: r.email });
    }
  }

  const clearAssign = db.prepare('DELETE FROM assignments WHERE task_id = ?');
  for (const id of taskIds.values()) clearAssign.run(id);
  const upsertAssign = db.prepare(`INSERT INTO assignments (task_id, user_id, planned_hours) VALUES (?, ?, ?)
    ON CONFLICT (task_id, user_id) DO UPDATE SET planned_hours = planned_hours + excluded.planned_hours`);
  for (const a of plan.assignments) {
    const taskId = taskIds.get(a.taskUid);
    const userId = resourceUser.get(a.resourceUid);
    if (!taskId || !userId) continue;
    upsertAssign.run(taskId, userId, a.work ?? 0);
    summary.assignments++;
  }
  return summary;
}

// Convierte las filas del CSV en uno o varios planes (uno por proyecto).
export function plansFromCsv(items) {
  const plans = new Map();
  for (const it of items) {
    const key = it.projectCode || normalizeName(it.project);
    if (!plans.has(key)) {
      plans.set(key, {
        name: it.project, code: it.projectCode, client: it.client, category: it.category,
        tasks: new Map(), resources: new Map(), assignments: [],
      });
    }
    const plan = plans.get(key);
    const uid = `csv:${normalizeName(it.task)}`;
    const task = plan.tasks.get(uid) || { uid, name: it.task, start: it.start, finish: it.finish, work: 0, isSummary: false };
    task.work += it.hours;
    if (it.start && (!task.start || it.start < task.start)) task.start = it.start;
    if (it.finish && (!task.finish || it.finish > task.finish)) task.finish = it.finish;
    plan.tasks.set(uid, task);
    if (it.email || it.resource) {
      const rid = (it.email || normalizeName(it.resource)).toLowerCase();
      plan.resources.set(rid, { uid: rid, name: it.resource || it.email, email: it.email });
      plan.assignments.push({ taskUid: uid, resourceUid: rid, work: it.hours });
    }
  }
  return [...plans.values()].map((p) => ({ ...p, tasks: [...p.tasks.values()], resources: [...p.resources.values()] }));
}
