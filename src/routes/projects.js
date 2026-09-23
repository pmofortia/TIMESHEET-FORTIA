// Proyectos: ficha, módulos, acceso de usuarios, recursos del plan y tareas.
import { requireRole } from '../auth.js';
import { PROJECT_STAGES, PROJECT_STATUSES, tx } from '../db.js';
import { isIsoDate } from '../dates.js';
import { ValidationError, isUniqueError, optionalNumber, optionalText, requiredText, wrap } from '../http.js';
import { accessibleProjectIds, canManageProject, canSeeProject } from '../services/access.js';
import { rebuildAssignments } from '../services/plans.js';

const PROJECT_SELECT = `
  SELECT p.id, p.code, p.name, p.client_id AS clientId, c.name AS clientName, p.sales_exec AS salesExec,
         p.pm_id AS pmId, pm.name AS pmName, p.status, p.stage, p.sold_hours AS soldHours, p.budget_usd AS budgetUsd,
         p.source, p.last_import_at AS lastImportAt,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.active = 1 AND t.is_summary = 0) AS tasks,
         (SELECT COALESCE(SUM(planned_hours), 0) FROM tasks t WHERE t.project_id = p.id AND t.active = 1 AND t.is_summary = 0) AS planned,
         (SELECT COALESCE(SUM(e.hours), 0) FROM time_entries e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = p.id) AS actual,
         (SELECT GROUP_CONCAT(m.code, ', ') FROM project_modules x JOIN modules m ON m.id = x.module_id WHERE x.project_id = p.id) AS moduleCodes
  FROM projects p LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN users pm ON pm.id = p.pm_id`;

