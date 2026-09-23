import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { durationToHours, parseMspdi } from '../src/importers/mspdi.js';
import { parseCsvText, parseDate, parseTaskCsv } from '../src/importers/csv.js';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { applyPlan, plansFromCsv, rebuildAssignments } from '../src/services/plans.js';

test('durationToHours interpreta las duraciones de Project', () => {
  assert.equal(durationToHours('PT40H0M0S'), 40);
  assert.equal(durationToHours('PT7H30M0S'), 7.5);
  assert.equal(durationToHours('P1DT2H0M0S'), 10);
  assert.equal(durationToHours(''), 0);
  assert.equal(durationToHours('basura'), 0);
});

test('parseMspdi lee tareas, jerarquía, recursos y asignaciones', () => {
  const plan = parseMspdi(readFileSync('samples/proyecto-ejemplo.xml', 'utf8'));
  assert.equal(plan.name, 'Implementación ERP - Grupo Industrial Demo');
  assert.equal(plan.tasks.length, 12); // excluye la tarea resumen UID 0
  const finanzas = plan.tasks.find((t) => t.name === 'Configuración módulo Finanzas');
  assert.equal(finanzas.work, 160);
  assert.equal(finanzas.start, '2026-08-31');
  assert.equal(finanzas.parentPath, 'Fase 2 · Construcción');
  assert.equal(finanzas.isSummary, false);
  assert.ok(plan.tasks.find((t) => t.uid === '2').isSummary);
  // Solo recursos de trabajo; "Licencias SAP" es material.
  assert.deepEqual(plan.resources.map((r) => r.name).sort(), ['Ana López', 'Carlos Ramírez', 'Consultor Externo', 'María Hernández']);
  // La asignación a -65535 (sin recurso) se descarta.
  assert.equal(plan.assignments.length, 14);
});

test('parseMspdi rechaza archivos que no son de Project', () => {
  assert.throws(() => parseMspdi('<html><body/></html>'), /Microsoft Project/);
});

test('parser CSV maneja comillas, punto y coma y fechas mexicanas', () => {
  assert.deepEqual(parseCsvText('a;b\n"x;1";"di ""hola"""\n'), [['a', 'b'], ['x;1', 'di "hola"']]);
  assert.equal(parseDate('07/09/2026'), '2026-09-07');
  assert.equal(parseDate('lun 7/9/26'), '2026-09-07');
  assert.equal(parseDate('2026-09-07'), '2026-09-07');
  const { items, errors } = parseTaskCsv('Proyecto,Tarea,Horas\nP1,T1,"8,5"\n,T2,1\n');
  assert.equal(items[0].hours, 8.5);
  assert.equal(errors.length, 1);
});

test('applyPlan es idempotente, vincula por correo y desactiva tareas eliminadas', () => {
  const db = openDb(':memory:');
  const pw = hashPassword('x'.repeat(8));
  db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Ana López', 'ANA.LOPEZ@fortia.com.mx', ?)").run(pw);
  db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Maria Hernandez', 'otra@fortia.com.mx', ?)").run(pw);
  const plan = parseMspdi(readFileSync('samples/proyecto-ejemplo.xml', 'utf8'));

  const first = applyPlan(db, plan, { source: 'msproject' });
  assert.equal(first.created, true);
  assert.equal(first.tasksCreated, 12);
  // Ana por correo (sin importar mayúsculas); María por nombre sin acentos. Los demás quedan guardados sin usuario.
  assert.deepEqual(first.resources.filter((r) => r.user).map((m) => m.user).sort(), ['Ana López', 'Maria Hernandez']);
  assert.equal(first.resources.filter((r) => !r.user).length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_resources').get().n, 4);
  // Quedan con acceso al proyecto los usuarios vinculados.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_members').get().n, 2);

  // Reemplazo manual: el recurso "Carlos Ramírez" lo cubre Ana; la reimportación respeta el reemplazo.
  const carlosRes = db.prepare("SELECT id FROM project_resources WHERE name = 'Carlos Ramírez'").get().id;
  const anaId = db.prepare("SELECT id FROM users WHERE name = 'Ana López'").get().id;
  db.prepare('UPDATE project_resources SET user_id = ? WHERE id = ?').run(anaId, carlosRes);
  rebuildAssignments(db, first.project.id);
  const interfaces = db.prepare("SELECT id FROM tasks WHERE name = 'Desarrollo de interfaces'").get().id;
  assert.equal(db.prepare('SELECT user_id FROM assignments WHERE task_id = ?').get(interfaces).user_id, anaId);

  const second = applyPlan(db, { ...plan, tasks: plan.tasks.filter((t) => t.uid !== '12') }, { source: 'msproject' });
  assert.equal(second.created, false);
  assert.equal(second.tasksCreated, 0);
  assert.equal(second.tasksUpdated, 11);
  assert.equal(second.tasksDeactivated, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 12);
  assert.equal(db.prepare('SELECT user_id FROM assignments WHERE task_id = ?').get(interfaces).user_id, anaId, 'el reemplazo sobrevive a la reimportación');
});

test('plansFromCsv agrupa por proyecto y suma horas por tarea', () => {
  const { items } = parseTaskCsv(readFileSync('samples/plan-ejemplo.csv', 'utf8'));
  const plans = plansFromCsv(items);
  assert.equal(plans.length, 2);
  const bi = plans.find((p) => p.code === 'BI-DIAG');
  const modelo = bi.tasks.find((t) => t.name === 'Modelo de datos y tableros');
  assert.equal(modelo.work, 100);
  assert.equal(bi.assignments.filter((a) => a.taskUid === modelo.uid).length, 2);
});
