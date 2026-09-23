import { openDb } from './db.js';
import { createApp } from './app.js';
import { ensureBaseData } from './bootstrap.js';

const db = openDb();
ensureBaseData(db);
const port = Number(process.env.PORT || 3000);
createApp(db).listen(port, () => {
  console.log(`Timesheet Fortia escuchando en http://localhost:${port}`);
});
