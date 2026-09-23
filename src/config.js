// Configuración de autenticación a partir de variables de entorno.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bool = (v, def) => (v == null || v === '' ? def : ['1', 'true', 'si', 'sí', 'yes'].includes(String(v).toLowerCase()));

export function loadAuthConfig(env = process.env) {
  const tenantId = env.ENTRA_TENANT_ID?.trim();
  const clientId = env.ENTRA_CLIENT_ID?.trim();
  const clientSecret = env.ENTRA_CLIENT_SECRET?.trim();
  const baseUrl = env.APP_BASE_URL?.trim().replace(/\/$/, '');
  const anyMicrosoft = tenantId || clientId || clientSecret;

  let microsoft = null;
  if (anyMicrosoft) {
    const missing = [['ENTRA_TENANT_ID', tenantId], ['ENTRA_CLIENT_ID', clientId], ['ENTRA_CLIENT_SECRET', clientSecret], ['APP_BASE_URL', baseUrl]]
      .filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`Configuración de Microsoft incompleta, faltan: ${missing.join(', ')}`);
    // Solo se acepta un tenant concreto: 'common' u 'organizations' abrirían el acceso a cualquier organización.
    if (!GUID.test(tenantId)) throw new Error('ENTRA_TENANT_ID debe ser el GUID del tenant de Fortia (no "common" ni "organizations")');
    microsoft = {
      tenantId: tenantId.toLowerCase(),
      clientId,
      clientSecret,
      authority: (env.ENTRA_AUTHORITY || 'https://login.microsoftonline.com').replace(/\/$/, ''),
      redirectUri: `${baseUrl}/auth/microsoft/callback`,
    };
  }

  const allowedDomains = (env.AUTH_ALLOWED_DOMAINS || 'fortia.com.mx')
    .split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);

  return {
    microsoft,
    allowedDomains,
    // Con Microsoft activo, la contraseña local queda apagada salvo que se habilite explícitamente
    // (p. ej. una cuenta de emergencia del administrador).
    localEnabled: bool(env.AUTH_LOCAL_ENABLED, !microsoft),
    autoProvision: bool(env.AUTH_AUTO_PROVISION, true),
    adminEmail: env.ADMIN_EMAIL?.trim().toLowerCase() || null,
  };
}

export function emailDomain(email) {
  const at = String(email || '').lastIndexOf('@');
  return at < 0 ? '' : String(email).slice(at + 1).toLowerCase();
}
