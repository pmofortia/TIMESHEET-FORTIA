import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ensureBaseData } from '../src/bootstrap.js';
import { hashPassword } from '../src/auth.js';

const PASS = 'Secreta123';
let server, base, db;
const ids = {};

async function login(email) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASS }),
  });
  assert.equal(res.status, 200, `login ${email}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(`${base}/api${path}`, {
      method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : method === 'GET' ? undefined : '{}',
    });
    const text = await r.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* CSV */ }
    return { status: r.status, data };
  };
}

before(async () => {
  db = openDb(':memory:');
  process.env.ADMIN_PASSWORD = PASS;
  ensureBaseData(db, { log: () => {} });
  const add = (name, email, role, managerId = null) =>
    Number(db.prepare('INSERT INTO users (name, email, password_hash, role, manager_id) VALUES (?, ?, ?, ?, ?)')
      .run(name, email, hashPassword(PASS), role, managerId).lastInsertRowid);
  ids.lider = add('Laura Martínez', 'laura@fortia.com.mx', 'lider');
  ids.ana = add('Ana López', 'ana.lopez@fortia.com.mx', 'consultor', ids.lider);
  ids.carlos = add('Carlos Ramírez', 'carlos.ramirez@fortia.com.mx', 'consultor', ids.lider);
  ids.otro = add('Otro Líder', 'otro@fortia.com.mx', 'lider');
  await new Promise((resolve) => { server = createApp(db).listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('rechaza peticiones sin sesión y credenciales incorrectas', async () => {
  assert.equal((await fetch(`${base}/api/me`)).status, 401);
  const bad = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"ana.lopez@fortia.com.mx","password":"x"}' });
  assert.equal(bad.status, 401);
});

test('flujo completo: importar plan, capturar semana, enviar, aprobar e indicadores', async () => {
  const lider = await login('laura@fortia.com.mx');
  const ana = await login('ana.lopez@fortia.com.mx');

  // Un consultor no puede importar.
  const xml = readFileSync('samples/proyecto-ejemplo.xml', 'utf8');
  assert.equal((await ana('POST', '/import/msproject', { xml })).status, 403);

  const admin = await login('admin@fortia.com.mx');
  const clientId = (await admin('POST', '/admin/clients', { name: 'Grupo Demo', salesExec: 'Roberto Sánchez' })).data.id;
  assert.equal((await lider('POST', '/admin/clients', { name: 'X' })).status, 403, 'solo el admin administra catálogos');
  assert.equal((await admin('POST', '/admin/holidays', { date: '2026-09-16', name: 'Independencia' })).status, 201);

  // Vista previa no escribe nada.
  const preview = await lider('POST', '/import/msproject', { xml, code: 'ERP-GID', dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.results[0].tasksCreated, 12);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE code = 'ERP-GID'").get().n, 0);

  const imp = await lider('POST', '/import/msproject', { xml, code: 'ERP-GID', clientId, filename: 'erp.xml' });
  assert.equal(imp.status, 200);
  const projectId = imp.data.results[0].project.id;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  assert.equal(project.client_id, clientId);
  assert.equal(project.pm_id, ids.lider, 'quien importa un proyecto nuevo queda como gestor');
  // El recurso sin usuario queda guardado para reemplazarlo después.
  const detail = (await lider('GET', `/projects/${projectId}`)).data;
  const externo = detail.resources.find((r) => r.name === 'Consultor Externo');
  assert.equal(externo.userId, null);

  // Otro gestor no puede reimportar sobre un proyecto ajeno.
  const otro = await login('otro@fortia.com.mx');
  assert.equal((await otro('POST', '/import/msproject', { xml, code: 'ERP-GID' })).status, 403);
  assert.equal((await otro('GET', `/projects/${projectId}`)).status, 404, 'sin acceso no ve el proyecto');

  // Semana del 14 sep 2026 (miércoles 16 festivo): Ana tiene asignada "Configuración módulo Finanzas" (31 ago – 2 oct).
  const week = '2026-09-14';
  const sheet = await ana('GET', '/timesheets/2026-09-16'); // cualquier día normaliza al lunes
  assert.equal(sheet.data.week, week);
  assert.deepEqual(sheet.data.days, ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'], 'lunes a viernes');
  assert.equal(sheet.data.capacity, 45);
  assert.equal(sheet.data.required, 36, '45 h menos un festivo');
  const names = sheet.data.rows.map((r) => r.taskName);
  assert.ok(names.includes('Configuración módulo Finanzas'));
  assert.ok(!names.includes('Levantamiento de requerimientos'), 'tareas fuera de fecha no se precargan');
  // Tiene acceso al proyecto, así que puede agregar otras tareas del mismo aunque no se le asignaran.
  assert.ok(sheet.data.available.some((t) => t.taskName === 'Desarrollo de interfaces'));
  const finanzas = sheet.data.rows.find((r) => r.taskName === 'Configuración módulo Finanzas').taskId;
  const vacaciones = sheet.data.available.find((t) => t.taskName === 'Vacaciones y permisos').taskId;

  // No puede cargar horas a un proyecto al que no tiene acceso.
  const otherProject = (await admin('POST', '/projects', { code: 'OTRO', name: 'Otro proyecto', status: 'Activo' })).data.id;
  const otherTask = (await admin('POST', `/projects/${otherProject}/tasks`, { name: 'Tarea ajena' })).data.id;
  assert.equal((await ana('PUT', `/timesheets/${week}`, { rows: [{ taskId: otherTask, hours: { [week]: 2 } }] })).status, 403);
  // Más de 24 h en un día, sábado o fecha de otra semana.
  assert.equal((await ana('PUT', `/timesheets/${week}`, { rows: [{ taskId: finanzas, hours: { [week]: 20 } }, { taskId: vacaciones, hours: { [week]: 8 } }] })).status, 400);
  assert.equal((await ana('PUT', `/timesheets/${week}`, { rows: [{ taskId: finanzas, hours: { '2026-09-19': 2 } }] })).status, 400, 'sábado');
  assert.equal((await ana('PUT', `/timesheets/${week}`, { rows: [{ taskId: finanzas, hours: { '2026-09-21': 2 } }] })).status, 400);

  const days = ['2026-09-14', '2026-09-15', '2026-09-17'];
  const saved = await ana('PUT', `/timesheets/${week}`, {
    rows: [
      { taskId: finanzas, hours: Object.fromEntries(days.map((d) => [d, 8])), note: 'Configuración de catálogos' },
      { taskId: vacaciones, hours: { '2026-09-18': 9 } },
    ],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.timesheet.status, 'borrador');

  // Los borradores no cuentan en los indicadores por defecto.
  const draftMetrics = await lider('GET', `/metrics?from=${week}&to=2026-09-18`);
  assert.equal(draftMetrics.data.kpis.hours, 0);

  assert.equal((await ana('POST', `/timesheets/${week}/submit`)).data.timesheet.status, 'enviado');
  assert.equal((await ana('PUT', `/timesheets/${week}`, { rows: [] })).status, 409, 'enviado queda bloqueado');

  // Solo el líder directo puede aprobar.
  const tsId = db.prepare('SELECT id FROM timesheets WHERE user_id = ? AND week_start = ?').get(ids.ana, week).id;
  assert.equal((await otro('POST', `/approvals/${tsId}`, { action: 'aprobar' })).status, 404);
  assert.equal((await ana('POST', `/approvals/${tsId}`, { action: 'aprobar' })).status, 403);
  const pending = await lider('GET', '/approvals?status=enviado');
  assert.deepEqual(pending.data.items.map((i) => i.id), [tsId]);
  assert.equal((await lider('POST', `/approvals/${tsId}`, { action: 'rechazar' })).status, 400, 'rechazo exige motivo');
  assert.equal((await lider('POST', `/approvals/${tsId}`, { action: 'aprobar' })).data.status, 'aprobado');

  // Disponibilidad = 45 − 9 (festivo) − 9 (vacaciones) = 27; facturables 24; eficiencia 24/27.
  const m = (await lider('GET', `/metrics?from=${week}&to=2026-09-18`)).data;
  assert.equal(m.kpis.hours, 33);
  assert.equal(m.kpis.projectHours, 24);
  assert.equal(m.kpis.adminHours, 9);
  const anaU = m.people.find((u) => u.userId === ids.ana);
  assert.deepEqual([anaU.capacity, anaU.holidayHours, anaU.deductHours, anaU.availability], [45, 9, 9, 27]);
  assert.equal(anaU.efficiency, 0.8889);
  assert.equal(anaU.unregistered, 3);
  assert.deepEqual(m.adminTasks.map((t) => [t.name, t.hours]), [['Vacaciones y permisos', 9]]);
  const erp = m.projects.find((p) => p.code === 'ERP-GID');
  assert.equal(erp.planned, 800);
  assert.equal(erp.actualToDate, 24);

  // Un consultor solo ve sus propios indicadores.
  const own = (await ana('GET', `/metrics?from=${week}&to=2026-09-18`)).data;
  assert.deepEqual(own.people.map((u) => u.userId), [ids.ana]);
  assert.equal((await ana('GET', `/metrics?userId=${ids.carlos}`)).status, 403);

  const csv = await lider('GET', `/metrics/export.csv?from=${week}&to=2026-09-18`);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Configuración de catálogos/);
  assert.equal(csv.data.trim().split('\r\n').length, 5); // encabezado + 4 días
});

test('ficha de proyecto: catálogos, gestor, módulos, acceso y reemplazo de recursos', async () => {
  const admin = await login('admin@fortia.com.mx');
  const lider = await login('laura@fortia.com.mx');
  const ana = await login('ana.lopez@fortia.com.mx');
  const projectId = db.prepare("SELECT id FROM projects WHERE code = 'ERP-GID'").get().id;
  const nom = (await admin('POST', '/admin/modules', { code: 'NOM2', name: 'Nómina 2' })).data.id;
  const clientId = db.prepare("SELECT id FROM clients WHERE name = 'Grupo Demo'").get().id;
  const base = { code: 'ERP-GID', name: 'ERP Demo', clientId, pmId: ids.lider, status: 'Activo', stage: 'Implementación',
    soldHours: 900, budgetUsd: 48000, salesExec: 'Roberto', moduleIds: [nom] };

  assert.equal((await lider('PUT', `/projects/${projectId}`, { ...base, status: 'Cerrado' })).status, 400, 'estatus fuera de catálogo');
  assert.equal((await lider('PUT', `/projects/${projectId}`, { ...base, clientId: 9999 })).status, 400, 'cliente fuera de catálogo');
  assert.equal((await lider('PUT', `/projects/${projectId}`, { ...base, pmId: ids.ana })).status, 400, 'gestor debe tener rol gestor');
  assert.equal((await ana('PUT', `/projects/${projectId}`, base)).status, 403, 'un consultor no edita');
  assert.equal((await lider('PUT', `/projects/${projectId}`, base)).status, 200);
  const p = (await ana('GET', `/projects/${projectId}`)).data;
  assert.equal(p.project.soldHours, 900);
  assert.deepEqual(p.modules.map((m) => m.code), ['NOM2']);

  // Módulo de tarea: solo de los del proyecto.
  const task = db.prepare("SELECT id FROM tasks WHERE project_id = ? AND name = 'Pruebas integrales'").get(projectId).id;
  const other = (await admin('POST', '/admin/modules', { code: 'OTR', name: 'Otro' })).data.id;
  assert.equal((await lider('PUT', `/tasks/${task}`, { moduleId: other })).status, 400);
  assert.equal((await lider('PUT', `/tasks/${task}`, { moduleId: nom })).status, 200);
  assert.equal((await admin('DELETE', `/admin/modules/${nom}`)).status, 409, 'módulo en uso no se borra');

  // Reemplazar el recurso "Consultor Externo" por Carlos le da la tarea y acceso al proyecto.
  const externo = p.resources.find((r) => r.name === 'Consultor Externo');
  assert.equal((await lider('PUT', `/projects/${projectId}/resources/${externo.id}`, { userId: ids.carlos })).status, 200);
  const carlos = await login('carlos.ramirez@fortia.com.mx');
  const projects = (await carlos('GET', '/projects')).data.items.map((x) => x.code);
  assert.deepEqual(projects, ['ERP-GID']);
  const blueprint = db.prepare("SELECT id FROM tasks WHERE project_id = ? AND name = 'Diseño de solución (Blueprint)'").get(projectId).id;
  assert.ok(db.prepare('SELECT 1 FROM assignments WHERE task_id = ? AND user_id = ?').get(blueprint, ids.carlos));

  // Quitar el acceso lo saca del proyecto.
  const members = p.members.map((m) => m.id).filter((id) => id !== ids.carlos);
  assert.equal((await lider('PUT', `/projects/${projectId}/members`, { userIds: members })).status, 200);
  assert.deepEqual((await carlos('GET', '/projects')).data.items, []);

  // Un proyecto "Entregado" ya no acepta horas.
  await lider('PUT', `/projects/${projectId}`, { ...base, status: 'Entregado' });
  const sheet = (await ana('GET', '/timesheets/2026-09-21')).data;
  assert.ok(!sheet.rows.concat(sheet.available).some((t) => t.projectCode === 'ERP-GID'));
});

test('tareas administrativas: alta, cambio y baja sin perder historia', async () => {
  const admin = await login('admin@fortia.com.mx');
  const created = await admin('POST', '/admin/tasks', { name: 'Apoyo a preventa', reducesAvailability: false });
  assert.equal(created.status, 201);
  assert.equal((await admin('DELETE', `/admin/tasks/${created.data.id}`)).data.deleted, true);
  const vacaciones = db.prepare("SELECT id FROM tasks WHERE name = 'Vacaciones y permisos'").get().id;
  const del = await admin('DELETE', `/admin/tasks/${vacaciones}`);
  assert.deepEqual(del.data, { deleted: false, deactivated: true }, 'con horas registradas solo se desactiva');
  const settings = await admin('PUT', '/admin/settings', { weeklyHours: 40, applyToAll: true });
  assert.equal(settings.data.weeklyHours, 40);
  assert.equal(db.prepare('SELECT weekly_capacity FROM users WHERE id = ?').get(ids.ana).weekly_capacity, 40);
});

test('las escrituras requieren JSON (protección CSRF básica)', async () => {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(res.status, 415);
});

test('solo el admin administra usuarios', async () => {
  const lider = await login('laura@fortia.com.mx');
  assert.equal((await lider('POST', '/users', { name: 'X', email: 'x@fortia.com.mx', password: 'abcdefgh' })).status, 403);
  const admin = await login('admin@fortia.com.mx');
  const created = await admin('POST', '/users', { name: 'Nuevo', email: 'nuevo@fortia.com.mx', password: 'abcdefgh', managerId: ids.lider });
  assert.equal(created.status, 201);
  assert.equal((await admin('POST', '/users', { name: 'Nuevo', email: 'NUEVO@fortia.com.mx', password: 'abcdefgh' })).status, 409);
  // El admin no cuenta en la disponibilidad ni en la eficiencia.
  const m = (await admin('GET', '/metrics')).data;
  assert.ok(!m.people.some((u) => u.name === 'Administrador'));
});
