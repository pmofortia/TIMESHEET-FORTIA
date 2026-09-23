import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const ROLES = ['consultor', 'lider', 'admin'];
export const ROLE_LABELS = { consultor: 'Consultor', lider: 'Gestor de proyecto', admin: 'Administrador' };

export const PROJECT_STATUSES = [
  'Prerrequisitos', 'Por asignar', 'Asignado', 'Entregado', 'Activo',
  'Estabilización', 'Gestionando pase a soporte', 'Suspendido',
];
// En estos estatus ya no se pueden registrar horas nuevas.
export const CLOSED_STATUSES = ['Entregado', 'Suspendido'];
export const PROJECT_STAGES = ['Preparación', 'Planificación y estimación', 'Implementación', 'Lanzamiento'];

export const DEFAULT_MODULES = [
  ['AP', 'Administración de personal'], ['NOM', 'Nómina'], ['T&A', 'Tiempo y asistencia'],
  ['CH', 'Checapp'], ['GT', 'Gestor de terminales'], ['KIO', 'Kiosco'], ['APP', 'Gestión APP'],
  ['R&S', 'Reclutamiento y selección'], ['CAP', 'Capacitación'], ['EXP', 'Experiencia del colaborador'],
  ['COM', 'Comedor'], ['COMPULSA', 'Compulsa'], ['EVD', 'Evaluación al desempeño'], ['PCS', 'Plan de carrera y sucesión'],
];

// Tareas administrativas iniciales: [nombre, descuenta disponibilidad].
export const DEFAULT_ADMIN_TASKS = [
  ['Vacaciones y permisos', 1], ['Documentación IA', 1], ['Innovación', 1], ['Apoyo a Soporte', 1],
  ['Capacitación', 1], ['Preventa', 0], ['Juntas internas', 0], ['Administrativo', 0],
];

export const DEFAULT_WEEKLY_HOURS = 45;
export const INTERNAL_PROJECT_CODE = 'FORTIA-ADMIN';
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'consultor' CHECK (role IN ('consultor','lider','admin')),
  weekly_capacity REAL NOT NULL DEFAULT ${DEFAULT_WEEKLY_HOURS},
  area            TEXT,
  manager_id      INTEGER REFERENCES users(id),
  tracks_time     INTEGER NOT NULL DEFAULT 1,   -- cuenta para disponibilidad y eficiencia
  active          INTEGER NOT NULL DEFAULT 1,
  auth_provider   TEXT NOT NULL DEFAULT 'local', -- 'local' o 'microsoft'
  external_id     TEXT UNIQUE,                   -- oid del usuario en Entra ID
  last_login_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oidc_requests (
  state      TEXT PRIMARY KEY,
  nonce      TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  return_to  TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sales_exec TEXT,                 -- ejecutivo comercial
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS modules (
  id     INTEGER PRIMARY KEY,
  code   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name   TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  client_id      INTEGER REFERENCES clients(id),
  sales_exec     TEXT,
  pm_id          INTEGER REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'Por asignar',
  stage          TEXT,
  sold_hours     REAL,
  budget_usd     REAL,
  is_internal    INTEGER NOT NULL DEFAULT 0, -- el proyecto que agrupa las tareas administrativas
  source         TEXT NOT NULL DEFAULT 'manual',
  last_import_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_modules (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module_id  INTEGER NOT NULL REFERENCES modules(id),
  PRIMARY KEY (project_id, module_id)
);

-- Usuarios con acceso a un proyecto (lo ven y pueden registrar horas en sus tareas).
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id                   INTEGER PRIMARY KEY,
  project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_uid         TEXT NOT NULL,
  name                 TEXT NOT NULL,
  wbs                  TEXT,
  outline_level        INTEGER NOT NULL DEFAULT 1,
  parent_path          TEXT,
  start_date           TEXT,
  finish_date          TEXT,
  planned_hours        REAL NOT NULL DEFAULT 0,
  is_summary           INTEGER NOT NULL DEFAULT 0,
  module_id            INTEGER REFERENCES modules(id),
  reduces_availability INTEGER NOT NULL DEFAULT 0, -- solo tareas administrativas
  active               INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, external_uid)
);

-- Recursos tal como vienen en Project; user_id es el usuario del sistema que lo cubre (reemplazable).
CREATE TABLE IF NOT EXISTS project_resources (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uid        TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (project_id, uid)
);

CREATE TABLE IF NOT EXISTS plan_assignments (
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  resource_id   INTEGER NOT NULL REFERENCES project_resources(id) ON DELETE CASCADE,
  planned_hours REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, resource_id)
);

-- Asignación efectiva tarea-usuario: derivada de plan_assignments + mapeo de recursos, o manual.
CREATE TABLE IF NOT EXISTS assignments (
  id            INTEGER PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  planned_hours REAL NOT NULL DEFAULT 0,
  UNIQUE (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS timesheets (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador','enviado','aprobado','rechazado')),
  submitted_at   TEXT,
  reviewed_by    INTEGER REFERENCES users(id),
  reviewed_at    TEXT,
  review_comment TEXT,
  UNIQUE (user_id, week_start)
);

CREATE TABLE IF NOT EXISTS time_entries (
  id           INTEGER PRIMARY KEY,
  timesheet_id INTEGER NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  task_id      INTEGER NOT NULL REFERENCES tasks(id),
  work_date    TEXT NOT NULL,
  hours        REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  note         TEXT,
  UNIQUE (timesheet_id, task_id, work_date)
);

CREATE TABLE IF NOT EXISTS import_log (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  user_id    INTEGER REFERENCES users(id),
  source     TEXT NOT NULL,
  filename   TEXT,
  summary    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entries_date ON time_entries(work_date);
CREATE INDEX IF NOT EXISTS idx_entries_task ON time_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_assign_user ON assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);
`;

export function openDb(file = process.env.DB_FILE || 'data/timesheet.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const hasTables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().n > 0;
  if (hasTables && version < SCHEMA_VERSION) {
    throw new Error(`La base ${file} es de una versión anterior del sistema (sin datos productivos todavía). `
      + 'Bórrala o ejecuta "npm run seed -- --reset" para recrearla.');
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export const weeklyHoursSetting = (db) => Number(getSetting(db, 'weekly_hours', DEFAULT_WEEKLY_HOURS));

// node:sqlite no trae helper de transacciones.
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