export function registerProjectRoutes(app, db) {
  const manager = requireRole('admin', 'lider');

  const mustSee = (req, id) => {
    const p = db.prepare('SELECT id, is_internal FROM projects WHERE id = ?').get(id);
    if (!p || p.is_internal || !canSeeProject(db, req.user, id)) throw new ValidationError('Proyecto no encontrado', 404);
  };
  const mustManage = (req, id) => {
    mustSee(req, id);
    if (!canManageProject(db, req.user, id)) throw new ValidationError('Solo el gestor del proyecto o un administrador pueden modificarlo', 403);
  };

  // Catálogos que usan los formularios de proyecto.
  app.get('/api/catalogs', wrap(() => ({
    clients: db.prepare('SELECT id, name, sales_exec AS salesExec FROM clients WHERE active = 1 ORDER BY name').all(),
    modules: db.prepare('SELECT id, code, name FROM modules WHERE active = 1 ORDER BY code').all(),
    managers: db.prepare("SELECT id, name FROM users WHERE role = 'lider' AND active = 1 ORDER BY name").all(),
    users: db.prepare('SELECT id, name, email, role FROM users WHERE active = 1 ORDER BY name').all(),
    statuses: PROJECT_STATUSES,
    stages: PROJECT_STAGES,
  })));

  app.get('/api/projects', wrap((req) => {
    const ids = accessibleProjectIds(db, req.user);
    const where = ids === null ? 'WHERE p.is_internal = 0' : `WHERE p.is_internal = 0 AND p.id IN (${ids.map(() => '?').join(',') || 'NULL'})`;
    const items = db.prepare(`${PROJECT_SELECT} ${where} ORDER BY p.name`).all(...(ids || []))
      .map((p) => ({ ...p, canManage: canManageProject(db, req.user, p.id) }));
    return { items };
  }));

  app.get('/api/projects/:id', wrap((req) => {
    const id = Number(req.params.id);
    mustSee(req, id);
    const project = db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(id);
    return {
      project: { ...project, canManage: canManageProject(db, req.user, id) },
      modules: db.prepare('SELECT m.id, m.code, m.name FROM project_modules x JOIN modules m ON m.id = x.module_id WHERE x.project_id = ? ORDER BY m.code').all(id),
      members: db.prepare(`SELECT u.id, u.name, u.email, u.role FROM project_members x JOIN users u ON u.id = x.user_id
        WHERE x.project_id = ? ORDER BY u.name`).all(id),
      resources: db.prepare(`SELECT r.id, r.uid, r.name, r.email, r.user_id AS userId, u.name AS userName,
          (SELECT COUNT(*) FROM plan_assignments pa WHERE pa.resource_id = r.id) AS tasks,
          (SELECT COALESCE(SUM(planned_hours), 0) FROM plan_assignments pa WHERE pa.resource_id = r.id) AS planned
        FROM project_resources r LEFT JOIN users u ON u.id = r.user_id WHERE r.project_id = ? ORDER BY r.name`).all(id),
    };
  }));

  const projectInput = (b, current = {}) => {
    const name = requiredText(b.name, 'El nombre del proyecto');
    const code = requiredText(b.code ?? current.code, 'El código', 30);
    let clientId = null;
    if (b.clientId) {
      const c = db.prepare('SELECT id FROM clients WHERE id = ? AND active = 1').get(Number(b.clientId));
      // Se permite conservar un cliente que se desactivó después de asignarlo.
      if (!c && Number(b.clientId) !== current.client_id) throw new ValidationError('El cliente debe existir en el catálogo de Administración');
      clientId = Number(b.clientId);
    }
    let pmId = null;
    if (b.pmId) {
      const pm = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'lider' AND active = 1").get(Number(b.pmId));
      if (!pm) throw new ValidationError('El gestor debe ser un usuario activo con rol Gestor de proyecto');
      pmId = pm.id;
    }
    const status = b.status || current.status || 'Por asignar';
    if (!PROJECT_STATUSES.includes(status)) throw new ValidationError('Estatus inválido');
    const stage = b.stage || null;
    if (stage && !PROJECT_STAGES.includes(stage)) throw new ValidationError('Etapa inválida');
    const moduleIds = Array.isArray(b.moduleIds) ? [...new Set(b.moduleIds.map(Number))] : null;
    if (moduleIds) {
      const valid = new Set(db.prepare('SELECT id FROM modules').all().map((m) => m.id));
      if (moduleIds.some((m) => !valid.has(m))) throw new ValidationError('Módulo inválido');
    }
    return {
      code, name, clientId, pmId, status, stage, moduleIds,
      salesExec: optionalText(b.salesExec),
      soldHours: optionalNumber(b.soldHours, 'Horas vendidas'),
      budgetUsd: optionalNumber(b.budgetUsd, 'Presupuesto USD'),
    };
  };

  const saveModules = (projectId, moduleIds) => {
    if (!moduleIds) return;
    db.prepare('DELETE FROM project_modules WHERE project_id = ?').run(projectId);
    const ins = db.prepare('INSERT INTO project_modules (project_id, module_id) VALUES (?, ?)');
    for (const m of moduleIds) ins.run(projectId, m);
    // Una tarea no puede quedar con un módulo que ya no tiene el proyecto.
    db.prepare(`UPDATE tasks SET module_id = NULL WHERE project_id = ? AND module_id IS NOT NULL
      AND module_id NOT IN (SELECT module_id FROM project_modules WHERE project_id = ?)`).run(projectId, projectId);
  };

  app.post('/api/projects', manager, wrap((req, res) => {
    const p = projectInput(req.body || {});
    // Si lo crea un gestor y no indica otro, queda como gestor del proyecto (así puede administrarlo).
    if (!p.pmId && req.user.role === 'lider') p.pmId = req.user.id;
    if (!p.salesExec && p.clientId) p.salesExec = db.prepare('SELECT sales_exec FROM clients WHERE id = ?').get(p.clientId)?.sales_exec ?? null;
    try {
      return tx(db, () => {
        const r = db.prepare(`INSERT INTO projects (code, name, client_id, sales_exec, pm_id, status, stage, sold_hours, budget_usd)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.code, p.name, p.clientId, p.salesExec, p.pmId, p.status, p.stage, p.soldHours, p.budgetUsd);
        const id = Number(r.lastInsertRowid);
        saveModules(id, p.moduleIds);
        res.status(201);
        return { id };
      });
    } catch (err) {
      if (isUniqueError(err)) throw new ValidationError('Ya existe un proyecto con ese código', 409);
      throw err;
    }
  }));

  app.put('/api/projects/:id', wrap((req) => {
    const id = Number(req.params.id);
    mustManage(req, id);
    const current = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    const p = projectInput(req.body || {}, current);
    // Un gestor no puede quitarse el proyecto a sí mismo (lo perdería); eso lo hace un administrador.
    if (req.user.role === 'lider' && p.pmId !== req.user.id) throw new ValidationError('Solo un administrador puede cambiar al gestor del proyecto', 403);
    try {
      tx(db, () => {
        db.prepare(`UPDATE projects SET code = ?, name = ?, client_id = ?, sales_exec = ?, pm_id = ?, status = ?, stage = ?,
          sold_hours = ?, budget_usd = ? WHERE id = ?`)
          .run(p.code, p.name, p.clientId, p.salesExec, p.pmId, p.status, p.stage, p.soldHours, p.budgetUsd, id);
        saveModules(id, p.moduleIds);
      });
    } catch (err) {
      if (isUniqueError(err)) throw new ValidationError('Ya existe un proyecto con ese código', 409);
      throw err;
    }
    return { ok: true };
  }));

  // Usuarios con acceso al proyecto (lo ven y pueden registrar horas en sus tareas).
  app.put('/api/projects/:id/members', wrap((req) => {
    const id = Number(req.params.id);
    mustManage(req, id);
    const userIds = Array.isArray(req.body?.userIds) ? [...new Set(req.body.userIds.map(Number))] : null;
    if (!userIds) throw new ValidationError('Se esperaba la lista de usuarios');
    return tx(db, () => {
      db.prepare('DELETE FROM project_members WHERE project_id = ?').run(id);
      const ins = db.prepare('INSERT INTO project_members (project_id, user_id) SELECT ?, id FROM users WHERE id = ? AND active = 1');
      for (const u of userIds) ins.run(id, u);
      return { members: db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?').get(id).n };
    });
  }));

  // Reemplaza qué usuario cubre un recurso importado de Project.
  app.put('/api/projects/:id/resources/:rid', wrap((req) => {
    const id = Number(req.params.id);
    mustManage(req, id);
    const resource = db.prepare('SELECT id FROM project_resources WHERE id = ? AND project_id = ?').get(Number(req.params.rid), id);
    if (!resource) throw new ValidationError('Recurso no encontrado', 404);
    const userId = req.body?.userId ? Number(req.body.userId) : null;
    if (userId && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(userId)) throw new ValidationError('El usuario no está activo');
    return tx(db, () => {
      db.prepare('UPDATE project_resources SET user_id = ? WHERE id = ?').run(userId, resource.id);
      return { assignments: rebuildAssignments(db, id) };
    });
  }));

  app.get('/api/projects/:id/tasks', wrap((req) => {
    const id = Number(req.params.id);
    mustSee(req, id);
    const items = db.prepare(`
      SELECT t.id, t.external_uid AS uid, t.name, t.wbs, t.outline_level AS level, t.parent_path AS parentPath,
             t.start_date AS start, t.finish_date AS finish, t.planned_hours AS planned, t.is_summary AS isSummary,
             t.module_id AS moduleId, m.code AS moduleCode, t.active, (t.external_uid LIKE 'manual:%') AS manual,
             (SELECT COALESCE(SUM(e.hours), 0) FROM time_entries e WHERE e.task_id = t.id) AS actual,
             (SELECT GROUP_CONCAT(u.name, ', ') FROM assignments a JOIN users u ON u.id = a.user_id WHERE a.task_id = t.id) AS resources
      FROM tasks t LEFT JOIN modules m ON m.id = t.module_id
      WHERE t.project_id = ? ORDER BY t.active DESC, t.id`).all(id);
    return { items };
  }));

  const checkTaskModule = (projectId, moduleId) => {
    if (!moduleId) return null;
    const ok = db.prepare('SELECT 1 FROM project_modules WHERE project_id = ? AND module_id = ?').get(projectId, Number(moduleId));
    if (!ok) throw new ValidationError('El módulo debe ser uno de los módulos asignados al proyecto');
    return Number(moduleId);
  };

  // Alta manual de tareas (para proyectos que no vienen de Project o ajustes puntuales).
  app.post('/api/projects/:id/tasks', wrap((req, res) => {
    const projectId = Number(req.params.id);
    mustManage(req, projectId);
    const b = req.body || {};
    const name = requiredText(b.name, 'El nombre de la tarea');
    for (const d of [b.start, b.finish]) if (d && !isIsoDate(d)) throw new ValidationError('Fechas inválidas');
    const moduleId = checkTaskModule(projectId, b.moduleId);
    const planned = optionalNumber(b.planned, 'Horas planeadas') || 0;
    const assignees = Array.isArray(b.userIds) ? b.userIds.map(Number) : [];
    return tx(db, () => {
      const r = db.prepare(`INSERT INTO tasks (project_id, external_uid, name, start_date, finish_date, planned_hours, module_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(projectId, `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        name, b.start || null, b.finish || null, planned, moduleId);
      const taskId = Number(r.lastInsertRowid);
      const per = assignees.length ? planned / assignees.length : 0;
      const ins = db.prepare('INSERT OR IGNORE INTO assignments (task_id, user_id, planned_hours) SELECT ?, id, ? FROM users WHERE id = ? AND active = 1');
      const member = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) SELECT ?, id FROM users WHERE id = ? AND active = 1');
      for (const uid of assignees) { ins.run(taskId, per, uid); member.run(projectId, uid); }
      res.status(201);
      return { id: taskId };
    });
  }));

  // Cambia el módulo de una tarea (y, si es manual, sus datos).
  app.put('/api/tasks/:id', wrap((req) => {
    const task = db.prepare('SELECT t.*, p.is_internal FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(Number(req.params.id));
    if (!task || task.is_internal) throw new ValidationError('Tarea no encontrada', 404);
    mustManage(req, task.project_id);
    const b = req.body || {};
    const moduleId = checkTaskModule(task.project_id, b.moduleId);
    const manual = task.external_uid.startsWith('manual:') && b.name !== undefined;
    if (manual) for (const d of [b.start, b.finish]) if (d && !isIsoDate(d)) throw new ValidationError('Fechas inválidas');
    const fields = manual
      ? [requiredText(b.name, 'El nombre'), b.start || null, b.finish || null, optionalNumber(b.planned, 'Horas planeadas') || 0, b.active === false ? 0 : 1]
      : null;
    tx(db, () => {
      db.prepare('UPDATE tasks SET module_id = ? WHERE id = ?').run(moduleId, task.id);
      if (fields) db.prepare('UPDATE tasks SET name = ?, start_date = ?, finish_date = ?, planned_hours = ?, active = ? WHERE id = ?').run(...fields, task.id);
    });
    return { ok: true };
  }));
}
