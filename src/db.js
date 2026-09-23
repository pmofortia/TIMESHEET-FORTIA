import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Rubros en los que se clasifica cada hora registrada.
export const CATEGORIES = [
  { key: 'facturable', label: 'Proyecto facturable' },
  { key: 'preventa', label: 'Preventa' },
  { key: 'interno', label: 'Proyecto interno' },
  { key: 'capacitacion', label: 'Capacitación' },
  { key: 'administrativo', label: 'Administrativo' },
  { key: 'ausencia', label: 'Ausencia (vacaciones, permiso, incapacidad)' },
];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
export const ROLES = ['consultor', 'lider', 'admin'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'consultor' CHECK (role IN ('consultor','lider','admin')),
  weekly_capacity REAL NOT NULL DEFAULT 40,
  area            TEXT,
  manager_id      INTEGER REFERENCES users(id),
  tracks_time     INTEGER NOT NULL DEFAULT 1, -- cuenta para capacidad y cargabilidad
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  client         TEXT,
  category       TEXT NOT NULL DEFAULT 'facturable',
  status         TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','cerrado')),
  source         TEXT NOT NULL DEFAULT 'manual',
  open_to_all    INTEGER NOT NULL DEFAULT 0,
  pm_id          INTEGER REFERENCES users(id),
  last_import_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_uid  TEXT NOT NULL,
  name          TEXT NOT NULL,
  wbs           TEXT,
  outline_level INTEGER NOT NULL DEFAULT 1,
  parent_path   TEXT,
  start_date    TEXT,
  finish_date   TEXT,
  planned_hours REAL NOT NULL DEFAULT 0,
  is_summary    INTEGER NOT NULL DEFAULT 0,
  category      TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, external_uid)
);

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
`;

export function openDb(file = process.env.DB_FILE || 'data/timesheet.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

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
