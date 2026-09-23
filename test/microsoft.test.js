// Prueba el inicio de sesión con Microsoft contra un proveedor OIDC simulado
// que se comporta como Entra ID (discovery, JWKS, token endpoint con PKCE).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ensureBaseData } from '../src/bootstrap.js';
import { loadAuthConfig } from '../src/config.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'client-timesheet';
const SECRET = 'secreto-de-prueba';

let idp, idpUrl, keys, rogueKeys;
const codes = new Map(); // code -> { nonce, challenge, claims, signWith }

async function startIdp() {
  keys = await generateKeyPair('RS256');
  rogueKeys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = createServer(async (req, res) => {
    const url = new URL(req.url, idpUrl);
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === `/${TENANT}/v2.0/.well-known/openid-configuration`) {
      return json(200, {
        issuer: `${idpUrl}/${TENANT}/v2.0`,
        authorization_endpoint: `${idpUrl}/${TENANT}/oauth2/v2.0/authorize`,
        token_endpoint: `${idpUrl}/${TENANT}/oauth2/v2.0/token`,
        jwks_uri: `${idpUrl}/${TENANT}/discovery/v2.0/keys`,
      });
    }
    if (url.pathname === `/${TENANT}/discovery/v2.0/keys`) return json(200, { keys: [jwk] });
    if (url.pathname === `/${TENANT}/oauth2/v2.0/token` && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const entry = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      if (!entry || form.get('client_secret') !== SECRET || form.get('client_id') !== CLIENT) return json(400, { error: 'invalid_grant' });
      const challenge = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      if (challenge !== entry.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      const idToken = await new SignJWT({ tid: TENANT, nonce: entry.nonce, ...entry.claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(entry.claims.iss || `${idpUrl}/${TENANT}/v2.0`)
        .setAudience(entry.claims.aud || CLIENT)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(entry.signWith === 'rogue' ? rogueKeys.privateKey : keys.privateKey);
      return json(200, { id_token: idToken, token_type: 'Bearer' });
    }
    json(404, {});
  });
  await new Promise((r) => idp.listen(0, '127.0.0.1', r));
  idpUrl = `http://127.0.0.1:${idp.address().port}`;
}

function makeApp({ autoProvision = true, local = false } = {}) {
  const auth = loadAuthConfig({
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: SECRET,
    APP_BASE_URL: 'http://localhost:3000', ENTRA_AUTHORITY: idpUrl,
    AUTH_AUTO_PROVISION: String(autoProvision), AUTH_LOCAL_ENABLED: String(local),
  });
  const db = openDb(':memory:');
  process.env.ADMIN_EMAIL = 'eduardo.diaz@fortia.com.mx';
  ensureBaseData(db, { auth, log: () => {} });
  delete process.env.ADMIN_EMAIL;
  return new Promise((resolve) => {
    const server = createApp(db, { auth }).listen(0, '127.0.0.1', () => resolve({ db, server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const cookieFrom = (res, name) => res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));

// Simula el viaje completo: /auth/microsoft/login → Microsoft → /auth/microsoft/callback.
async function signIn(base, claims, { next = '/#/semana', signWith, dropStateCookie = false, reuse } = {}) {
  const start = await fetch(`${base}/auth/microsoft/login?next=${encodeURIComponent(next)}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location'));
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://localhost:3000/auth/microsoft/callback');
  const state = authorize.searchParams.get('state');
  const stateCookie = cookieFrom(start, 'fortia_oidc');
  const code = randomUUID();
  codes.set(code, { nonce: authorize.searchParams.get('nonce'), challenge: authorize.searchParams.get('code_challenge'), claims, signWith });
  const cb = await fetch(`${base}/auth/microsoft/callback?code=${code}&state=${reuse || state}`, {
    redirect: 'manual', headers: dropStateCookie ? {} : { Cookie: stateCookie },
  });
  return { status: cb.status, location: cb.headers.get('location'), session: cookieFrom(cb, 'fortia_session'), state, stateCookie };
}

const fortian = (over = {}) => ({ oid: randomUUID(), name: 'Ana López', preferred_username: 'ana.lopez@fortia.com.mx', ...over });

before(startIdp);
after(() => idp.close());

test('la configuración exige un tenant concreto y datos completos', () => {
  assert.throws(() => loadAuthConfig({ ENTRA_TENANT_ID: 'common', ENTRA_CLIENT_ID: 'x', ENTRA_CLIENT_SECRET: 'y', APP_BASE_URL: 'https://t' }), /GUID/);
  assert.throws(() => loadAuthConfig({ ENTRA_TENANT_ID: TENANT }), /faltan/);
  const cfg = loadAuthConfig({ ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: 'x', ENTRA_CLIENT_SECRET: 'y', APP_BASE_URL: 'https://t/' });
  assert.equal(cfg.localEnabled, false, 'con Microsoft la contraseña local se apaga por defecto');
  assert.deepEqual(cfg.allowedDomains, ['fortia.com.mx']);
  assert.equal(cfg.microsoft.redirectUri, 'https://t/auth/microsoft/callback');
});

test('un consultor de Fortia entra, se da de alta solo y obtiene sesión', async () => {
  const { db, server, base } = await makeApp();
  try {
    const r = await signIn(base, fortian());
    assert.equal(r.status, 302);
    assert.equal(r.location, '/#/semana');
    assert.ok(r.session);
    const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: r.session } })).json();
    assert.equal(me.user.email, 'ana.lopez@fortia.com.mx');
    assert.equal(me.user.role, 'consultor');
    assert.equal(me.user.authProvider, 'microsoft');
    // Segundo inicio de sesión con el mismo oid no duplica al usuario.
    const oid = db.prepare("SELECT external_id FROM users WHERE email = 'ana.lopez@fortia.com.mx'").get().external_id;
    await signIn(base, fortian({ oid }));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'ana.lopez@fortia.com.mx'").get().n, 1);
    // La contraseña local está apagada.
    const local = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"a","password":"b"}' });
    assert.equal(local.status, 403);
    const cfg = await (await fetch(`${base}/api/auth/config`)).json();
    assert.deepEqual([cfg.microsoft, cfg.local], [true, false]);
  } finally { server.close(); }
});

test('el administrador inicial (ADMIN_EMAIL) se liga por correo y conserva su rol', async () => {
  const { db, server, base } = await makeApp();
  try {
    const r = await signIn(base, fortian({ name: 'Eduardo Díaz', preferred_username: 'Eduardo.Diaz@fortia.com.mx' }));
    const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: r.session } })).json();
    assert.equal(me.user.role, 'admin');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n, 1);
  } finally { server.close(); }
});

test('rechaza otros dominios, otros tenants, firmas falsas y tokens para otra app', async () => {
  const { db, server, base } = await makeApp();
  try {
    const cases = [
      [fortian({ preferred_username: 'alguien@gmail.com' }), 'dominio'],
      [fortian({ preferred_username: 'ana@fortia.com.mx.evil.com' }), 'dominio'],
      [fortian({ tid: '99999999-2222-3333-4444-555555555555' }), 'tenant'],
      [fortian({ aud: 'otra-app' }), 'fallo'],
      [fortian({ iss: 'https://login.microsoftonline.com/otro/v2.0' }), 'fallo'],
    ];
    for (const [claims, code] of cases) {
      const r = await signIn(base, claims);
      assert.equal(r.location, `/?login_error=${code}`, JSON.stringify(claims));
      assert.equal(r.session, undefined);
    }
    const forged = await signIn(base, fortian(), { signWith: 'rogue' });
    assert.equal(forged.location, '/?login_error=fallo');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE auth_provider = 'microsoft' AND role <> 'admin'").get().n, 0);
  } finally { server.close(); }
});

test('protege el state: sin cookie, reutilizado o redirección externa', async () => {
  const { server, base } = await makeApp();
  try {
    const noCookie = await signIn(base, fortian(), { dropStateCookie: true });
    assert.equal(noCookie.location, '/?login_error=expirado');

    const ok = await signIn(base, fortian());
    // Reusar el mismo state con su cookie no debe funcionar dos veces.
    const code = randomUUID();
    codes.set(code, { nonce: 'x', challenge: 'y', claims: fortian() });
    const replay = await fetch(`${base}/auth/microsoft/callback?code=${code}&state=${ok.state}`, { redirect: 'manual', headers: { Cookie: ok.stateCookie } });
    assert.equal(replay.headers.get('location'), '/?login_error=expirado');

    const evil = await signIn(base, fortian({ preferred_username: 'maria@fortia.com.mx' }), { next: '//evil.example.com' });
    assert.equal(evil.location, '/');
    const cancelled = await fetch(`${base}/auth/microsoft/callback?error=access_denied`, { redirect: 'manual' });
    assert.equal(cancelled.headers.get('location'), '/?login_error=cancelado');
  } finally { server.close(); }
});

test('sin alta automática solo entran usuarios registrados, y nunca los inactivos', async () => {
  const { db, server, base } = await makeApp({ autoProvision: false });
  try {
    assert.equal((await signIn(base, fortian())).location, '/?login_error=sin_alta');
    db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Carlos', 'carlos.ramirez@fortia.com.mx', '!')").run();
    const carlos = fortian({ preferred_username: 'carlos.ramirez@fortia.com.mx' });
    const r = await signIn(base, carlos);
    assert.equal(r.status, 302);
    assert.ok(r.session);
    db.prepare("UPDATE users SET active = 0 WHERE email = 'carlos.ramirez@fortia.com.mx'").run();
    const again = await signIn(base, carlos);
    assert.equal(again.location, '/?login_error=inactivo');
  } finally { server.close(); }
});

test('una cuenta de Microsoft recreada con el mismo correo no hereda el usuario hasta que el admin la desvincula', async () => {
  const { db, server, base } = await makeApp();
  try {
    await signIn(base, fortian());
    const recreated = await signIn(base, fortian()); // mismo correo, oid nuevo
    assert.equal(recreated.location, '/?login_error=vinculada');

    const admin = await signIn(base, fortian({ preferred_username: 'eduardo.diaz@fortia.com.mx' }));
    const ana = db.prepare("SELECT id FROM users WHERE email = 'ana.lopez@fortia.com.mx'").get();
    const put = await fetch(`${base}/api/users/${ana.id}`, {
      method: 'PUT', headers: { Cookie: admin.session, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ana López', email: 'ana.lopez@fortia.com.mx', role: 'consultor', unlinkMicrosoft: true }),
    });
    assert.equal(put.status, 200);
    const after = await signIn(base, fortian());
    assert.ok(after.session);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'ana.lopez@fortia.com.mx'").get().n, 1);
  } finally { server.close(); }
});
