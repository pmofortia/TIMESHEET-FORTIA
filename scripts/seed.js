// Carga datos de demostración: catálogos, usuarios, el plan de ejemplo de Project y
// algunas semanas de horas. Uso: npm run seed [-- --reset]
import { readFileSync, rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { ensureBaseData } from '../src/bootstrap.js';
import { hashPassword } from '../src/auth.js';
import { parseMspdi } from '../src/importers/mspdi.js';
import { parseTaskCsv } from '../src/importers/csv.js';
import { applyPlan, plansFromCsv } from '../src/services/plans.js';
import { loadWeek, reviewTimesheet, saveWeek, submitWeek } from '../src/services/timesheets.js';
import { addDays, today, weekStart } from '../src/dates.js';

const file = process.env.DB_FILE || 'data/timesheet.db';
if (process.argv.includes('--reset')) for (const ext of ['', '-wal', '-shm']) rmSync(file + ext, { force: true });
const db = openDb(file);
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.error('La base ya tiene datos. Usa "npm run seed -- --reset" para empezar de cero.');
  process.exit(1);
}

process.env.ADMIN_PASSWORD ||= 'Fortia2026!';
ensureBaseData(db, { log: () => {} });

// Días festivos oficiales 2026 (Ley Federal del Trabajo, art. 74).
const holidays = [
  ['2026-01-01', 'Año Nuevo'], ['2026-02-02', 'Día de la Constitución'], ['2026-03-16', 'Natalicio de Benito Juárez'],
  ['2026-05-01', 'Día del Trabajo'], ['2026-09-16', 'Día de la Independencia'], ['2026-11-16', 'Día de la Revolución'],
  ['2026-12-25', 'Navidad'],
];
for (const [date, name] of holidays) db.prepare('INSERT INTO holidays (date, name) VALUES (?, ?)').run(date, name);

const client = (name, exec) => Number(db.prepare('INSERT INTO clients (name, sales_exec) VALUES (?, ?)').run(name, exec).lastInsertRowid);
const gid = client('Grupo Industrial Demo', 'Roberto Sánchez');
client('Retail Demo', 'Paola Méndez');
client('Banco Demo', 'Roberto Sánchez');

