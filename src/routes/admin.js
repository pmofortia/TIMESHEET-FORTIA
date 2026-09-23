// Administración: tareas administrativas, días festivos, clientes, módulos y ajustes generales.
import { requireRole } from '../auth.js';
import { setSetting, tx, weeklyHoursSetting } from '../db.js';
import { isIsoDate } from '../dates.js';
import { ValidationError, isUniqueError, optionalNumber, optionalText, requiredText, wrap } from '../http.js';

export function registerAdminRoutes(app, db) {
  const admin = requireRole('admin');
  const internalId = () => db.prepare('SELECT id FROM projects WHERE is_internal = 1').get().id;

  // ---------- Tareas administrativas (no ligadas a un proyecto) ----------
  app.get('/api/admin/tasks', wrap(() => ({
    items: db.prepare(`SELECT t.id, t.name, t.reduces_availability AS reducesAvailability, t.active,
        (SELECT COALESCE(SUM(hours), 0) FROM time_entries e WHERE e.task_id = t.id) AS hours
      FROM tasks t WHERE t.project_id = ? ORDER BY t.active DESC, t.name`).all(internalId())
      .map((t) => ({ ...t, reducesAvailability: !!t.reducesAvailability, active: !!t.active })),
  })));

  app.post('/api/admin/tasks', admin, wrap((req, res) => {
    const name = requiredText(req.body?.name, 'El nombre');
    const r = db.prepare('INSERT INTO tasks (project_id, external_uid, name, reduces_availability) VALUES (?, ?, ?, ?)')
      .run(internalId(), `admin:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, name, req.body?.reducesAvailability ? 1 : 0);
    res.status(201);
    return { id: Number(r.lastInsertRowid) };
  }));

  app.put('/api/admin/tasks/:id', admin, wrap((req) => {
    const name = requiredText(req.body?.name, 'El nombre');
    const r = db.prepare('UPDATE tasks SET name = ?, reduces_availability = ?, active = ? WHERE id = ? AND project_id = ?')
      .run(name, req.body?.reducesAvailability ? 1 : 0, req.body?.active === false ? 0 : 1, Number(req.params.id), internalId());
    if (!r.changes) throw new ValidationError('Tarea no encontrada', 404);
    return { ok: true };
  }));

  // Si ya tiene horas registradas no se borra (se perdería historia): se desactiva.
  app.delete('/api/admin/tasks/:id', admin, wrap((req) => {
    const id = Number(req.params.id);
    const task = db.prepare('SELECT id FROM tasks WHERE id = ? AND project_id = ?').get(id, internalId());
    if (!task) throw new ValidationError('Tarea no encontrada', 404);
    if (db.prepare('SELECT 1 FROM time_entries WHERE task_id = ? LIMIT 1').get(id)) {
      db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(id);
      return { deleted: false, deactivated: true };
    }
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return { deleted: true };
  }));

  // ---------- Días festivos ----------
  app.get('/api/admin/holidays', wrap((req) => {
    const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : null;
    const items = year
      ? db.prepare("SELECT date, name FROM holidays WHERE substr(date, 1, 4) = ? ORDER BY date").all(year)
      : db.prepare('SELECT date, name FROM holidays ORDER BY date').all();
    return { items };
  }));

  app.post('/api/admin/holidays', admin, wrap((req, res) => {
    const { date } = req.body || {};
    if (!isIsoDate(date)) throw new ValidationError('Fecha inválida');
    const name = requiredText(req.body?.name, 'El nombre');
    db.prepare('INSERT INTO holidays (date, name) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET name = excluded.name').run(date, name);
    res.status(201);
    return { ok: true };
  }));

  app.delete('/api/admin/holidays/:date', admin, wrap((req) => {
    const r = db.prepare('DELETE FROM holidays WHERE date = ?').run(req.params.date);
    if (!r.changes) throw new ValidationError('Festivo no encontrado', 404);
    return { ok: true };
  }));

  // ---------- Clientes ----------
  app.get('/api/admin/clients', wrap(() => ({
    items: db.prepare(`SELECT c.id, c.name, c.sales_exec AS salesExec, c.active,
        (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id) AS projects
      FROM clients c ORDER BY c.active DESC, c.name`).all().map((c) => ({ ...c, active: !!c.active })),
  })));

  const clientInput = (b) => [requiredText(b?.name, 'El nombre del cliente'), optionalText(b?.salesExec), b?.active === false ? 0 : 1];

  app.post('/api/admin/clients', admin, wrap((req, res) => {
    try {
      const r = db.prepare('INSERT INTO clients (name, sales_exec, active) VALUES (?, ?, ?)').run(...clientInput(req.body));
      res.status(201);
      return { id: Number(r.lastInsertRowid) };
    } catch (err) {
      if (isUniqueError(err)) throw new ValidationError('Ya existe un cliente con ese nombre', 409);
      throw err;
    }
  }));

  app.put('/api/admin/clients/:id', admin, wrap((req) => {
    try {
      const r = db.prepare('UPDATE clients SET name = ?, sales_exec = ?, active = ? WHERE id = ?').run(...clientInput(req.body), Number(req.params.id));
      if (!r.changes) throw new ValidationError('Cliente no encontrado', 404);
      return { ok: true };
    } catch (err) {
      if (isUniqueError(err)) throw new ValidationError('Ya existe un cliente con ese nombre', 409);
      throw err;
    }
  }));

  app.delete('/api/admin/clients/:id', admin, wrap((req) => {
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM projects WHERE client_id = ? LIMIT 1').get(id)) {
      throw new ValidationError('El cliente tiene proyectos; desactívalo en lugar de eliminarlo', 409);
    }
    const r = db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    if (!r.changes) throw new ValidationError('Cliente no encontrado', 404);
    return { ok: true };
  }));

  // ---------- Módulos ----------
  app.get('/api/admin/modules', wrap(() => ({
    items: db.prepare(`SELECT m.id, m.code, m.name, m.active,
        (SELECT COUNT(*) FROM project_modules pm WHERE pm.module_id = m.id) AS projects
      FROM modules m ORDER BY m.active DESC, m.code`).all().map((m) => ({ ...m, active: !!m.active })),
  })));

  const moduleInput = (b) => [requiredText(b?.code, 'La clave', 20), requiredText(b?.name, 'El nombre'), b?.active === false ? 0 : 1];

  app.post('/api/admin/modules', admin, wrap((req, res) => {
    try {
      const r = db.prepare('INSERT INTO modules (code, name, active) VALUES (?, ?, ?)').run(...moduleInput(req.body));
      res.status(201);
      return { id: Number(r.lastInsertRowid) };
    } catch (err) {
      if (isUniqueError(err)) throw new ValidationError('Ya existe un módulo con esa clave', 409);
      throw err;
    }
  }));

  app.put('/api/admin/modules/:id', admin, wrap((req) => {
    try {
      const r = db.prepare('UPDATE modules SET code = ?, name = ?, active = ? WHERE id = ?').run(...moduleInput(req.body), Number(req.params.id));
      if (!r.changes) throw new ValidationError('Módulo no encontrado', 404);
      return { ok: true };
    } catch (err) {
      if (isUniqueError(err)) throw new ValidationError('Ya existe un módulo con esa clave', 409);
      throw err;
    }
  }));

  app.delete('/api/admin/modules/:id', admin, wrap((req) => {
    const id = Number(req.params.id);
    const used = db.prepare('SELECT 1 FROM project_modules WHERE module_id = ? UNION SELECT 1 FROM tasks WHERE module_id = ? LIMIT 1').get(id, id);
    if (used) throw new ValidationError('El módulo está asignado a proyectos o tareas; desactívalo en lugar de eliminarlo', 409);
    const r = db.prepare('DELETE FROM modules WHERE id = ?').run(id);
    if (!r.changes) throw new ValidationError('Módulo no encontrado', 404);
    return { ok: true };
  }));

  // ---------- Ajustes ----------
  app.get('/api/admin/settings', admin, wrap(() => ({ weeklyHours: weeklyHoursSetting(db) })));

  app.put('/api/admin/settings', admin, wrap((req) => {
    const weeklyHours = optionalNumber(req.body?.weeklyHours, 'Horas semanales', { min: 1, max: 80 });
    if (weeklyHours == null) throw new ValidationError('Indica las horas semanales');
    return tx(db, () => {
      setSetting(db, 'weekly_hours', weeklyHours);
      const updated = req.body?.applyToAll ? Number(db.prepare('UPDATE users SET weekly_capacity = ?').run(weeklyHours).changes) : 0;
      return { weeklyHours, updated };
    });
  }));
}
