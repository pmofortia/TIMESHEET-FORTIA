import { randomBytes } from 'node:crypto';
import { hashPassword } from './auth.js';

// Actividades no ligadas a un proyecto de cliente, disponibles para todos.
export const INTERNAL_ACTIVITIES = [
  ['INT-PREVENTA', 'Preventa y propuestas', 'preventa'],
  ['INT-CAPACITACION', 'Capacitación y certificaciones', 'capacitacion'],
  ['INT-JUNTAS', 'Juntas internas', 'interno'],
  ['INT-DESARROLLO', 'Iniciativas internas / mejora', 'interno'],
  ['INT-ADMIN', 'Administrativo', 'administrativo'],
  ['INT-VACACIONES', 'Vacaciones', 'ausencia'],
  ['INT-PERMISO', 'Permiso / incapacidad', 'ausencia'],
  ['INT-FESTIVO', 'Día festivo', 'ausencia'],
];

export function ensureBaseData(db, { log = console.log } = {}) {
  let project = db.prepare("SELECT id FROM projects WHERE code = 'FORTIA-INT'").get();
  if (!project) {
    const r = db.prepare(`INSERT INTO projects (code, name, client, category, open_to_all, source)
      VALUES ('FORTIA-INT', 'Actividades internas Fortia', 'Fortia', 'interno', 1, 'manual')`).run();
    project = { id: Number(r.lastInsertRowid) };
  }
  const ins = db.prepare(`INSERT OR IGNORE INTO tasks (project_id, external_uid, name, category) VALUES (?, ?, ?, ?)`);
  for (const [uid, name, category] of INTERNAL_ACTIVITIES) ins.run(project.id, uid, name, category);

  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (!admins) {
    const email = process.env.ADMIN_EMAIL || 'admin@fortia.com.mx';
    const password = process.env.ADMIN_PASSWORD || randomBytes(9).toString('base64url');
    db.prepare(`INSERT INTO users (name, email, password_hash, role, tracks_time) VALUES ('Administrador', ?, ?, 'admin', 0)`)
      .run(email, hashPassword(password));
    if (!process.env.ADMIN_PASSWORD) log(`Usuario administrador creado: ${email} / ${password}  (cámbiala al entrar)`);
  }
}
