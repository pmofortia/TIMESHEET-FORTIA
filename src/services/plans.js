// Aplica a la base de datos un plan de proyecto ya parseado (desde MSPDI o CSV).
// Es idempotente: reimportar el mismo archivo actualiza tareas y asignaciones
// sin duplicar, y las tareas que ya no vienen en el archivo se desactivan
// (no se borran, para conservar las horas ya registradas contra ellas).
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
 * @param plan { name, code?, client?, clientId?, tasks:[{uid,name,wbs,outlineLevel,parentPath,start,finish,work,isSummary}],
 *               resources:[{uid,name,email}], assignments:[{taskUid,resourceUid,work}] }
 * @param opts { projectId?, source }
 */
export function applyPlan(db, plan, opts) {
  const summary = {
    project: null,
    created: false,
    tasksCreated: 0,
    tasksUpdated: 0,
    tasksDeactivated: 0,
    assignments: 0,
    resources: [],
    warnings: [],
  };

  let project;
  if (opts.projectId) {
    project = db.prepare('SELECT * FROM projects WHERE id = ? AND is_internal = 0').get(opts.projectId);
    if (!project) throw new Error('El proyecto destino no existe');
  } else {
    project =
      (plan.code && db.prepare('SELECT * FROM projects WHERE code = ? AND is_internal = 0').get(plan.code)) ||
      db.prepare('SELECT * FROM projects WHERE lower(name) = lower(?) AND is_internal = 0').get(plan.name);
  }

  // El cliente solo puede salir del catálogo de Administración.
  let clientId = plan.clientId ? Number(plan.clientId) : null;
  if (clientId && !db.prepare('SELECT 1 FROM clients WHERE id = ?').get(clientId)) throw new Error('El cliente seleccionado no existe');
  if (!clientId && plan.client) {
    clientId = db.prepare('SELECT id FROM clients WHERE name = ?').get(plan.client)?.id ?? null;
    if (!clientId) summary.warnings.push(`El cliente "${plan.client}" no está en el catálogo; asígnalo en la ficha del proyecto`);
  }

  if (!project) {
    const code = uniqueCode(db, plan.code || codeFromName(plan.name));
    const salesExec = clientId ? db.prepare('SELECT sales_exec FROM clients WHERE id = ?').get(clientId).sales_exec : null;
    const r = db.prepare(`INSERT INTO projects (code, name, client_id, sales_exec, source, last_import_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(code, plan.name, clientId, salesExec, opts.source);
    project = db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid);
    summary.created = true;
  } else {
    db.prepare(`UPDATE projects SET source = ?, last_import_at = datetime('now'), client_id = COALESCE(client_id, ?) WHERE id = ?`)
      .run(opts.source, clientId, project.id);
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
  const deactivate = db.prepare("UPDATE tasks SET active = 0 WHERE id = ? AND active = 1 AND external_uid NOT LIKE 'manual:%'");
  for (const [uid, id] of existing) {
    if (!taskIds.has(uid) && deactivate.run(id).changes) summary.tasksDeactivated++;
  }

  // Los recursos de Project se guardan tal cual. Si ya estaban ligados a un usuario (automático o
  // reemplazado a mano) se respeta ese vínculo; si no, se intenta por correo y luego por nombre.
  const matchUser = buildUserMatcher(db);
  const upsertResource = db.prepare(`INSERT INTO project_resources (project_id, uid, name, email, user_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (project_id, uid) DO UPDATE SET name = excluded.name, email = excluded.email,
      user_id = COALESCE(project_resources.user_id, excluded.user_id)
    RETURNING id, user_id`);
  const resourceIds = new Map();
  for (const r of plan.resources) {
    const row = upsertResource.get(project.id, r.uid, r.name, r.email || null, matchUser(r)?.id ?? null);
    resourceIds.set(r.uid, row.id);
    const user = row.user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(row.user_id) : null;
    summary.resources.push({ resource: r.name, email: r.email || null, user: user?.name || null });
  }

  const clearPlan = db.prepare('DELETE FROM plan_assignments WHERE task_id = ?');
  for (const id of taskIds.values()) clearPlan.run(id);
  const insPlan = db.prepare(`INSERT INTO plan_assignments (task_id, resource_id, planned_hours) VALUES (?, ?, ?)
    ON CONFLICT (task_id, resource_id) DO UPDATE SET planned_hours = planned_hours + excluded.planned_hours`);
  for (const a of plan.assignments) {
    const taskId = taskIds.get(a.taskUid);
    const resourceId = resourceIds.get(a.resourceUid);
    if (taskId && resourceId) insPlan.run(taskId, resourceId, a.work ?? 0);
  }
  summary.assignments = rebuildAssignments(db, project.id);
  return summary;
}

// Recalcula las asignaciones efectivas (tarea-usuario) de las tareas que vienen del plan,
// a partir de los recursos y el usuario que cubre cada uno. Da acceso al proyecto a esos usuarios.
export function rebuildAssignments(db, projectId) {
  db.prepare(`DELETE FROM assignments WHERE task_id IN
    (SELECT id FROM tasks WHERE project_id = ? AND external_uid NOT LIKE 'manual:%')`).run(projectId);
  const r = db.prepare(`INSERT INTO assignments (task_id, user_id, planned_hours)
    SELECT pa.task_id, pr.user_id, SUM(pa.planned_hours)
    FROM plan_assignments pa JOIN project_resources pr ON pr.id = pa.resource_id JOIN tasks t ON t.id = pa.task_id
    WHERE t.project_id = ? AND pr.user_id IS NOT NULL
    GROUP BY pa.task_id, pr.user_id`).run(projectId);
  db.prepare(`INSERT OR IGNORE INTO project_members (project_id, user_id)
    SELECT project_id, user_id FROM project_resources WHERE project_id = ? AND user_id IS NOT NULL`).run(projectId);
  return Number(r.changes);
}

// Convierte las filas del CSV en uno o varios planes (uno por proyecto).
export function plansFromCsv(items) {
  const plans = new Map();
  for (const it of items) {
    const key = it.projectCode || normalizeName(it.project);
    if (!plans.has(key)) {
      plans.set(key, {
        name: it.project, code: it.projectCode, client: it.client,
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
