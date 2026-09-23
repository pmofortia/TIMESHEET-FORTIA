import { openDb } from './db.js';
import { createApp } from './app.js';
import { ensureBaseData } from './bootstrap.js';
import { loadAuthConfig } from './config.js';

const auth = loadAuthConfig();
const db = openDb();
ensureBaseData(db, { auth });
const port = Number(process.env.PORT || 3000);
createApp(db, { auth }).listen(port, () => {
  const modes = [auth.microsoft && 'Microsoft 365', auth.localEnabled && 'contraseña local'].filter(Boolean).join(' + ');
  console.log(`Timesheet Fortia escuchando en http://localhost:${port} (acceso: ${modes}; dominios: ${auth.allowedDomains.join(', ')})`);
});