const password = hashPassword('Fortia2026!');
const addUser = (name, email, role, area, managerId = null, tracks = 1) =>
  Number(db.prepare('INSERT INTO users (name, email, password_hash, role, area, manager_id, tracks_time) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, email, password, role, area, managerId, tracks).lastInsertRowid);

const gestor = addUser('Laura Martínez', 'laura.martinez@fortia.com.mx', 'lider', 'Consultoría HCM', null, 0);
const ana = addUser('Ana López', 'ana.lopez@fortia.com.mx', 'consultor', 'Consultoría HCM', gestor);
const carlos = addUser('Carlos Ramírez', 'carlos.ramirez@fortia.com.mx', 'consultor', 'Integraciones', gestor);
const maria = addUser('María Hernández', 'maria.hernandez@fortia.com.mx', 'consultor', 'Consultoría HCM', gestor);
addUser('Jorge Castillo', 'jorge.castillo@fortia.com.mx', 'consultor', 'Integraciones', gestor);

const erp = applyPlan(db, { ...parseMspdi(readFileSync('samples/proyecto-ejemplo.xml', 'utf8')), code: 'HCM-GID', clientId: gid }, { source: 'msproject' });
const moduleId = (code) => db.prepare('SELECT id FROM modules WHERE code = ?').get(code).id;
db.prepare(`UPDATE projects SET name = 'Implementación HCM - Grupo Industrial Demo', pm_id = ?, status = 'Activo', stage = 'Implementación',
  sold_hours = 900, budget_usd = 48000, sales_exec = 'Roberto Sánchez' WHERE id = ?`).run(gestor, erp.project.id);
for (const code of ['AP', 'NOM', 'T&A']) db.prepare('INSERT INTO project_modules VALUES (?, ?)').run(erp.project.id, moduleId(code));
const setModule = (task, code) => db.prepare('UPDATE tasks SET module_id = ? WHERE project_id = ? AND name = ?').run(moduleId(code), erp.project.id, task);
setModule('Configuración módulo Finanzas', 'NOM');
setModule('Configuración módulo Compras', 'T&A');
setModule('Desarrollo de interfaces', 'AP');
setModule('Levantamiento de requerimientos', 'AP');

for (const plan of plansFromCsv(parseTaskCsv(readFileSync('samples/plan-ejemplo.csv', 'utf8')).items)) {
  const s = applyPlan(db, plan, { source: 'csv' });
  db.prepare("UPDATE projects SET pm_id = ?, status = 'Asignado', stage = 'Planificación y estimación', sold_hours = 140 WHERE id = ?").run(gestor, s.project.id);
}
console.log(`Proyecto HCM importado: ${erp.tasksCreated} tareas; recursos: ${erp.resources.map((r) => `${r.resource} → ${r.user || 'SIN USUARIO'}`).join(', ')}`);

const adminTask = new Map(db.prepare('SELECT t.name, t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.is_internal = 1').all().map((r) => [r.name, r.id]));

// Reparte horas por día hábil entre las tareas de proyecto asignadas esa semana, más horas administrativas diarias.
function fillWeek(userId, week, { projectPerDay = 8, admin = {} } = {}) {
  const sheet = loadWeek(db, userId, week);
  const days = sheet.days.filter((d) => !sheet.holidays.some((h) => h.date === d));
  const rows = sheet.rows.filter((r) => !r.isAdmin).map((r) => ({ taskId: r.taskId, hours: {} }));
  days.forEach((d, i) => {
    if (!rows.length) return;
    rows[i % rows.length].hours[d] = projectPerDay;
  });
  for (const [name, perDay] of Object.entries(admin)) {
    rows.push({ taskId: adminTask.get(name), hours: Object.fromEntries(days.map((d) => [d, perDay])) });
  }
  saveWeek(db, userId, week, rows);
}

const current = weekStart(today());
const weeks = [3, 2, 1].map((n) => addDays(current, -7 * n));
for (const week of weeks) {
  fillWeek(ana, week, { projectPerDay: 8, admin: { 'Juntas internas': 1 } });
  fillWeek(carlos, week, { projectPerDay: 6, admin: { Capacitación: 2, 'Documentación IA': 1 } });
  if (week !== weeks[1]) fillWeek(maria, week, { projectPerDay: 6, admin: { Preventa: 2, Innovación: 1 } });
}
// María tomó vacaciones la semana intermedia.
const mariaWeek = loadWeek(db, maria, weeks[1]);
saveWeek(db, maria, weeks[1], [{
  taskId: adminTask.get('Vacaciones y permisos'),
  hours: Object.fromEntries(mariaWeek.days.filter((d) => !mariaWeek.holidays.some((h) => h.date === d)).map((d) => [d, 9])),
}]);

for (const [userId, list] of [[ana, weeks], [carlos, weeks.slice(0, 2)], [maria, weeks]]) {
  for (const week of list) {
    submitWeek(db, userId, week);
    const id = db.prepare('SELECT id FROM timesheets WHERE user_id = ? AND week_start = ?').get(userId, week).id;
    if (week !== weeks[2]) reviewTimesheet(db, gestor, id, 'aprobar', null);
  }
}
fillWeek(ana, current, { projectPerDay: 4 });

console.log('\nDatos de demostración listos. Contraseña de todos: Fortia2026!');
console.log('  admin@fortia.com.mx           (administrador)');
console.log('  laura.martinez@fortia.com.mx  (gestora de proyecto, aprueba a su equipo)');
console.log('  ana.lopez@fortia.com.mx       (consultora)');
console.log('  carlos.ramirez@fortia.com.mx  (consultor)');
console.log('  maria.hernandez@fortia.com.mx (consultora)');
console.log('  jorge.castillo@fortia.com.mx  (consultor sin proyectos: úsalo para reemplazar al "Consultor Externo")');
