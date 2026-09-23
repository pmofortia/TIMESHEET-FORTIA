// Inicio de sesión con Microsoft 365 (Entra ID) vía OpenID Connect:
// flujo "authorization code" con PKCE, restringido al tenant de Fortia y a
// los dominios de correo permitidos.
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { COOKIE, createSession } from './auth.js';
import { emailDomain } from './config.js';

const STATE_COOKIE = 'fortia_oidc';
const REQUEST_TTL_MS = 10 * 60 * 1000;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export class LoginError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

// Mensajes que ve el usuario en la pantalla de inicio.
export const LOGIN_ERRORS = {
  dominio: 'Solo pueden entrar cuentas de Fortia (@fortia.com.mx).',
  tenant: 'La cuenta no pertenece a la organización de Fortia.',
  sin_alta: 'Tu cuenta aún no está dada de alta en el sistema. Pide acceso al administrador.',
  inactivo: 'Tu usuario está desactivado. Contacta al administrador.',
  vinculada: 'Tu correo ya está ligado a otra cuenta de Microsoft. Pide al administrador que desvincule el acceso anterior.',
  expirado: 'El inicio de sesión tardó demasiado o se abrió en otra pestaña. Inténtalo de nuevo.',
  cancelado: 'Se canceló el inicio de sesión con Microsoft.',
  fallo: 'No se pudo validar el inicio de sesión con Microsoft. Inténtalo de nuevo.',
};

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Solo rutas relativas de la propia app (evita redirecciones abiertas).
export function safeReturnTo(value) {
  const s = String(value || '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/';
}

export function createMicrosoftAuth(db, authConfig, { secureCookies }) {
  const ms = authConfig.microsoft;
  let discovery = null;
  let jwks = null;

  async function getDiscovery() {
    if (discovery) return discovery;
    const url = `${ms.authority}/${ms.tenantId}/v2.0/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo leer la configuración OIDC de Microsoft (${res.status})`);
    discovery = await res.json();
    jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    return discovery;
  }

  const purge = db.prepare('DELETE FROM oidc_requests WHERE created_at < ?');
  const saveRequest = db.prepare('INSERT INTO oidc_requests (state, nonce, verifier, return_to, created_at) VALUES (?, ?, ?, ?, ?)');
  const takeRequest = db.prepare('DELETE FROM oidc_requests WHERE state = ? RETURNING *');

  async function login(req, res) {
    const d = await getDiscovery();
    purge.run(new Date(Date.now() - REQUEST_TTL_MS).toISOString());
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(48));
    saveRequest.run(state, nonce, verifier, safeReturnTo(req.query.next), new Date().toISOString());
    // La cookie liga el "state" al navegador que inició el login (evita CSRF de inicio de sesión).
    res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: REQUEST_TTL_MS, path: '/auth/microsoft' });
    const params = new URLSearchParams({
      client_id: ms.clientId,
      response_type: 'code',
      redirect_uri: ms.redirectUri,
      response_mode: 'query',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    res.redirect(`${d.authorization_endpoint}?${params}`);
  }

  async function exchangeCode(code, verifier) {
    const d = await getDiscovery();
    const res = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: ms.clientId,
        client_secret: ms.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: ms.redirectUri,
        code_verifier: verifier,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id_token) throw new LoginError('fallo', `Intercambio de código rechazado: ${body.error || res.status} ${body.error_description || ''}`);
    return body.id_token;
  }

  async function verifyIdToken(idToken, nonce) {
    const d = await getDiscovery();
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, jwks, {
        issuer: d.issuer.replace('{tenantid}', ms.tenantId),
        audience: ms.clientId,
        algorithms: ['RS256'],
        clockTolerance: 60,
      }));
    } catch (err) {
      throw new LoginError('fallo', `id_token inválido: ${err.message}`);
    }
    if (payload.nonce !== nonce) throw new LoginError('fallo', 'nonce no coincide');
    if (String(payload.tid || '').toLowerCase() !== ms.tenantId) throw new LoginError('tenant', `tid ${payload.tid}`);
    if (!payload.oid) throw new LoginError('fallo', 'El token no trae oid');
    return payload;
  }

  // Busca o crea el usuario local correspondiente a la cuenta de Microsoft.
  function resolveUser(claims) {
    const email = String(claims.email || claims.preferred_username || claims.upn || '').trim().toLowerCase();
    if (!authConfig.allowedDomains.includes(emailDomain(email))) throw new LoginError('dominio', `Dominio no permitido: ${email}`);
    const name = String(claims.name || email.split('@')[0]).trim();
    const now = new Date().toISOString();

    let user = db.prepare('SELECT * FROM users WHERE external_id = ?').get(claims.oid);
    if (!user) {
      // Primer inicio de sesión de un usuario dado de alta por el admin (o importado): se liga por correo.
      user = db.prepare('SELECT * FROM users WHERE email = ? AND external_id IS NULL').get(email);
      if (user) db.prepare("UPDATE users SET external_id = ?, auth_provider = 'microsoft' WHERE id = ?").run(claims.oid, user.id);
    }
    if (user) {
      if (!user.active) throw new LoginError('inactivo');
      // Si el correo cambió en Microsoft (p. ej. cambio de apellido) se actualiza; el oid es el identificador estable.
      if (user.email.toLowerCase() !== email && !db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(email, user.id)) {
        db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, user.id);
      }
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);
      return user.id;
    }
    // Mismo correo pero otra cuenta de Microsoft (oid distinto): no se re-vincula sola, para que
    // una cuenta recreada o reasignada no herede el historial de otra persona.
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new LoginError('vinculada', `${email} ya ligado a otro oid`);
    if (!authConfig.autoProvision) throw new LoginError('sin_alta', email);
    const r = db.prepare(`INSERT INTO users (name, email, password_hash, role, auth_provider, external_id, last_login_at)
      VALUES (?, ?, '!', 'consultor', 'microsoft', ?, ?)`).run(name, email, claims.oid, now);
    return Number(r.lastInsertRowid);
  }

  async function callback(req, res) {
    const fail = (code, detail) => {
      if (code === 'fallo' || detail) console.warn(`[login microsoft] ${code}: ${detail || ''}`);
      res.clearCookie(STATE_COOKIE, { path: '/auth/microsoft' });
      res.redirect(`/?login_error=${encodeURIComponent(code)}`);
    };
    try {
      const { code, state, error, error_description: desc } = req.query;
      if (error) return fail(error === 'access_denied' ? 'cancelado' : 'fallo', `${error}: ${desc || ''}`);
      const cookieState = readCookie(req, STATE_COOKIE);
      if (!state || !code || state !== cookieState) return fail('expirado', 'state ausente o distinto a la cookie');
      const pending = takeRequest.get(String(state));
      if (!pending || Date.now() - Date.parse(pending.created_at) > REQUEST_TTL_MS) return fail('expirado', 'state desconocido o vencido');

      const idToken = await exchangeCode(String(code), pending.verifier);
      const claims = await verifyIdToken(idToken, pending.nonce);
      const userId = resolveUser(claims);

      const session = createSession(db, userId);
      res.clearCookie(STATE_COOKIE, { path: '/auth/microsoft' });
      res.cookie(COOKIE, session.token, { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: session.maxAge, path: '/' });
      res.redirect(safeReturnTo(pending.return_to));
    } catch (err) {
      if (err instanceof LoginError) return fail(err.code, err.message);
      return fail('fallo', err.message);
    }
  }

  return { login, callback };
}
