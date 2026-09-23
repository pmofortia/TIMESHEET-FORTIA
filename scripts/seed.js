// Carga datos de demostración: usuarios, el plan de ejemplo de Project y
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
ensureBaseData(db);
const password = hashPassword('Fortia2026!');
const addUser = (name, email, role, area, managerId = null) =>
  Number(db.prepare('INSERT INTO users (name, email, password_hash, role, area, manager_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, email, password, role, area, managerId).lastInsertRowid);

const lider = addUser('Laura Martínez', 'laura.martinez@fortia.com.mx', 'lider', 'Consultoría ERP');
db.prepare('UPDATE users SET tracks_time = 0 WHERE id = ?').run(lider); // la líder no factura en el demo
const ana = addUser('Ana López', 'ana.lopez@fortia.com.mx', 'consultor', 'Consultoría ERP', lider);
const carlos = addUser('Carlos Ramírez', 'carlos.ramirez@fortia.com.mx', 'consultor', 'Integraciones', lider);
const maria = addUser('María Hernández', 'maria.hernandez@fortia.com.mx', 'consultor', 'Consultoría ERP', lider);

const erp = applyPlan(db, { ...parseMspdi(readFileSync('samples/proyecto-ejemplo.xml', 'utf8')), code: 'ERP-GID', client: 'Grupo Industrial Demo' }, { source: 'msproject' });
for (const plan of plansFromCsv(parseTaskCsv(readFileSync('samples/plan-ejemplo.csv', 'utf8')).items)) applyPlan(db, plan, { source: 'csv' });
console.log(`Proyecto ERP importado: ${erp.tasksCreated} tareas, ${erp.assignments} asignaciones`);

const internal = new Map(db.prepare(`SELECT t.external_uid AS uid, t.id FROM tasks t JOIN projects p ON p.id = t.project_id
  WHERE p.code = 'FORTIA-INT'`).all().map((r) => [r.uid, r.id]));

// Reparte horas por día hábil entre las tareas asignadas de esa semana.
function fillWeek(userId, week, { internalHours = {}, billablePerDay = 7 } = {}) {
  const sheet = loadWeek(db, userId, week);
  const days = sheet.days.slice(0, 5);
  const project = sheet.rows.filter((r) => r.category === 'facturable' || r.category === 'preventa');
  const rows = project.map((r) => ({ taskId: r.taskId, hours: {} }));
  days.forEach((d, i) => {
    if (!rows.length) return;
    const row = rows[i % rows.length];
    row.hours[d] = (row.hours[d] || 0) + billablePerDay;
  });
  for (const [uid, perDay] of Object.entries(internalHours)) {
    rows.push({ taskId: internal.get(uid), hours: Object.fromEntries(days.map((d) => [d, perDay])) });
  }
  saveWeek(db, userId, week, rows);
}

const current = weekStart(today());
const weeks = [3, 2, 1].map((n) => addDays(current, -7 * n));
for (const week of weeks) {
  fillWeek(ana, week, { internalHours: { 'INT-JUNTAS': 1 } });
  fillWeek(carlos, week, { billablePerDay: 6, internalHours: { 'INT-CAPACITACION': 2 } });
  if (week !== weeks[1]) fillWeek(maria, week, { billablePerDay: 5, internalHours: { 'INT-PREVENTA': 2, 'INT-ADMIN': 1 } });
}
// María tomó vacaciones la semana intermedia.
saveWeek(db, maria, weeks[1], [{ taskId: internal.get('INT-VACACIONES'), hours: Object.fromEntries(loadWeek(db, maria, weeks[1]).days.slice(0, 5).map((d) => [d, 8])) }]);

for (const [userId, list] of [[ana, weeks], [carlos, weeks.slice(0, 2)], [maria, weeks]]) {
  for (const week of list) {
    submitWeek(db, userId, week);
    const id = db.prepare('SELECT id FROM timesheets WHERE user_id = ? AND week_start = ?').get(userId, week).id;
    if (week !== weeks[2]) reviewTimesheet(db, lider, id, 'aprobar', null);
  }
}
fillWeek(ana, current, { billablePerDay: 4 });

console.log('\nDatos de demostración listos. Contraseña de todos: Fortia2026!');
console.log('  admin@fortia.com.mx           (administrador)');
console.log('  laura.martinez@fortia.com.mx  (líder, aprueba a su equipo)');
console.log('  ana.lopez@fortia.com.mx       (consultora)');
console.log('  carlos.ramirez@fortia.com.mx  (consultor)');
console.log('  maria.hernandez@fortia.com.mx (consultora)');
