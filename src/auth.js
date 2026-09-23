import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 7;
export const COOKIE = 'fortia_session';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, maxAge: SESSION_DAYS * 864e5 };
}

export function destroySession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionToken(req) {
  return readCookie(req, COOKIE);
}

export function authenticate(db) {
  const stmt = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.weekly_capacity, u.area, u.manager_id
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`);
  return (req, res, next) => {
    const token = sessionToken(req);
    const user = token ? stmt.get(token, new Date().toISOString()) : null;
    if (!user) return res.status(401).json({ error: 'Sesión no válida o expirada' });
    req.user = { ...user };
    next();
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'No tienes permiso para esta acción' });
    next();
  };
}

// Usuarios cuya información puede ver alguien: admin ve todo, un líder ve
// a sus reportes directos y a sí mismo, un consultor solo a sí mismo.
export function visibleUserIds(db, user) {
  if (user.role === 'admin') return db.prepare('SELECT id FROM users').all().map((r) => r.id);
  if (user.role === 'lider') {
    const ids = db.prepare('SELECT id FROM users WHERE manager_id = ?').all(user.id).map((r) => r.id);
    return [user.id, ...ids];
  }
  return [user.id];
}

export function canReview(db, reviewer, ownerId) {
  if (reviewer.role === 'admin') return true;
  if (reviewer.role !== 'lider' || reviewer.id === ownerId) return false;
  const row = db.prepare('SELECT manager_id FROM users WHERE id = ?').get(ownerId);
  return row?.manager_id === reviewer.id;
}
