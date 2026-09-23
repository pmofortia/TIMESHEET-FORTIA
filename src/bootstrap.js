import { randomBytes } from 'node:crypto';
import { hashPassword } from './auth.js';
import { DEFAULT_ADMIN_TASKS, DEFAULT_MODULES, INTERNAL_PROJECT_CODE } from './db.js';

// Datos mínimos para operar. Los catálogos iniciales solo se cargan la primera vez:
// después los administra el usuario desde "Administración" (si borra uno, no reaparece).
export function ensureBaseData(db, { log = console.log, auth = { microsoft: null, localEnabled: true } } = {}) {
  let project = db.prepare('SELECT id FROM projects WHERE is_internal = 1').get();
  if (!project) {
    const r = db.prepare(`INSERT INTO projects (code, name, status, is_internal, source)
      VALUES (?, 'Tareas administrativas', 'Activo', 1, 'manual')`).run(INTERNAL_PROJECT_CODE);
    project = { id: Number(r.lastInsertRowid) };
    const ins = db.prepare('INSERT INTO tasks (project_id, external_uid, name, reduces_availability) VALUES (?, ?, ?, ?)');
    DEFAULT_ADMIN_TASKS.forEach(([name, reduces], i) => ins.run(project.id, `admin:${i + 1}`, name, reduces));
  }
  if (!db.prepare('SELECT COUNT(*) AS n FROM modules').get().n) {
    const ins = db.prepare('INSERT INTO modules (code, name) VALUES (?, ?)');
    for (const [code, name] of DEFAULT_MODULES) ins.run(code, name);
  }

  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (!admins && !auth.localEnabled) {
    // Solo Microsoft 365: el admin inicial se liga a su cuenta en su primer inicio de sesión.
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    if (!email) throw new Error('Define ADMIN_EMAIL con el correo @fortia.com.mx de quien administrará el sistema');
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
    else {
      db.prepare(`INSERT INTO users (name, email, password_hash, role, tracks_time, auth_provider) VALUES (?, ?, '!', 'admin', 0, 'microsoft')`)
        .run(email.split('@')[0], email);
    }
    log(`Administrador inicial: ${email} (entra con Microsoft 365)`);
  } else if (!admins) {
    const email = process.env.ADMIN_EMAIL || 'admin@fortia.com.mx';
    const password = process.env.ADMIN_PASSWORD || randomBytes(9).toString('base64url');
    db.prepare(`INSERT INTO users (name, email, password_hash, role, tracks_time) VALUES ('Administrador', ?, ?, 'admin', 0)`)
      .run(email, hashPassword(password));
    if (!process.env.ADMIN_PASSWORD) log(`Usuario administrador creado: ${email} / ${password}  (cámbiala al entrar)`);
  }
}
