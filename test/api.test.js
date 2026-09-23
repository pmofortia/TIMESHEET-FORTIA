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

  // Vista previa no escribe nada.
  const preview = await lider('POST', '/import/msproject', { xml, code: 'ERP-GID', dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.results[0].tasksCreated, 12);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE code = 'ERP-GID'").get().n, 0);

  const imp = await lider('POST', '/import/msproject', { xml, code: 'ERP-GID', client: 'Grupo Demo', filename: 'erp.xml' });
  assert.equal(imp.status, 200);
  assert.equal(imp.data.results[0].project.code, 'ERP-GID');

  // Semana del 14 sep 2026: Ana tiene asignada "Configuración módulo Finanzas" (31 ago – 2 oct).
  const week = '2026-09-14';
  const sheet = await ana('GET', '/timesheets/2026-09-16'); // cualquier día normaliza al lunes
  assert.equal(sheet.data.week, week);
  const names = sheet.data.rows.map((r) => r.taskName);
  assert.ok(names.includes('Configuración módulo Finanzas'));
  assert.ok(!names.includes('Levantamiento de requerimientos'), 'tareas fuera de fecha no se precargan');
  assert.ok(!names.includes('Desarrollo de interfaces'), 'tareas de otros no aparecen');
  const finanzas = sheet.data.rows.find((r) => r.taskName === 'Configuración módulo Finanzas').taskId;
  const vacaciones = sheet.data.available.find((t) => t.taskName === 'Vacaciones').taskId;
  const interfaces = db.prepare("SELECT id FROM tasks WHERE name = 'Desarrollo de interfaces'").get().id;

  // No puede cargar horas a una tarea que no le asignaron.
  const forbidden = await ana('PUT', `/timesheets/${week}`, { rows: [{ taskId: interfaces, hours: { [week]: 2 } }] });
  assert.equal(forbidden.status, 403);
  // Más de 24 h en un día.
  const tooMuch = await ana('PUT', `/timesheets/${week}`, { rows: [{ taskId: finanzas, hours: { [week]: 20 } }, { taskId: vacaciones, hours: { [week]: 8 } }] });
  assert.equal(tooMuch.status, 400);
  // Fecha fuera de la semana.
  assert.equal((await ana('PUT', `/timesheets/${week}`, { rows: [{ taskId: finanzas, hours: { '2026-09-21': 2 } }] })).status, 400);

  const days = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'];
  const saved = await ana('PUT', `/timesheets/${week}`, {
    rows: [
      { taskId: finanzas, hours: Object.fromEntries(days.map((d) => [d, 8])), note: 'Configuración de catálogos' },
      { taskId: vacaciones, hours: { '2026-09-18': 8 } },
    ],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.timesheet.status, 'borrador');

  // Los borradores no cuentan en los indicadores por defecto.
  const draftMetrics = await lider('GET', `/metrics?from=${week}&to=2026-09-20`);
  assert.equal(draftMetrics.data.kpis.hours, 0);

  assert.equal((await ana('POST', `/timesheets/${week}/submit`)).data.timesheet.status, 'enviado');
  assert.equal((await ana('PUT', `/timesheets/${week}`, { rows: [] })).status, 409, 'enviado queda bloqueado');

  // Solo el líder directo puede aprobar.
  const tsId = db.prepare('SELECT id FROM timesheets WHERE user_id = ? AND week_start = ?').get(ids.ana, week).id;
  const otro = await login('otro@fortia.com.mx');
  assert.equal((await otro('POST', `/approvals/${tsId}`, { action: 'aprobar' })).status, 404);
  assert.equal((await ana('POST', `/approvals/${tsId}`, { action: 'aprobar' })).status, 403);
  const pending = await lider('GET', '/approvals?status=enviado');
  assert.deepEqual(pending.data.items.map((i) => i.id), [tsId]);
  assert.equal((await lider('POST', `/approvals/${tsId}`, { action: 'rechazar' })).status, 400, 'rechazo exige motivo');
  assert.equal((await lider('POST', `/approvals/${tsId}`, { action: 'aprobar' })).data.status, 'aprobado');

  const m = (await lider('GET', `/metrics?from=${week}&to=2026-09-20`)).data;
  assert.equal(m.kpis.hours, 40);
  assert.equal(m.byCategory.facturable, 32);
  assert.equal(m.byCategory.ausencia, 8);
  const anaU = m.utilization.find((u) => u.userId === ids.ana);
  assert.equal(anaU.capacity, 40);
  assert.equal(anaU.utilization, 0.8); // 32 / 40
  assert.equal(anaU.netUtilization, 1); // 32 / (40 - 8)
  const erp = m.projects.find((p) => p.code === 'ERP-GID');
  assert.equal(erp.planned, 800);
  assert.equal(erp.actualToDate, 32);

  // Un consultor solo ve sus propios indicadores.
  const own = (await ana('GET', `/metrics?from=${week}&to=2026-09-20`)).data;
  assert.deepEqual(own.utilization.map((u) => u.userId), [ids.ana]);
  assert.equal((await ana('GET', `/metrics?userId=${ids.carlos}`)).status, 403);

  const csv = await lider('GET', `/metrics/export.csv?from=${week}&to=2026-09-20`);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Configuración de catálogos/);
  assert.equal(csv.data.trim().split('\r\n').length, 6); // encabezado + 5 días
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
  // El admin no cuenta en la cargabilidad.
  const m = (await admin('GET', '/metrics')).data;
  assert.ok(!m.utilization.some((u) => u.name === 'Administrador'));
});
