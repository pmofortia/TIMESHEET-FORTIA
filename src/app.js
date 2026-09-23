import express from 'express';
import { fileURLToPath } from 'node:url';
import { CLOSED_STATUSES, PROJECT_STAGES, PROJECT_STATUSES, ROLES, ROLE_LABELS, weeklyHoursSetting } from './db.js';
import {
  COOKIE, authenticate, canReview, createSession, destroySession, hashPassword, requireRole,
  sessionToken, verifyPassword, visibleUserIds,
} from './auth.js';
import { addDays, isIsoDate, today, weekStart } from './dates.js';
import { parseMspdi } from './importers/mspdi.js';
import { parseTaskCsv } from './importers/csv.js';
import { applyPlan, plansFromCsv } from './services/plans.js';
import { ValidationError, loadWeek, normalizeWeek, reviewTimesheet, saveWeek, submitWeek } from './services/timesheets.js';
import { computeMetrics, entriesToCsv, entryRows } from './services/metrics.js';
import { emailDomain, loadAuthConfig } from './config.js';
import { LOGIN_ERRORS, createMicrosoftAuth } from './oidc.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

import { wrap } from './http.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerProjectRoutes } from './routes/projects.js';
import { canManageProject } from './services/access.js';

const publicUser = (u) => u && {
  id: u.id, name: u.name, email: u.email, role: u.role, weeklyCapacity: u.weekly_capacity,
  area: u.area, managerId: u.manager_id, active: u.active === undefined ? true : !!u.active,
  tracksTime: u.tracks_time === undefined ? true : !!u.tracks_time,
  linked: !!u.external_id,
  authProvider: u.auth_provider || 'local', lastLoginAt: u.last_login_at || null,
};

export function createApp(db, { secureCookies = process.env.NODE_ENV === 'production', auth: authConfig = loadAuthConfig() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Detrás de un proxy/App Service con HTTPS, para que las cookies Secure funcionen.
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
  app.use(express.json({ limit: '25mb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  // Protección CSRF: toda escritura a la API debe venir con JSON desde la propia app.
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Se esperaba application/json' });
    }
    next();
  });

  // ---------- Autenticación ----------
  app.get('/api/auth/config', wrap(() => ({
    microsoft: !!authConfig.microsoft,
    local: authConfig.localEnabled,
    domains: authConfig.allowedDomains,
    errors: { ...LOGIN_ERRORS, dominio: `Solo pueden entrar cuentas de ${authConfig.allowedDomains.map((d) => `@${d}`).join(', ')}.` },
  })));

  if (authConfig.microsoft) {
    const ms = createMicrosoftAuth(db, authConfig, { secureCookies });
    const asyncRoute = (fn) => (req, res, next) => fn(req, res).catch(next);
    app.get('/auth/microsoft/login', asyncRoute(ms.login));
    app.get('/auth/microsoft/callback', asyncRoute(ms.callback));
  }

  app.post('/api/auth/login', wrap((req, res) => {
    if (!authConfig.localEnabled) {
      res.status(403);
      return { error: 'El acceso con contraseña está deshabilitado; entra con tu cuenta de Microsoft 365' };
    }
    const { email, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(email || '').trim());
    if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
      res.status(401);
      return { error: 'Correo o contraseña incorrectos' };
    }
    const { token, maxAge } = createSession(db, user.id);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge, path: '/' });
    return { user: publicUser(user) };
  }));

  app.post('/api/auth/logout', wrap((req, res) => {
    const token = sessionToken(req);
    if (token) destroySession(db, token);
    res.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  }));

  const auth = authenticate(db);
  app.use('/api', (req, res, next) => (req.path.startsWith('/auth/') ? next() : auth(req, res, next)));

  app.get('/api/me', wrap((req) => ({
    user: publicUser(req.user),
    today: today(),
    roleLabels: ROLE_LABELS,
    statuses: PROJECT_STATUSES,
    closedStatuses: CLOSED_STATUSES,
    stages: PROJECT_STAGES,
    weeklyHours: weeklyHoursSetting(db),
  })));

  app.put('/api/me/password', wrap((req) => {
    if (!authConfig.localEnabled) throw new ValidationError('La contraseña se administra en Microsoft 365', 403);
    const { current, next: newPassword } = req.body || {};
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(current || ''), row.password_hash)) throw new ValidationError('La contraseña actual no coincide');
    if (String(newPassword || '').length < 8) throw new ValidationError('La nueva contraseña debe tener al menos 8 caracteres');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
    return { ok: true };
  }));

  // ---------- Timesheet propio ----------
  app.get('/api/timesheets/:week', wrap((req) => loadWeek(db, req.user.id, normalizeWeek(req.params.week))));

  app.put('/api/timesheets/:week', wrap((req) => {
    const week = normalizeWeek(req.params.week);
    saveWeek(db, req.user.id, week, req.body?.rows);
    return loadWeek(db, req.user.id, week);
  }));

  app.post('/api/timesheets/:week/submit', wrap((req) => {
    const week = normalizeWeek(req.params.week);
    if (Array.isArray(req.body?.rows)) saveWeek(db, req.user.id, week, req.body.rows);
    submitWeek(db, req.user.id, week);
    return loadWeek(db, req.user.id, week);
  }));

  // ---------- Aprobaciones ----------
  app.get('/api/approvals', requireRole('lider', 'admin'), wrap((req) => {
    const ids = visibleUserIds(db, req.user).filter((id) => req.user.role === 'admin' || id !== req.user.id);
    if (!ids.length) return { items: [] };
    const status = ['enviado', 'aprobado', 'rechazado', 'borrador'].includes(req.query.status) ? req.query.status : 'enviado';
    const items = db.prepare(`
      SELECT ts.id, ts.week_start AS week, ts.status, ts.submitted_at AS submittedAt, ts.review_comment AS reviewComment,
             u.id AS userId, u.name AS userName, u.weekly_capacity AS capacity,
             COALESCE((SELECT SUM(hours) FROM time_entries e WHERE e.timesheet_id = ts.id), 0) AS hours
      FROM timesheets ts JOIN users u ON u.id = ts.user_id
      WHERE ts.status = ? AND u.id IN (${ids.map(() => '?').join(',')})
      ORDER BY ts.week_start DESC, u.name LIMIT 500`).all(status, ...ids);
    return { items };
  }));

  app.get('/api/approvals/:id', requireRole('lider', 'admin'), wrap((req) => {
    const ts = db.prepare('SELECT * FROM timesheets WHERE id = ?').get(Number(req.params.id));
    if (!ts || !canReview(db, req.user, ts.user_id)) throw new ValidationError('Timesheet no encontrado', 404);
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(ts.user_id);
    return { user: publicUser(owner), ...loadWeek(db, ts.user_id, ts.week_start) };
  }));

  app.post('/api/approvals/:id', requireRole('lider', 'admin'), wrap((req) => {
    const id = Number(req.params.id);
    const ts = db.prepare('SELECT user_id FROM timesheets WHERE id = ?').get(id);
    if (!ts || !canReview(db, req.user, ts.user_id)) throw new ValidationError('Timesheet no encontrado', 404);
    return reviewTimesheet(db, req.user.id, id, req.body?.action, req.body?.comment);
  }));

  // ---------- Proyectos, catálogos y administración ----------
  registerProjectRoutes(app, db);
  registerAdminRoutes(app, db);

  // ---------- Importación desde Microsoft Project ----------
  const logImport = (summary, source, filename, userId) =>
    db.prepare('INSERT INTO import_log (project_id, user_id, source, filename, summary) VALUES (?, ?, ?, ?, ?)')
      .run(summary.project?.id ?? null, userId, source, filename || null, JSON.stringify(summary));

  // Con dryRun la importación corre completa dentro de una transacción que se revierte: es la vista previa exacta.
  const runImport = (dryRun, fn) => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
      return { dryRun, ...result };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  // Un gestor solo puede importar sobre proyectos que gestiona; si el plan crea un proyecto nuevo, queda como su gestor.
  const guardImport = (req, summary) => {
    if (summary.created) {
      if (req.user.role === 'lider') db.prepare('UPDATE projects SET pm_id = ? WHERE id = ?').run(req.user.id, summary.project.id);
    } else if (!canManageProject(db, req.user, summary.project.id)) {
      throw new ValidationError(`El proyecto "${summary.project.name}" ya existe y no eres su gestor`, 403);
    }
  };

  app.post('/api/import/msproject', requireRole('admin', 'lider'), wrap((req) => {
    const { xml, projectId, code, clientId, filename, dryRun = false } = req.body || {};
    if (!xml) throw new ValidationError('Adjunta el archivo XML exportado de Project');
    let plan;
    try { plan = parseMspdi(String(xml)); } catch (err) { throw new ValidationError(err.message); }
    return runImport(!!dryRun, () => {
      let summary;
      try {
        summary = applyPlan(db, { ...plan, code: code || null, clientId: clientId || null }, { projectId: projectId ? Number(projectId) : null, source: 'msproject' });
      } catch (err) { throw err instanceof ValidationError ? err : new ValidationError(err.message); }
      guardImport(req, summary);
      if (!dryRun) logImport(summary, 'msproject', filename, req.user.id);
      return { results: [summary] };
    });
  }));

  app.post('/api/import/csv', requireRole('admin', 'lider'), wrap((req) => {
    const { csv, filename, dryRun = false } = req.body || {};
    if (!csv) throw new ValidationError('Adjunta el archivo CSV');
    let parsed;
    try { parsed = parseTaskCsv(String(csv)); } catch (err) { throw new ValidationError(err.message); }
    return runImport(!!dryRun, () => {
      const results = plansFromCsv(parsed.items).map((plan) => {
        const summary = applyPlan(db, plan, { source: 'csv' });
        guardImport(req, summary);
        if (!dryRun) logImport(summary, 'csv', filename, req.user.id);
        return summary;
      });
      return { results, errors: parsed.errors };
    });
  }));

  app.get('/api/import/log', requireRole('admin', 'lider'), wrap(() => ({
    items: db.prepare(`SELECT l.id, l.source, l.filename, l.created_at AS createdAt, l.summary, u.name AS userName, p.name AS projectName
      FROM import_log l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN projects p ON p.id = l.project_id
      ORDER BY l.id DESC LIMIT 50`).all().map((r) => ({ ...r, summary: JSON.parse(r.summary || '{}') })),
  })));

  // ---------- Usuarios ----------
  app.get('/api/users', wrap((req) => {
    const ids = new Set(visibleUserIds(db, req.user));
    const all = db.prepare('SELECT * FROM users ORDER BY active DESC, name').all();
    return { items: all.filter((u) => ids.has(u.id)).map(publicUser) };
  }));

  const userInput = (b, isNew) => {
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError('Nombre y correo válido son obligatorios');
    const role = ROLES.includes(b.role) ? b.role : 'consultor';
    const cap = Number(b.weeklyCapacity ?? weeklyHoursSetting(db));
    if (!Number.isFinite(cap) || cap < 0 || cap > 80) throw new ValidationError('Capacidad semanal inválida');
    if (authConfig.microsoft && !authConfig.localEnabled && !authConfig.allowedDomains.includes(emailDomain(email))) {
      throw new ValidationError(`El correo debe ser de ${authConfig.allowedDomains.join(', ')} para poder entrar con Microsoft 365`);
    }
    if (isNew && authConfig.localEnabled && String(b.password || '').length < 8) {
      throw new ValidationError('La contraseña inicial debe tener al menos 8 caracteres');
    }
    return { name, email, role, cap, area: b.area || null, managerId: b.managerId ? Number(b.managerId) : null, active: b.active === false ? 0 : 1, tracksTime: b.tracksTime === false ? 0 : 1 };
  };

  app.post('/api/users', requireRole('admin'), wrap((req, res) => {
    const u = userInput(req.body || {}, true);
    try {
      const r = db.prepare('INSERT INTO users (name, email, password_hash, role, weekly_capacity, area, manager_id, tracks_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(u.name, u.email, authConfig.localEnabled ? hashPassword(req.body.password) : '!', u.role, u.cap, u.area, u.managerId, u.tracksTime);
      res.status(201);
      return { id: Number(r.lastInsertRowid) };
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new ValidationError('Ya existe un usuario con ese correo', 409);
      throw err;
    }
  }));

  app.put('/api/users/:id', requireRole('admin'), wrap((req) => {
    const id = Number(req.params.id);
    const u = userInput(req.body || {}, false);
    if (u.managerId === id) throw new ValidationError('Un usuario no puede ser su propio líder');
    const r = db.prepare('UPDATE users SET name = ?, email = ?, role = ?, weekly_capacity = ?, area = ?, manager_id = ?, active = ?, tracks_time = ? WHERE id = ?')
      .run(u.name, u.email, u.role, u.cap, u.area, u.managerId, u.active, u.tracksTime, id);
    if (!r.changes) throw new ValidationError('Usuario no encontrado', 404);
    if (req.body.password && authConfig.localEnabled) {
      if (String(req.body.password).length < 8) throw new ValidationError('La contraseña debe tener al menos 8 caracteres');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (!u.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    // Permite que el usuario vuelva a ligarse con otra cuenta de Microsoft 365 (cuenta recreada en Entra ID).
    if (req.body.unlinkMicrosoft) {
      db.prepare('UPDATE users SET external_id = NULL WHERE id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    return { ok: true };
  }));

  // ---------- Indicadores ----------
  const metricsQuery = (req) => {
    const to = isIsoDate(req.query.to) ? req.query.to : today();
    const from = isIsoDate(req.query.from) ? req.query.from : weekStart(addDays(to, -27));
    if (from > to) throw new ValidationError('El rango de fechas es inválido');
    let userIds = visibleUserIds(db, req.user);
    if (req.query.userId) {
      const wanted = Number(req.query.userId);
      if (!userIds.includes(wanted)) throw new ValidationError('No tienes acceso a ese consultor', 403);
      userIds = [wanted];
    }
    return {
      from, to, userIds,
      projectId: req.query.projectId ? Number(req.query.projectId) : null,
      clientId: req.query.clientId ? Number(req.query.clientId) : null,
      includeDrafts: req.query.includeDrafts === '1' || req.query.includeDrafts === 'true',
    };
  };

  app.get('/api/metrics', wrap((req) => computeMetrics(db, metricsQuery(req))));

  app.get('/api/metrics/export.csv', (req, res, next) => {
    try {
      const q = metricsQuery(req);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="horas_${q.from}_${q.to}.csv"`);
      res.send(entriesToCsv(entryRows(db, q)));
    } catch (err) { next(err); }
  });

  // ---------- Frontend ----------
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '5m' }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'El archivo es demasiado grande (máx. 25 MB)' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  return app;
}
