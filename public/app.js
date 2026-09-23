// Timesheet Fortia — SPA sin dependencias ni paso de build.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { me: null, meta: {}, today: null, dirty: false, pending: 0, auth: { microsoft: false, local: true, errors: {} } };

// ---------- Utilidades ----------
const nf = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });
const fmtH = (n) => `${nf.format(n || 0)} h`;
const pct = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);
const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const parseD = (s) => new Date(`${s}T00:00:00Z`);
const isoD = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = parseD(s); d.setUTCDate(d.getUTCDate() + n); return isoD(d); };
const weekStart = (s) => { const d = parseD(s); return addDays(s, -((d.getUTCDay() + 6) % 7)); };
const fmtDay = (s) => { const d = parseD(s); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const fmtDate = (s) => (s ? `${fmtDay(s)} ${s.slice(0, 4)}` : '—');
const dow = (s) => DAYS[parseD(s).getUTCDay()];
// Tipos de hora: proyecto (facturable), administrativa que descuenta disponibilidad y otra administrativa.
const KINDS = {
  project: { label: 'Proyectos', color: 'var(--kind-project)' },
  deduct: { label: 'Administrativo que descuenta disponibilidad', short: 'Adm. (descuenta)', color: 'var(--kind-deduct)' },
  admin: { label: 'Otro administrativo', short: 'Adm. (otro)', color: 'var(--kind-admin)' },
};
const rowKind = (r) => (r.isAdmin ? (r.reducesAvailability ? 'deduct' : 'admin') : 'project');
const dot = (kind) => `<span class="cat-dot" style="background:${KINDS[kind].color}"></span>`;
const roleLabel = (r) => state.meta.roleLabels?.[r] || r;
const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const statusBadge = (s) => `<span class="status ${esc(s.replace(' ', '-'))}">${esc(s[0].toUpperCase() + s.slice(1))}</span>`;
const isManager = () => ['lider', 'admin'].includes(state.me?.role);

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    credentials: 'same-origin',
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  // Sesión vencida a media operación: regresar al login (en el arranque lo resuelve boot()).
  if (res.status === 401 && state.me && path !== '/auth/login') {
    state.me = null;
    renderLogin();
    throw new Error('Tu sesión expiró');
  }
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = error ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 5000 : 2500);
}
const fail = (err) => toast(err.message, true);

// Tooltip compartido: cualquier elemento con data-tip (HTML ya escapado).
document.addEventListener('pointermove', (e) => {
  const tip = $('#tooltip');
  const target = e.target.closest?.('[data-tip]');
  if (!target) { tip.hidden = true; return; }
  tip.innerHTML = target.dataset.tip;
  tip.hidden = false;
  const { innerWidth: w } = window;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX + 14, w - r.width - 8)}px`;
  tip.style.top = `${Math.max(e.clientY - r.height - 12, 8)}px`;
});

// ---------- Arranque ----------
async function boot() {
  try {
    state.auth = await api('GET', '/auth/config');
  } catch { /* se usa la configuración por defecto */ }
  try {
    const data = await api('GET', '/me');
    Object.assign(state, { me: data.user, meta: data, today: data.today });
    renderShell();
    route();
  } catch {
    renderLogin();
  }
}

const MS_LOGO = '<svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true"><rect width="10" height="10" fill="#f25022"/><rect x="11" width="10" height="10" fill="#7fba00"/><rect y="11" width="10" height="10" fill="#00a4ef"/><rect x="11" y="11" width="10" height="10" fill="#ffb900"/></svg>';

// El callback de Microsoft regresa con ?login_error=<código>; se lee una vez y se limpia la URL.
let initialLoginError = new URLSearchParams(location.search).get('login_error');
if (initialLoginError) history.replaceState(null, '', location.pathname + location.hash);

function renderLogin() {
  const code = initialLoginError;
  initialLoginError = null; // solo se muestra una vez
  const message = code ? state.auth.errors?.[code] || 'No se pudo iniciar sesión.' : '';
  const next = encodeURIComponent(`/${location.hash || ''}`);
  const { microsoft, local } = state.auth;
  $('#app').innerHTML = `
    <div class="login"><div class="card">
      <h1>Timesheet Fortia</h1>
      <p class="muted">Registro semanal de horas por proyecto</p>
      ${message ? `<div class="notice" role="alert" style="margin-top:14px">${esc(message)}</div>` : ''}
      ${microsoft ? `<a class="btn ms-btn" href="/auth/microsoft/login?next=${next}">${MS_LOGO}Iniciar sesión con Microsoft 365</a>
        <p class="small muted" style="margin-top:8px">Usa tu cuenta ${esc((state.auth.domains || []).map((d) => `@${d}`).join(', '))}</p>` : ''}
      ${local ? `
      ${microsoft ? '<p class="small muted divider">o con contraseña local</p>' : ''}
      <form id="login-form">
        <label class="field">Correo<input name="email" type="email" autocomplete="username" required ${microsoft ? '' : 'autofocus'}></label>
        <label class="field">Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="${microsoft ? '' : 'primary'}" type="submit">Entrar</button>
        <p class="small muted" id="login-error" role="alert"></p>
      </form>` : ''}
    </div></div>`;
  $('#login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', '/auth/login', { email: f.get('email'), password: f.get('password') });
      boot();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });
}

const NAV = [
  { href: '#/semana', label: 'Mi semana', match: 'semana' },
  { href: '#/aprobaciones', label: 'Aprobaciones', match: 'aprobaciones', manager: true, badge: true },
  { href: '#/indicadores', label: 'Indicadores', match: 'indicadores' },
  { href: '#/proyectos', label: 'Proyectos', match: 'proyectos' },
  { href: '#/importar', label: 'Importar de Project', match: 'importar', manager: true },
  { href: '#/administracion', label: 'Administración', match: 'administracion', admin: true },
  { href: '#/usuarios', label: 'Usuarios', match: 'usuarios', admin: true },
];

function renderShell() {

  $('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="rgba(255,255,255,.16)"/><path d="M16 7v9l6 4" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></svg>
          <div>Fortia<small>Timesheet</small></div></div>
        <nav class="nav" aria-label="Principal">
          ${NAV.filter((n) => (!n.manager || isManager()) && (!n.admin || state.me.role === 'admin'))
            .map((n) => `<a href="${n.href}" data-match="${n.match}">${n.label}${n.badge ? '<span class="badge-count hidden" id="pending-badge"></span>' : ''}</a>`).join('')}
        </nav>
        <div class="me"><b>${esc(state.me.name)}</b><span>${esc(roleLabel(state.me.role))}</span>
          <div class="row">${state.auth.local && state.me.authProvider !== 'microsoft' ? '<button id="btn-password" type="button">Contraseña</button>' : ''}<button id="btn-logout" type="button">Salir</button></div></div>
      </aside>
      <main class="main" id="main"></main>
    </div>`;
  $('#btn-logout').onclick = async () => { await api('POST', '/auth/logout').catch(() => {}); state.me = null; location.hash = ''; renderLogin(); };
  if ($('#btn-password')) $('#btn-password').onclick = openPasswordDialog;
  refreshPending();
}

async function refreshPending() {
  if (!isManager()) return;
  try {
    const { items } = await api('GET', '/approvals?status=enviado');
    const b = $('#pending-badge');
    if (b) { b.textContent = items.length; b.classList.toggle('hidden', !items.length); }
  } catch { /* sin permiso o sin red: no bloquea */ }
}

window.addEventListener('hashchange', () => { if (state.me) route(); });
window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

let lastHash = location.hash;
function route() {
  if (state.dirty && location.hash !== lastHash && !confirm('Tienes horas sin guardar. ¿Salir de todos modos?')) {
    history.replaceState(null, '', lastHash);
    return;
  }
  state.dirty = false;
  lastHash = location.hash;
  const path = location.hash.replace(/^#\/?/, '').split('?')[0];
  const [first, arg] = path.split('/');
  const section = first || 'semana';
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.match === section));
  const main = $('#main');
  main.innerHTML = '<p class="muted">Cargando…</p>';
  const views = {
    semana: () => viewWeek(arg),
    aprobaciones: () => (arg ? viewReview(arg) : viewApprovals()),
    indicadores: viewMetrics,
    proyectos: () => (arg ? viewProject(arg) : viewProjects()),
    importar: viewImport,
    administracion: () => viewAdmin(arg),
    usuarios: viewUsers,
  };
  (views[section] || views.semana)().catch((err) => { main.innerHTML = `<div class="notice">${esc(err.message)}</div>`; });
}

// ---------- Grid semanal (compartido entre captura y revisión) ----------
function gridHtml(sheet, editable) {
  const { days, rows } = sheet;
  const holiday = Object.fromEntries((sheet.holidays || []).map((h) => [h.date, h.name]));
  const byDay = Object.fromEntries(days.map((d) => [d, 0]));
  let grand = 0;
  const body = rows.map((r) => {
    let total = 0;
    const cells = days.map((d) => {
      const h = Number(r.hours[d] || 0);
      total += h; byDay[d] += h;
      return `<td class="day ${holiday[d] ? 'holiday' : ''}"><input class="h" type="number" inputmode="decimal" min="0" max="24" step="0.25"
        data-task="${r.taskId}" data-date="${d}" value="${h || ''}" aria-label="${esc(r.taskName)} ${dow(d)} ${fmtDay(d)}" ${editable ? '' : 'disabled'}></td>`;
    }).join('');
    grand += total;
    const planned = r.plannedHours != null ? ` · plan ${fmtH(r.plannedHours)} · acumulado ${fmtH(r.loggedToDate)}` : '';
    const dates = r.start ? ` · ${fmtDay(r.start)} – ${fmtDate(r.finish)}` : '';
    const over = r.plannedHours && r.loggedToDate > r.plannedHours;
    const kind = rowKind(r);
    const where = r.isAdmin
      ? `Tarea administrativa${r.reducesAvailability ? ' · descuenta disponibilidad' : ''}`
      : `${esc(r.projectCode)} · ${esc(r.projectName)}${r.parentPath ? ` › ${esc(r.parentPath)}` : ''}`;
    return `<tr data-row="${r.taskId}">
      <td class="task">
        <div class="task-name">${dot(kind)}${esc(r.taskName)}</div>
        <div class="task-meta">${where}</div>
        ${r.isAdmin ? '' : `<div class="task-meta ${over ? 'over' : ''}">${r.moduleCode ? `Módulo ${esc(r.moduleCode)}` : 'Sin módulo'}${dates}${planned}${over ? ' · excede lo planeado' : ''}${r.assigned ? '' : ' · no asignada en Project'}</div>`}
        ${editable ? `<input class="note" data-note="${r.taskId}" placeholder="Nota (opcional)" maxlength="500" value="${esc(r.note)}">` : r.note ? `<div class="task-meta">“${esc(r.note)}”</div>` : ''}
      </td>
      ${cells}
      <td class="num total" data-rowtotal="${r.taskId}">${nf.format(total)}</td>
      ${editable ? `<td><button class="ghost small" type="button" data-remove="${r.taskId}" aria-label="Quitar renglón" title="Quitar renglón">✕</button></td>` : ''}
    </tr>`;
  }).join('');
  return `
    <div class="table-wrap"><table class="ts-table">
      <thead><tr><th>Proyecto / tarea</th>
        ${days.map((d) => `<th class="day ${holiday[d] ? 'holiday' : ''}" ${holiday[d] ? `data-tip="<b>Día festivo</b>${esc(holiday[d])}"` : ''}>${dow(d)}<span class="date">${fmtDay(d)}</span>${holiday[d] ? '<span class="date hol">Festivo</span>' : ''}</th>`).join('')}
        <th class="num">Total</th>${editable ? '<th></th>' : ''}</tr></thead>
      <tbody>${body || `<tr><td colspan="${days.length + 3}" class="muted">No tienes tareas asignadas en esta semana. Agrega una actividad abajo.</td></tr>`}</tbody>
      <tfoot><tr><td>Total del día</td>
        ${days.map((d) => `<td class="num day ${byDay[d] > 24 ? 'over' : ''}" data-daytotal="${d}">${nf.format(byDay[d])}</td>`).join('')}
        <td class="num" id="grand-total">${nf.format(grand)}</td>${editable ? '<td></td>' : ''}</tr></tfoot>
    </table></div>`;
}

function collectRows(sheet) {
  return sheet.rows.map((r) => ({ taskId: r.taskId, hours: { ...r.hours }, note: r.note || '' }));
}

// ---------- Mi semana ----------
async function viewWeek(arg) {
  const week = weekStart(arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : state.today);
  const sheet = await api('GET', `/timesheets/${week}`);
  renderWeek(sheet);
}

function renderWeek(sheet) {
  const main = $('#main');
  const editable = ['borrador', 'rechazado'].includes(sheet.timesheet.status);
  const total = () => sheet.rows.reduce((s, r) => s + Object.values(r.hours).reduce((a, b) => a + Number(b || 0), 0), 0);
  const groups = {};
  for (const t of sheet.available) (groups[t.isAdmin ? 'Tareas administrativas' : `${t.projectCode} · ${t.projectName}`] ||= []).push(t);

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Semana del ${fmtDay(sheet.days[0])} al ${fmtDate(sheet.days.at(-1))}</h1>
        <div class="sub">Horas a cubrir: <b>${fmtH(sheet.required)}</b>${sheet.holidays.length ? ` (${fmtH(sheet.capacity)} − ${sheet.holidays.length} festivo${sheet.holidays.length > 1 ? 's' : ''}: ${sheet.holidays.map((h) => esc(h.name)).join(', ')})` : ''} · ${statusBadge(sheet.timesheet.status)}</div></div>
      <div class="row">
        <a class="btn" href="#/semana/${sheet.prevWeek}" aria-label="Semana anterior">← Anterior</a>
        <a class="btn" href="#/semana/${weekStart(state.today)}">Hoy</a>
        <a class="btn" href="#/semana/${sheet.nextWeek}" aria-label="Semana siguiente">Siguiente →</a>
        <input type="date" id="jump" value="${sheet.week}" aria-label="Ir a fecha">
      </div>
    </div>
    ${sheet.timesheet.status === 'rechazado' ? `<div class="notice"><b>Tu gestor rechazó este timesheet.</b> ${esc(sheet.timesheet.reviewComment || '')}</div>` : ''}
    ${sheet.timesheet.status === 'enviado' ? '<div class="notice info">Enviado a aprobación. Si necesitas corregirlo, pide a tu gestor que lo reabra.</div>' : ''}
    <div class="card">
      <div id="grid">${gridHtml(sheet, editable)}</div>
      ${editable ? `
      <div class="row" style="margin-top:14px">
        <select id="add-task" aria-label="Agregar actividad">
          <option value="">+ Agregar actividad…</option>
          ${Object.entries(groups).map(([g, ts]) => `<optgroup label="${esc(g)}">${ts.map((t) =>
            `<option value="${t.taskId}">${esc(t.taskName)}${t.isAdmin || t.assigned ? '' : ' (no asignada)'}</option>`).join('')}</optgroup>`).join('')}
        </select>
        <button type="button" id="copy-prev">Copiar tareas de la semana anterior</button>
        <span class="spacer"></span>
        <span class="muted" id="cap-hint"></span>
        <button type="button" id="save">Guardar borrador</button>
        <button type="button" class="primary" id="submit">Enviar a aprobación</button>
      </div>` : ''}
    </div>
    <p class="small muted">La semana va de lunes a viernes. Se precargan las tareas que Project te asigna en estas fechas; con
      "Agregar actividad" puedes sumar otras tareas de los proyectos a los que tienes acceso o una tarea administrativa.</p>`;

  $('#jump').onchange = (e) => { if (e.target.value) location.hash = `#/semana/${weekStart(e.target.value)}`; };
  if (!editable) return;

  const updateHint = () => {
    const t = total();
    const hint = $('#cap-hint');
    hint.textContent = `${fmtH(t)} de ${fmtH(sheet.required)}`;
    hint.className = t + 0.01 < sheet.required ? 'muted' : t > sheet.required + 0.01 ? 'over' : 'ok';
  };
  updateHint();

  const grid = $('#grid');
  grid.addEventListener('input', (e) => {
    const t = e.target;
    const row = sheet.rows.find((r) => r.taskId === Number(t.dataset.task || t.dataset.note));
    if (!row) return;
    state.dirty = true;
    if (t.dataset.note) { row.note = t.value; return; }
    const v = t.value === '' ? 0 : Number(t.value);
    if (v) row.hours[t.dataset.date] = v; else delete row.hours[t.dataset.date];
    const rowTotal = Object.values(row.hours).reduce((a, b) => a + Number(b), 0);
    $(`[data-rowtotal="${row.taskId}"]`).textContent = nf.format(rowTotal);
    const dayTotal = sheet.rows.reduce((s, r) => s + Number(r.hours[t.dataset.date] || 0), 0);
    const cell = $(`[data-daytotal="${t.dataset.date}"]`);
    cell.textContent = nf.format(dayTotal);
    cell.classList.toggle('over', dayTotal > 24);
    $('#grand-total').textContent = nf.format(total());
    updateHint();
  });
  grid.addEventListener('click', (e) => {
    const id = Number(e.target.dataset.remove);
    if (!id) return;
    const idx = sheet.rows.findIndex((r) => r.taskId === id);
    const [row] = sheet.rows.splice(idx, 1);
    sheet.available.push(row);
    state.dirty = true;
    renderWeekKeepDirty(sheet);
  });
  $('#add-task').onchange = (e) => {
    const id = Number(e.target.value);
    const idx = sheet.available.findIndex((t) => t.taskId === id);
    if (idx < 0) return;
    const [t] = sheet.available.splice(idx, 1);
    sheet.rows.push({ ...t, hours: {}, note: '' });
    renderWeekKeepDirty(sheet);
  };
  $('#copy-prev').onclick = async () => {
    try {
      const prev = await api('GET', `/timesheets/${sheet.prevWeek}`);
      const withHours = prev.rows.filter((r) => Object.keys(r.hours).length);
      let added = 0;
      for (const r of withHours) {
        const idx = sheet.available.findIndex((t) => t.taskId === r.taskId);
        if (idx >= 0) { const [t] = sheet.available.splice(idx, 1); sheet.rows.push({ ...t, hours: {}, note: '' }); added++; }
      }
      toast(added ? `Se agregaron ${added} tareas` : 'No hay tareas nuevas que copiar');
      if (added) renderWeekKeepDirty(sheet);
    } catch (err) { fail(err); }
  };
  $('#save').onclick = async () => {
    try {
      const fresh = await api('PUT', `/timesheets/${sheet.week}`, { rows: collectRows(sheet) });
      state.dirty = false;
      toast('Borrador guardado');
      renderWeek(fresh);
    } catch (err) { fail(err); }
  };
  $('#submit').onclick = async () => {
    const t = total();
    if (!t) return toast('Captura al menos una hora antes de enviar', true);
    if (t + 0.01 < sheet.required && !confirm(`Registraste ${fmtH(t)} de las ${fmtH(sheet.required)} que debes cubrir esta semana. ¿Enviar de todos modos?`)) return;
    try {
      const fresh = await api('POST', `/timesheets/${sheet.week}/submit`, { rows: collectRows(sheet) });
      state.dirty = false;
      toast('Timesheet enviado a aprobación');
      renderWeek(fresh);
    } catch (err) { fail(err); }
  };
}

function renderWeekKeepDirty(sheet) {
  renderWeek(sheet);
  state.dirty = true;
}

// ---------- Aprobaciones ----------
async function viewApprovals() {
  const status = new URLSearchParams(location.hash.split('?')[1] || '').get('estatus') || 'enviado';
  const { items } = await api('GET', `/approvals?status=${status}`);
  const tabs = ['enviado', 'aprobado', 'rechazado', 'borrador'];
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>Aprobaciones</h1><div class="sub">Timesheets de tu equipo</div></div>
      <div class="row">${tabs.map((t) => `<a class="btn" href="#/aprobaciones?estatus=${t}" ${t === status ? 'style="font-weight:700;border-color:var(--accent)"' : ''}>${t[0].toUpperCase() + t.slice(1)}</a>`).join('')}</div></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Consultor</th><th>Semana</th><th class="num">Horas</th><th class="num">Capacidad</th><th>Estatus</th><th>Enviado</th><th></th></tr></thead>
      <tbody>${items.map((i) => `<tr>
        <td>${esc(i.userName)}</td><td>${fmtDay(i.week)} – ${fmtDate(addDays(i.week, 6))}</td>
        <td class="num">${fmtH(i.hours)}</td><td class="num">${fmtH(i.capacity)}</td>
        <td>${statusBadge(i.status)}</td><td class="small muted">${i.submittedAt ? esc(i.submittedAt.slice(0, 16)) : '—'}</td>
        <td><a class="btn" href="#/aprobaciones/${i.id}">Revisar</a></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No hay timesheets en este estatus.</td></tr>'}
      </tbody></table></div></div>`;
}

async function viewReview(id) {
  const data = await api('GET', `/approvals/${Number(id)}`);
  const s = data.timesheet.status;
  const total = data.rows.reduce((a, r) => a + Object.values(r.hours).reduce((x, y) => x + y, 0), 0);
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>${esc(data.user.name)}</h1>
      <div class="sub">Semana del ${fmtDay(data.days[0])} al ${fmtDate(data.days.at(-1))} · ${fmtH(total)} de ${fmtH(data.required)} requeridas · ${statusBadge(s)}</div></div>
      <a class="btn" href="#/aprobaciones">← Volver</a></div>
    ${data.timesheet.reviewComment ? `<div class="notice info">Comentario: ${esc(data.timesheet.reviewComment)}</div>` : ''}
    <div class="card">${gridHtml({ ...data, rows: data.rows.filter((r) => Object.keys(r.hours).length) }, false)}
      <div class="row" style="margin-top:14px">
        <input id="comment" placeholder="Comentario (obligatorio para rechazar)" style="flex:1;min-width:220px" maxlength="1000">
        ${s === 'enviado' ? '<button class="primary" data-action="aprobar">Aprobar</button>' : ''}
        ${['enviado', 'aprobado'].includes(s) ? '<button class="danger" data-action="rechazar">Rechazar</button>' : ''}
        ${s !== 'borrador' ? '<button data-action="reabrir">Reabrir para edición</button>' : ''}
      </div></div>`;
  $$('[data-action]').forEach((b) => { b.onclick = async () => {
    try {
      await api('POST', `/approvals/${Number(id)}`, { action: b.dataset.action, comment: $('#comment').value });
      toast('Listo');
      refreshPending();
      location.hash = '#/aprobaciones';
    } catch (err) { fail(err); }
  }; });
}

// ---------- Indicadores ----------
function barsH(items, { max, target, format = fmtH, width = 560 } = {}) {
  const labelW = 150, valueW = 64, rowH = 30, barH = 16;
  const plotW = width - labelW - valueW;
  const top = Math.max(max ?? 0, ...items.map((i) => i.value), target ?? 0) || 1;
  const x = (v) => labelW + (v / top) * plotW;
  const h = items.length * rowH + 8;
  const rows = items.map((it, i) => {
    const y = i * rowH + 4;
    const w = Math.max((it.value / top) * plotW, it.value > 0 ? 2 : 0);
    const r = Math.min(4, w / 2);
    // Esquinas redondeadas solo en el extremo del dato.
    const path = w > 0 ? `M${labelW},${y + (rowH - barH) / 2}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${barH - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z` : '';
    return `<g data-tip="${it.tip}">
      <rect class="hit" x="0" y="${y}" width="${width}" height="${rowH}"/>
      <text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(it.label.length > 22 ? `${it.label.slice(0, 21)}…` : it.label)}</text>
      ${path ? `<path class="mark" d="${path}" fill="${it.color}"/>` : ''}
      <text class="val" x="${labelW + w + 6}" y="${y + rowH / 2 + 4}">${esc(format(it.value))}</text></g>`;
  }).join('');
  const t = target != null ? `<line class="target" x1="${x(target)}" x2="${x(target)}" y1="0" y2="${h}"/><text x="${x(target) + 4}" y="${h + 12}">Meta ${pct(target)}</text>` : '';
  return `<svg class="chart" viewBox="0 0 ${width} ${h + (target != null ? 16 : 0)}" role="img">
    <line class="baseline" x1="${labelW}" x2="${labelW}" y1="0" y2="${h}"/>${rows}${t}</svg>`;
}

function stackedColumns(weekly, series, { width = 1000, height = 260 } = {}) {
  const left = 40, bottom = 26, top = 10;
  const plotH = height - bottom - top;
  const totals = weekly.map((w) => series.reduce((s, c) => s + w[c], 0));
  const maxV = Math.max(...totals, 1);
  const step = maxV > 160 ? 40 : maxV > 80 ? 20 : 10;
  const yMax = Math.ceil(maxV / step) * step;
  const y = (v) => top + plotH - (v / yMax) * plotH;
  const slot = (width - left) / Math.max(weekly.length, 1);
  const barW = Math.min(44, slot * 0.6);
  const ticks = [];
  for (let v = 0; v <= yMax; v += step) ticks.push(`<line class="gridline" x1="${left}" x2="${width}" y1="${y(v)}" y2="${y(v)}"/><text x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  const cols = weekly.map((w, i) => {
    const x = left + i * slot + (slot - barW) / 2;
    let acc = 0;
    const segs = series.filter((c) => w[c] > 0);
    const rects = segs.map((c, j) => {
      const y0 = y(acc), y1 = y(acc + w[c]);
      acc += w[c];
      const hgt = Math.max(y0 - y1 - (j < segs.length - 1 ? 2 : 0), 1); // 2px de separación entre segmentos
      const r = j === segs.length - 1 ? Math.min(4, hgt / 2, barW / 2) : 0;
      const d = `M${x},${y0}v-${hgt - r}${r ? `a${r},${r} 0 0 1 ${r},-${r}h${barW - 2 * r}a${r},${r} 0 0 1 ${r},${r}` : `h${barW}`}v${hgt - r}z`;
      return `<path class="mark" d="${d}" fill="${KINDS[c].color}" data-tip="<b>Semana ${fmtDay(w.week)}</b>${esc(KINDS[c].label)}: ${fmtH(w[c])}<br>Total semana: ${fmtH(totals[i])}"/>`;
    }).join('');
    return `${rects}<text x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${fmtDay(w.week)}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Horas por semana">
    ${ticks.join('')}<line class="baseline" x1="${left}" x2="${width}" y1="${y(0)}" y2="${y(0)}"/>${cols}</svg>`;
}

const legend = (kinds) => `<div class="legend">${kinds.map((k) => `<span>${dot(k)}${esc(KINDS[k].label)}</span>`).join('')}</div>`;

function presetRange(key) {
  const t = state.today;
  const d = parseD(t);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const monthStart = (yy, mm) => isoD(new Date(Date.UTC(yy, mm, 1)));
  switch (key) {
    case 'mes': return [monthStart(y, m), t];
    case 'mes-anterior': return [monthStart(y, m - 1), addDays(monthStart(y, m), -1)];
    case 'trimestre': return [monthStart(y, Math.floor(m / 3) * 3), t];
    case 'anio': return [`${y}-01-01`, t];
    default: return [weekStart(addDays(t, -27)), t];
  }
}

let catalogsCache = null;
async function catalogs(force = false) {
  if (!catalogsCache || force) catalogsCache = await api('GET', '/catalogs');
  return catalogsCache;
}

async function viewMetrics() {
  const [users, projects, cats] = await Promise.all([api('GET', '/users'), api('GET', '/projects'), catalogs(true)]);
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const [dFrom, dTo] = presetRange('4s');
  const q = {
    from: params.get('from') || dFrom, to: params.get('to') || dTo, userId: params.get('userId') || '',
    projectId: params.get('projectId') || '', clientId: params.get('clientId') || '', includeDrafts: params.get('includeDrafts') || '',
  };
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  const m = await api('GET', `/metrics?${qs}`);
  const k = m.kpis;
  const tracked = users.items.filter((u) => u.active && u.tracksTime);
  const kinds = ['project', 'deduct', 'admin'];
  const byKind = {
    project: k.projectHours,
    deduct: m.adminTasks.filter((t) => t.reducesAvailability).reduce((a, t) => a + t.hours, 0),
    admin: m.adminTasks.filter((t) => !t.reducesAvailability).reduce((a, t) => a + t.hours, 0),
  };
  const share = (h) => pct(k.hours ? h / k.hours : 0);
  const effMax = Math.max(1, ...m.people.map((u) => u.efficiency || 0));

  $('#main').innerHTML = `
    <div class="page-head"><div><h1>Indicadores</h1><div class="sub">${fmtDate(m.range.from)} – ${fmtDate(m.range.to)} · ${m.range.weekdays} días hábiles
      ${m.range.holidays.length ? ` · ${m.range.holidays.length} festivo(s)` : ''} · ${m.range.includeDrafts ? 'incluye borradores' : 'solo timesheets enviados y aprobados'}</div></div>
      <a class="btn" href="/api/metrics/export.csv?${qs}">Exportar detalle CSV</a></div>
    <form class="filters" id="filters">
      <label class="field">Periodo<select name="preset"><option value="">Personalizado</option><option value="4s">Últimas 4 semanas</option>
        <option value="mes">Este mes</option><option value="mes-anterior">Mes anterior</option><option value="trimestre">Este trimestre</option><option value="anio">Este año</option></select></label>
      <label class="field">Desde<input type="date" name="from" value="${q.from}"></label>
      <label class="field">Hasta<input type="date" name="to" value="${q.to}"></label>
      ${tracked.length > 1 ? `<label class="field">Consultor<select name="userId"><option value="">Todos</option>
        ${tracked.map((u) => `<option value="${u.id}" ${String(u.id) === q.userId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>` : ''}
      <label class="field">Cliente<select name="clientId"><option value="">Todos</option>
        ${cats.clients.map((c) => `<option value="${c.id}" ${String(c.id) === q.clientId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field">Proyecto<select name="projectId"><option value="">Todos</option>
        ${projects.items.map((p) => `<option value="${p.id}" ${String(p.id) === q.projectId ? 'selected' : ''}>${esc(p.code)} · ${esc(p.name)}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="includeDrafts" value="1" ${q.includeDrafts ? 'checked' : ''}> Incluir borradores</label>
      <button class="primary" type="submit">Aplicar</button>
    </form>

    <div class="kpis">
      <div class="kpi"><div class="label">Eficiencia</div><div class="value">${pct(k.efficiency)}</div>
        <div class="hint">Facturables / disponibilidad · meta ${pct(m.target)}</div></div>
      <div class="kpi"><div class="label">Carga a proyectos</div><div class="value">${nf.format(k.projectHours)} h</div>
        <div class="hint">${share(k.projectHours)} de lo registrado</div></div>
      <div class="kpi"><div class="label">Carga administrativa</div><div class="value">${nf.format(k.adminHours)} h</div>
        <div class="hint">${share(k.adminHours)} de lo registrado</div></div>
      <div class="kpi"><div class="label">Disponibilidad</div><div class="value">${nf.format(k.availability)} h</div>
        <div class="hint">de ${nf.format(k.capacity)} h de capacidad · ${k.consultants} consultores</div></div>
      <div class="kpi"><div class="label">Horas sin registrar</div><div class="value">${nf.format(k.unregistered)} h</div>
        <div class="hint">Cumplimiento de timesheet ${pct(k.compliance)}</div></div>
    </div>

    <div class="grid-2">
      <div class="card"><h2>Carga a proyectos vs. administrativa</h2>
        ${barsH(kinds.map((kd) => ({ label: KINDS[kd].short || KINDS[kd].label, value: byKind[kd], color: KINDS[kd].color,
          tip: `<b>${esc(KINDS[kd].label)}</b>${fmtH(byKind[kd])} · ${share(byKind[kd])} del total` })))}
        <p class="small muted">"Descuenta disponibilidad": las tareas administrativas marcadas así en Administración (vacaciones y permisos, capacitación, etc.).</p>
      </div>
      <div class="card"><h2>Eficiencia por consultor</h2>
        ${m.people.length ? barsH(m.people.map((u) => ({ label: u.name, value: u.efficiency || 0, color: KINDS.project.color,
          tip: `<b>${esc(u.name)}</b>Eficiencia ${pct(u.efficiency)}<br>${fmtH(u.projectHours)} facturables de ${fmtH(u.availability)} disponibles<br>Sin registrar: ${fmtH(u.unregistered)}` })),
          { max: effMax, target: m.target, format: (v) => pct(v) }) : '<p class="muted">Sin consultores en el filtro.</p>'}
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h2>Tendencia semanal</h2>${legend(kinds)}${stackedColumns(m.weekly, kinds)}
      <details class="table-view"><summary>Ver como tabla</summary><div class="table-wrap"><table>
        <thead><tr><th>Semana</th>${kinds.map((kd) => `<th class="num">${esc(KINDS[kd].short || KINDS[kd].label)}</th>`).join('')}</tr></thead>
        <tbody>${m.weekly.map((w) => `<tr><td>${fmtDate(w.week)}</td>${kinds.map((kd) => `<td class="num">${nf.format(w[kd])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div></details>
    </div>

    <div class="grid-2">
      <div class="card"><h2>Horas por tarea administrativa</h2>
        ${m.adminTasks.length ? barsH(m.adminTasks.map((t) => ({ label: t.name, value: t.hours, color: KINDS[t.reducesAvailability ? 'deduct' : 'admin'].color,
          tip: `<b>${esc(t.name)}</b>${fmtH(t.hours)}${t.reducesAvailability ? '<br>Descuenta disponibilidad' : ''}` }))) : '<p class="muted">Sin horas administrativas.</p>'}
      </div>
      <div class="card"><h2>Horas de proyecto por módulo</h2>
        ${m.modules.length ? barsH(m.modules.map((x) => ({ label: x.code ? `${x.code} · ${x.name}` : x.name, value: x.hours, color: KINDS.project.color,
          tip: `<b>${esc(x.name)}</b>${fmtH(x.hours)}` }))) : '<p class="muted">Sin horas de proyecto.</p>'}
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h2>Detalle por consultor</h2><div class="table-wrap"><table>
      <thead><tr><th>Consultor</th><th class="num">Capacidad</th><th class="num">Festivos</th><th class="num">Descuentos</th><th class="num">Disponibilidad</th>
        <th class="num">${dot('project')}Proyectos</th><th class="num">Administrativo</th><th class="num">Sin registrar</th><th class="num">Eficiencia</th></tr></thead>
      <tbody>${m.people.map((u) => `<tr><td>${esc(u.name)}<div class="small muted">${esc(u.area || '')}</div></td>
        <td class="num">${nf.format(u.capacity)}</td><td class="num">${nf.format(u.holidayHours)}</td><td class="num">${nf.format(u.deductHours)}</td>
        <td class="num"><b>${nf.format(u.availability)}</b></td><td class="num">${nf.format(u.projectHours)}</td><td class="num">${nf.format(u.adminHours)}</td>
        <td class="num">${nf.format(u.unregistered)}</td><td class="num"><b>${pct(u.efficiency)}</b></td></tr>`).join('')}</tbody>
    </table></div>
    <p class="small muted">Disponibilidad = capacidad − festivos − horas en tareas administrativas que descuentan disponibilidad. Eficiencia = horas en proyectos / disponibilidad.</p></div>

    <div class="card"><h2>Proyectos: vendido vs. real</h2><div class="table-wrap"><table>
      <thead><tr><th>Proyecto</th><th>Estatus</th><th class="num">Horas en periodo</th><th class="num">Real acumulado</th><th class="num">Planeado (Project)</th><th class="num">Vendidas</th><th>Consumo de lo vendido</th></tr></thead>
      <tbody>${m.projects.map((p) => `<tr><td><a href="#/proyectos/${p.id}"><b>${esc(p.code)}</b></a> · ${esc(p.name)}<div class="small muted">${esc(p.client || 'Sin cliente')}</div></td>
        <td class="small">${esc(p.status || '')}${p.stage ? `<div class="muted">${esc(p.stage)}</div>` : ''}</td>
        <td class="num">${nf.format(p.hours)}</td><td class="num">${nf.format(p.actualToDate)}</td><td class="num">${p.planned ? nf.format(p.planned) : '—'}</td>
        <td class="num">${p.sold != null ? nf.format(p.sold) : '—'}</td>
        <td>${p.consumedSold != null ? `${pct(p.consumedSold)}<div class="progress ${p.consumedSold > 1 ? 'over' : ''}"><span style="width:${Math.min(p.consumedSold, 1) * 100}%"></span></div>` : '<span class="muted">sin horas vendidas</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin horas de proyecto en el periodo.</td></tr>'}</tbody>
    </table></div></div>

    <div class="card"><h2>Cumplimiento semanal</h2>
      ${m.compliance.weeks.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Consultor</th>${m.compliance.weeks.map((w) => `<th>${fmtDay(w)}</th>`).join('')}<th class="num">Cumplimiento</th></tr></thead>
        <tbody>${m.compliance.rows.map((r) => `<tr><td>${esc(r.name)}</td>${r.weeks.map((st) => `<td>${statusBadge(st)}</td>`).join('')}
          <td class="num">${r.done}/${r.expected}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Aún no hay semanas cerradas en el periodo.</p>'}
    </div>`;

  const form = $('#filters');
  form.preset.onchange = () => {
    if (!form.preset.value) return;
    const [f, t] = presetRange(form.preset.value);
    form.from.value = f; form.to.value = t;
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    fd.delete('preset');
    location.hash = `#/indicadores?${new URLSearchParams([...fd.entries()].filter(([, v]) => v))}`;
  };
}

// ---------- Proyectos ----------
const optionList = (items, selected, { value = (x) => x.id, label = (x) => x.name, empty } = {}) =>
  `${empty !== undefined ? `<option value="">${esc(empty)}</option>` : ''}${items.map((x) =>
    `<option value="${esc(value(x))}" ${String(value(x)) === String(selected ?? '') ? 'selected' : ''}>${esc(label(x))}</option>`).join('')}`;

async function viewProjects() {
  const { items } = await api('GET', '/projects');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const status = params.get('estatus') || '';
  const shown = status ? items.filter((p) => p.status === status) : items;
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>Proyectos</h1><div class="sub">${state.me.role === 'admin' ? 'Todos los proyectos' : 'Proyectos a los que tienes acceso'}</div></div>
      <div class="row">
        <select id="status-filter" aria-label="Filtrar por estatus">${optionList(state.meta.statuses.map((x) => ({ id: x, name: x })), status, { empty: 'Todos los estatus' })}</select>
        ${isManager() ? '<a class="btn" href="#/importar">Importar de Project</a><button class="primary" id="new-project">Nuevo proyecto</button>' : ''}
      </div></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Código</th><th>Proyecto</th><th>Cliente</th><th>Gestor</th><th>Estatus / etapa</th><th>Módulos</th><th class="num">Vendidas</th><th class="num">Real</th><th>Consumo</th></tr></thead>
      <tbody>${shown.map((p) => {
        const c = p.soldHours ? p.actual / p.soldHours : null;
        return `<tr><td><a href="#/proyectos/${p.id}"><b>${esc(p.code)}</b></a></td><td>${esc(p.name)}</td>
        <td>${esc(p.clientName || '—')}</td><td>${esc(p.pmName || '—')}</td>
        <td class="small">${esc(p.status)}${p.stage ? `<div class="muted">${esc(p.stage)}</div>` : ''}</td>
        <td class="small">${esc(p.moduleCodes || '—')}</td>
        <td class="num">${p.soldHours != null ? nf.format(p.soldHours) : '—'}</td><td class="num">${nf.format(p.actual)}</td>
        <td>${c != null ? `${pct(c)}<div class="progress ${c > 1 ? 'over' : ''}"><span style="width:${Math.min(c, 1) * 100}%"></span></div>` : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="9" class="muted">No tienes proyectos asignados. Pide acceso al gestor del proyecto.</td></tr>'}</tbody>
    </table></div></div>`;
  $('#status-filter').onchange = (e) => { location.hash = e.target.value ? `#/proyectos?estatus=${encodeURIComponent(e.target.value)}` : '#/proyectos'; };
  if ($('#new-project')) $('#new-project').onclick = () => projectDialog();
}

async function projectDialog(p = {}, currentModules = []) {
  const cats = await catalogs(true);
  const selectedModules = new Set(currentModules.map((m) => m.id));
  const lockPm = !!p.id && state.me.role !== 'admin';
  const dlg = document.createElement('dialog');
  dlg.className = 'wide';
  dlg.innerHTML = `<form method="dialog" id="pform"><h2>${p.id ? 'Editar proyecto' : 'Nuevo proyecto'}</h2>
    <div class="form-grid">
      <label class="field">Código<input name="code" required maxlength="30" value="${esc(p.code || '')}"></label>
      <label class="field" style="grid-column:span 2">Nombre del proyecto<input name="name" required value="${esc(p.name || '')}"></label>
      <label class="field">Cliente<select name="clientId">${optionList(cats.clients, p.clientId, { empty: '— Selecciona —' })}</select></label>
      <label class="field">Ejecutivo comercial<input name="salesExec" value="${esc(p.salesExec || '')}"></label>
      <label class="field">Gestor de proyecto<select name="pmId" ${lockPm ? 'disabled' : ''}>${optionList(cats.managers, p.pmId ?? (state.me.role === 'lider' ? state.me.id : ''), { empty: '—' })}</select></label>
      <label class="field">Estatus<select name="status">${optionList(cats.statuses.map((x) => ({ id: x, name: x })), p.status || 'Por asignar')}</select></label>
      <label class="field">Etapa<select name="stage">${optionList(cats.stages.map((x) => ({ id: x, name: x })), p.stage, { empty: '—' })}</select></label>
      <label class="field">Horas vendidas<input name="soldHours" type="number" min="0" step="0.5" value="${p.soldHours ?? ''}"></label>
      <label class="field">Presupuesto (USD)<input name="budgetUsd" type="number" min="0" step="0.01" value="${p.budgetUsd ?? ''}"></label>
    </div>
    <fieldset class="modules"><legend>Módulos</legend>
      ${cats.modules.map((m) => `<label class="check"><input type="checkbox" name="moduleIds" value="${m.id}" ${selectedModules.has(m.id) ? 'checked' : ''}> ${esc(m.code)} · ${esc(m.name)}</label>`).join('')}
    </fieldset>
    ${lockPm ? '<p class="small muted">Solo un administrador puede cambiar al gestor del proyecto.</p>' : ''}
    <p class="small muted" id="perror" role="alert"></p>
    <div class="row"><span class="spacer"></span><button value="cancel" formnovalidate>Cancelar</button><button class="primary" value="ok">Guardar</button></div></form>`;
  document.body.append(dlg);
  const form = $('#pform', dlg);
  form.clientId.onchange = () => {
    const c = cats.clients.find((x) => String(x.id) === form.clientId.value);
    if (c && !form.salesExec.value) form.salesExec.value = c.salesExec || '';
  };
  form.onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const f = new FormData(form);
    const body = {
      code: f.get('code'), name: f.get('name'), clientId: f.get('clientId') ? Number(f.get('clientId')) : null,
      salesExec: f.get('salesExec'), pmId: lockPm ? p.pmId : (f.get('pmId') ? Number(f.get('pmId')) : null),
      status: f.get('status'), stage: f.get('stage') || null, soldHours: f.get('soldHours'), budgetUsd: f.get('budgetUsd'),
      moduleIds: f.getAll('moduleIds').map(Number),
    };
    try {
      const r = await api(p.id ? 'PUT' : 'POST', p.id ? `/projects/${p.id}` : '/projects', body);
      dlg.close();
      toast('Proyecto guardado');
      if (!p.id && r.id) location.hash = `#/proyectos/${r.id}`; else route();
    } catch (err) { $('#perror', dlg).textContent = err.message; }
  };
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

async function viewProject(id) {
  const [detail, { items: tasks }, cats] = await Promise.all([api('GET', `/projects/${Number(id)}`), api('GET', `/projects/${Number(id)}/tasks`), catalogs(true)]);
  const { project: p, modules, members, resources } = detail;
  const can = p.canManage;
  const memberIds = new Set(members.map((m) => m.id));
  const field = (label, value) => `<div><div class="small muted">${label}</div><div>${value || '—'}</div></div>`;
  const consumed = p.soldHours ? p.actual / p.soldHours : null;

  $('#main').innerHTML = `
    <div class="page-head"><div><h1>${esc(p.code)} · ${esc(p.name)}</h1>
      <div class="sub">${esc(p.clientName || 'Sin cliente')} · ${esc(p.status)}${p.stage ? ` · ${esc(p.stage)}` : ''}</div></div>
      <div class="row"><a class="btn" href="#/proyectos">← Proyectos</a>${can ? '<button class="primary" id="edit">Editar ficha</button>' : ''}</div></div>

    <div class="card"><h2>Ficha del proyecto</h2><div class="facts">
      ${field('Cliente', esc(p.clientName))}${field('Ejecutivo comercial', esc(p.salesExec))}${field('Gestor de proyecto', esc(p.pmName))}
      ${field('Estatus', esc(p.status))}${field('Etapa', esc(p.stage))}${field('Presupuesto', p.budgetUsd != null ? money.format(p.budgetUsd) : '')}
      ${field('Horas vendidas', p.soldHours != null ? fmtH(p.soldHours) : '')}${field('Horas planeadas (Project)', fmtH(p.planned))}
      ${field('Horas reales', `${fmtH(p.actual)}${consumed != null ? ` · ${pct(consumed)} de lo vendido` : ''}`)}
      ${field('Módulos', modules.map((m) => `<span class="chip">${esc(m.code)}</span>`).join(' '))}
    </div></div>

    ${resources.length ? `<div class="card"><h2>Recursos del plan de Project</h2>
      <p class="small muted">Cada recurso del XML se cubre con un usuario activo. Al cambiarlo, sus tareas pasan al nuevo usuario y este obtiene acceso al proyecto.
        Las reimportaciones respetan el reemplazo.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Recurso en Project</th><th>Correo en Project</th><th class="num">Tareas</th><th class="num">Horas plan</th><th>Lo cubre</th></tr></thead>
        <tbody>${resources.map((r) => `<tr><td>${esc(r.name)}</td><td class="small">${esc(r.email || '—')}</td><td class="num">${r.tasks}</td><td class="num">${nf.format(r.planned)}</td>
          <td>${can ? `<select data-resource="${r.id}" aria-label="Usuario que cubre ${esc(r.name)}">${optionList(cats.users, r.userId, { empty: '— Sin asignar —' })}</select>`
            : esc(r.userName || 'Sin asignar')}${!r.userId ? ' <span class="over small">sin usuario</span>' : ''}</td></tr>`).join('')}</tbody>
      </table></div></div>` : ''}

    <div class="card"><h2>Acceso al proyecto</h2>
      <p class="small muted">Solo estos usuarios ven el proyecto y pueden registrar horas en sus tareas (además del gestor y los administradores).</p>
      ${can ? `<div class="member-grid">${cats.users.filter((u) => u.role !== 'admin').map((u) => `<label class="check"><input type="checkbox" name="member" value="${u.id}" ${memberIds.has(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>`).join('')}</div>
        <div class="row" style="margin-top:10px"><span class="spacer"></span><button id="save-members">Guardar acceso</button></div>`
        : members.map((m) => `<span class="chip">${esc(m.name)}</span>`).join(' ') || '<p class="muted">Sin usuarios.</p>'}
    </div>

    <div class="card"><h2>Tareas</h2><div class="table-wrap"><table>
      <thead><tr><th>WBS</th><th>Tarea</th><th>Inicio</th><th>Fin</th><th>Módulo</th><th>Recursos</th><th class="num">Plan</th><th class="num">Real</th><th>Avance</th></tr></thead>
      <tbody>${tasks.map((t) => {
        const c = t.planned ? t.actual / t.planned : null;
        const moduleCell = t.isSummary ? '' : can && modules.length
          ? `<select data-task-module="${t.id}" aria-label="Módulo de ${esc(t.name)}">${optionList(modules, t.moduleId, { label: (m) => m.code, empty: '—' })}</select>`
          : esc(t.moduleCode || '—');
        return `<tr style="${t.active ? '' : 'opacity:.5'}${t.isSummary ? ';font-weight:600' : ''}">
        <td class="small muted">${esc(t.wbs || '')}</td>
        <td style="padding-left:${10 + Math.max(t.level - 1, 0) * 14}px">${esc(t.name)}${t.active ? '' : ' <span class="small">(ya no está en el plan)</span>'}${t.manual ? ' <span class="small muted">(manual)</span>' : ''}</td>
        <td class="small nowrap">${t.start ? fmtDate(t.start) : '—'}</td><td class="small nowrap">${t.finish ? fmtDate(t.finish) : '—'}</td>
        <td>${moduleCell}</td><td class="small">${esc(t.resources || '')}</td>
        <td class="num">${t.isSummary ? '' : nf.format(t.planned)}</td><td class="num">${t.isSummary ? '' : nf.format(t.actual)}</td>
        <td>${!t.isSummary && c != null ? `<div class="progress ${c > 1 ? 'over' : ''}"><span style="width:${Math.min(c, 1) * 100}%"></span></div>` : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="9" class="muted">Sin tareas. Importa el plan desde Project o agrega tareas manualmente.</td></tr>'}</tbody>
    </table></div>
    ${can && !modules.length ? '<p class="small muted">Asigna módulos en la ficha del proyecto para poder clasificar sus tareas.</p>' : ''}</div>

    ${can ? `<div class="card"><h2>Agregar tarea manual</h2>
      <form id="tform" class="form-grid">
        <label class="field">Nombre<input name="name" required></label>
        <label class="field">Inicio<input name="start" type="date"></label>
        <label class="field">Fin<input name="finish" type="date"></label>
        <label class="field">Horas planeadas<input name="planned" type="number" min="0" step="0.5"></label>
        <label class="field">Módulo<select name="moduleId">${optionList(modules, '', { label: (m) => `${m.code} · ${m.name}`, empty: '—' })}</select></label>
        <label class="field">Asignar a<select name="userIds" multiple size="4">${optionList(cats.users.filter((u) => u.role !== 'admin'), '')}</select></label>
        <button class="primary" type="submit">Agregar</button>
      </form>
      <p class="small muted">Si el proyecto viene de Project, lo recomendable es mantener el plan allá y reimportar.</p>
    </div>` : ''}`;

  if (!can) return;
  $('#edit').onclick = () => projectDialog(p, modules);
  $$('[data-resource]').forEach((sel) => { sel.onchange = async () => {
    try {
      await api('PUT', `/projects/${p.id}/resources/${sel.dataset.resource}`, { userId: sel.value ? Number(sel.value) : null });
      toast('Recurso reasignado');
      route();
    } catch (err) { fail(err); }
  }; });
  $$('[data-task-module]').forEach((sel) => { sel.onchange = async () => {
    try { await api('PUT', `/tasks/${sel.dataset.taskModule}`, { moduleId: sel.value ? Number(sel.value) : null }); toast('Módulo actualizado'); } catch (err) { fail(err); }
  }; });
  $('#save-members').onclick = async () => {
    try {
      await api('PUT', `/projects/${p.id}/members`, { userIds: $$('input[name=member]:checked').map((i) => Number(i.value)) });
      toast('Acceso actualizado');
      route();
    } catch (err) { fail(err); }
  };
  $('#tform').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', `/projects/${p.id}/tasks`, {
        name: f.get('name'), start: f.get('start') || null, finish: f.get('finish') || null, planned: f.get('planned'),
        moduleId: f.get('moduleId') ? Number(f.get('moduleId')) : null, userIds: f.getAll('userIds').map(Number),
      });
      toast('Tarea agregada');
      route();
    } catch (err) { fail(err); }
  };
}

// ---------- Administración ----------
const ADMIN_TABS = [
  ['tareas', 'Tareas administrativas'], ['festivos', 'Días festivos'], ['clientes', 'Clientes'], ['modulos', 'Módulos'], ['ajustes', 'Ajustes'],
];

async function viewAdmin(arg) {
  const tab = ADMIN_TABS.some(([k]) => k === arg) ? arg : 'tareas';
  const main = $('#main');
  main.innerHTML = `
    <div class="page-head"><div><h1>Administración</h1><div class="sub">Catálogos y reglas generales del sistema</div></div></div>
    <nav class="tabs" aria-label="Secciones de administración">${ADMIN_TABS.map(([k, l]) => `<a href="#/administracion/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</nav>
    <div id="admin-body"><p class="muted">Cargando…</p></div>`;
  const body = $('#admin-body');
  const reload = () => viewAdmin(tab);
  const act = async (fn, msg) => {
    try { const r = await fn(); toast(typeof r === 'string' ? r : msg); catalogsCache = null; reload(); } catch (err) { fail(err); }
  };

  if (tab === 'tareas') {
    const { items } = await api('GET', '/admin/tasks');
    body.innerHTML = `<div class="card">
      <p class="small muted">Tareas que no pertenecen a un proyecto. Las marcadas como <b>descuentan disponibilidad</b> (vacaciones, capacitación…) reducen las horas disponibles del consultor y no afectan su eficiencia; las demás cuentan como tiempo no facturable.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Tarea</th><th>Descuenta disponibilidad</th><th>Activa</th><th class="num">Horas registradas</th><th></th></tr></thead>
        <tbody>${items.map((t) => `<tr data-id="${t.id}">
          <td><input name="name" value="${esc(t.name)}" aria-label="Nombre"></td>
          <td><input type="checkbox" name="reduces" ${t.reducesAvailability ? 'checked' : ''} aria-label="Descuenta disponibilidad"></td>
          <td><input type="checkbox" name="active" ${t.active ? 'checked' : ''} aria-label="Activa"></td>
          <td class="num">${nf.format(t.hours)}</td>
          <td class="nowrap"><button data-save>Guardar</button> <button class="danger" data-del>Eliminar</button></td></tr>`).join('')}</tbody>
        <tfoot><tr><td><input id="new-name" placeholder="Nueva tarea administrativa"></td><td><input type="checkbox" id="new-reduces" aria-label="Descuenta disponibilidad"></td><td></td><td></td>
          <td><button class="primary" id="add">Agregar</button></td></tr></tfoot>
      </table></div></div>`;
    $('#add').onclick = () => act(() => api('POST', '/admin/tasks', { name: $('#new-name').value, reducesAvailability: $('#new-reduces').checked }), 'Tarea agregada');
    $$('tr[data-id]', body).forEach((tr) => {
      $('[data-save]', tr).onclick = () => act(() => api('PUT', `/admin/tasks/${tr.dataset.id}`, {
        name: $('[name=name]', tr).value, reducesAvailability: $('[name=reduces]', tr).checked, active: $('[name=active]', tr).checked,
      }), 'Tarea actualizada');
      $('[data-del]', tr).onclick = () => {
        if (!confirm('¿Eliminar esta tarea? Si ya tiene horas registradas solo se desactivará.')) return;
        act(async () => {
          const r = await api('DELETE', `/admin/tasks/${tr.dataset.id}`);
          return r.deactivated ? 'Tenía horas registradas: se desactivó en lugar de eliminarse' : 'Tarea eliminada';
        }, 'Listo');
      };
    });
  }

  if (tab === 'festivos') {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const year = params.get('anio') || state.today.slice(0, 4);
    const { items } = await api('GET', `/admin/holidays?year=${year}`);
    const years = [Number(year) - 1, Number(year), Number(year) + 1];
    body.innerHTML = `<div class="card">
      <div class="row" style="margin-bottom:12px">${years.map((y) => `<a class="btn" href="#/administracion/festivos?anio=${y}" ${String(y) === year ? 'style="font-weight:700;border-color:var(--accent)"' : ''}>${y}</a>`).join('')}</div>
      <p class="small muted">Cada festivo en día hábil reduce las horas a cubrir de la semana y la disponibilidad (${fmtH(state.meta.weeklyHours / 5)} por día con la jornada general).</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Día</th><th>Festivo</th><th></th></tr></thead>
        <tbody>${items.map((h) => `<tr><td>${fmtDate(h.date)}</td><td>${dow(h.date)}</td><td>${esc(h.name)}</td>
          <td><button class="danger" data-del="${h.date}">Eliminar</button></td></tr>`).join('') || `<tr><td colspan="4" class="muted">Sin festivos registrados para ${year}.</td></tr>`}</tbody>
        <tfoot><tr><td><input type="date" id="h-date" aria-label="Fecha"></td><td></td><td><input id="h-name" placeholder="Nombre del festivo"></td>
          <td><button class="primary" id="add">Agregar</button></td></tr></tfoot>
      </table></div></div>`;
    $('#add').onclick = () => act(() => api('POST', '/admin/holidays', { date: $('#h-date').value, name: $('#h-name').value }), 'Festivo guardado');
    $$('[data-del]', body).forEach((b) => { b.onclick = () => act(() => api('DELETE', `/admin/holidays/${b.dataset.del}`), 'Festivo eliminado'); });
  }

  if (tab === 'clientes') {
    const { items } = await api('GET', '/admin/clients');
    body.innerHTML = `<div class="card">
      <p class="small muted">Los proyectos solo pueden asignarse a clientes de esta lista.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Cliente</th><th>Ejecutivo comercial</th><th>Activo</th><th class="num">Proyectos</th><th></th></tr></thead>
        <tbody>${items.map((c) => `<tr data-id="${c.id}">
          <td><input name="name" value="${esc(c.name)}" aria-label="Nombre"></td><td><input name="salesExec" value="${esc(c.salesExec || '')}" aria-label="Ejecutivo comercial"></td>
          <td><input type="checkbox" name="active" ${c.active ? 'checked' : ''} aria-label="Activo"></td><td class="num">${c.projects}</td>
          <td class="nowrap"><button data-save>Guardar</button> <button class="danger" data-del ${c.projects ? 'disabled title="Tiene proyectos: desactívalo"' : ''}>Eliminar</button></td></tr>`).join('')}</tbody>
        <tfoot><tr><td><input id="c-name" placeholder="Nombre del cliente"></td><td><input id="c-exec" placeholder="Ejecutivo comercial"></td><td></td><td></td>
          <td><button class="primary" id="add">Agregar</button></td></tr></tfoot>
      </table></div></div>`;
    $('#add').onclick = () => act(() => api('POST', '/admin/clients', { name: $('#c-name').value, salesExec: $('#c-exec').value }), 'Cliente agregado');
    $$('tr[data-id]', body).forEach((tr) => {
      $('[data-save]', tr).onclick = () => act(() => api('PUT', `/admin/clients/${tr.dataset.id}`, {
        name: $('[name=name]', tr).value, salesExec: $('[name=salesExec]', tr).value, active: $('[name=active]', tr).checked,
      }), 'Cliente actualizado');
      $('[data-del]', tr).onclick = () => confirm('¿Eliminar este cliente?') && act(() => api('DELETE', `/admin/clients/${tr.dataset.id}`), 'Cliente eliminado');
    });
  }

  if (tab === 'modulos') {
    const { items } = await api('GET', '/admin/modules');
    body.innerHTML = `<div class="card">
      <p class="small muted">Módulos vigentes que se pueden asignar a proyectos y a las tareas de cada proyecto.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Clave</th><th>Nombre</th><th>Vigente</th><th class="num">Proyectos</th><th></th></tr></thead>
        <tbody>${items.map((m) => `<tr data-id="${m.id}">
          <td><input name="code" value="${esc(m.code)}" maxlength="20" style="width:110px" aria-label="Clave"></td><td><input name="name" value="${esc(m.name)}" aria-label="Nombre"></td>
          <td><input type="checkbox" name="active" ${m.active ? 'checked' : ''} aria-label="Vigente"></td><td class="num">${m.projects}</td>
          <td class="nowrap"><button data-save>Guardar</button> <button class="danger" data-del ${m.projects ? 'disabled title="En uso: desactívalo"' : ''}>Eliminar</button></td></tr>`).join('')}</tbody>
        <tfoot><tr><td><input id="m-code" placeholder="Clave" maxlength="20" style="width:110px"></td><td><input id="m-name" placeholder="Nombre del módulo"></td><td></td><td></td>
          <td><button class="primary" id="add">Agregar</button></td></tr></tfoot>
      </table></div></div>`;
    $('#add').onclick = () => act(() => api('POST', '/admin/modules', { code: $('#m-code').value, name: $('#m-name').value }), 'Módulo agregado');
    $$('tr[data-id]', body).forEach((tr) => {
      $('[data-save]', tr).onclick = () => act(() => api('PUT', `/admin/modules/${tr.dataset.id}`, {
        code: $('[name=code]', tr).value, name: $('[name=name]', tr).value, active: $('[name=active]', tr).checked,
      }), 'Módulo actualizado');
      $('[data-del]', tr).onclick = () => confirm('¿Eliminar este módulo?') && act(() => api('DELETE', `/admin/modules/${tr.dataset.id}`), 'Módulo eliminado');
    });
  }

  if (tab === 'ajustes') {
    const settings = await api('GET', '/admin/settings');
    body.innerHTML = `<div class="card" style="max-width:560px"><h2>Disponibilidad</h2>
      <form id="sform" class="form-grid">
        <label class="field">Horas semanales por recurso (lunes a viernes)<input name="weeklyHours" type="number" min="1" max="80" step="0.5" value="${settings.weeklyHours}" required></label>
        <label class="check"><input type="checkbox" name="applyToAll"> Aplicar a todos los usuarios existentes</label>
        <button class="primary" type="submit">Guardar</button>
      </form>
      <p class="small muted">Es la disponibilidad inicial de cada recurso y las horas que debe cubrir por semana. Los usuarios nuevos la toman por defecto;
        se puede ajustar por persona en Usuarios (por ejemplo, medio tiempo).</p></div>`;
    $('#sform').onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      act(async () => {
        const r = await api('PUT', '/admin/settings', { weeklyHours: Number(f.get('weeklyHours')), applyToAll: f.has('applyToAll') });
        state.meta.weeklyHours = r.weeklyHours;
        if (r.updated) toast(`Se actualizaron ${r.updated} usuarios`);
      }, 'Ajustes guardados');
    };
  }
}

// ---------- Importación ----------
function readFile(input) {
  return new Promise((resolve, reject) => {
    const file = input.files[0];
    if (!file) return reject(new Error('Selecciona un archivo'));
    if (/\.mpp$/i.test(file.name)) return reject(new Error('El archivo .mpp es binario. En Project usa Archivo › Guardar como › XML (*.xml) y sube ese archivo.'));
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, text: r.result });
    r.onerror = () => reject(r.error);
    r.readAsText(file, 'utf-8');
  });
}

function summaryHtml(res) {
  return res.results.map((s) => `
    <div class="notice info"><b>${res.dryRun ? 'Vista previa' : 'Importado'}: ${esc(s.project.code)} · ${esc(s.project.name)}</b>${s.created ? ' (proyecto nuevo)' : ''}<br>
      Tareas nuevas: ${s.tasksCreated} · actualizadas: ${s.tasksUpdated} · desactivadas: ${s.tasksDeactivated} · asignaciones: ${s.assignments}
      ${s.resources.filter((r) => r.user).length ? `<br>Recursos cubiertos: ${s.resources.filter((r) => r.user).map((m) => `${esc(m.resource)} → ${esc(m.user)}`).join(', ')}` : ''}
      ${s.resources.filter((r) => !r.user).length ? `<br><b class="over">Recursos sin usuario:</b> ${s.resources.filter((r) => !r.user).map((m) => esc(m.resource + (m.email ? ` <${m.email}>` : ''))).join(', ')}
        <br><span class="small">Se guardan en el proyecto; asígnales un usuario activo en la ficha del proyecto › Recursos del plan.</span>` : ''}
      ${s.warnings.length ? `<br>Advertencias: ${s.warnings.map(esc).join('; ')}` : ''}
    </div>`).join('') + (res.errors?.length ? `<div class="notice">${res.errors.map(esc).join('<br>')}</div>` : '');
}

async function viewImport() {
  const [{ items: projects }, { items: log }, cats] = await Promise.all([api('GET', '/projects'), api('GET', '/import/log'), catalogs(true)]);
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>Importar actividades de Microsoft Project</h1>
      <div class="sub">Las tareas y asignaciones del plan se convierten en los renglones del timesheet de cada consultor.</div></div></div>
    <div class="grid-2">
      <div class="card"><h2>Archivo XML de Project</h2>
        <p class="small">En Project: <b>Archivo › Guardar como › Tipo: Formato XML (*.xml)</b>. Se leen tareas, fechas, trabajo planeado y asignaciones.
          Los recursos se guardan en el proyecto y se vinculan con los usuarios por <b>correo electrónico</b> o, si no hay, por nombre;
          después puedes reemplazar cualquiera por otro usuario activo desde la ficha del proyecto.</p>
        <form id="xml-form" class="form-grid">
          <label class="field" style="grid-column:1/-1">Archivo<input type="file" name="file" accept=".xml,text/xml" required></label>
          <label class="field">Proyecto destino<select name="projectId"><option value="">Crear o detectar por nombre</option>
            ${projects.filter((p) => p.canManage).map((p) => `<option value="${p.id}">${esc(p.code)} · ${esc(p.name)}</option>`).join('')}</select></label>
          <label class="field">Código (si es nuevo)<input name="code" placeholder="Ej. ERP-GID"></label>
          <label class="field">Cliente (catálogo)<select name="clientId">${optionList(cats.clients, '', { empty: '— Sin cliente —' })}</select></label>
          <div class="row" style="grid-column:1/-1"><button type="button" data-dry="1">Vista previa</button><button class="primary" type="submit">Importar</button></div>
        </form>
        <div id="xml-result" style="margin-top:12px"></div>
      </div>
      <div class="card"><h2>CSV / Excel</h2>
        <p class="small">Para planes que no están en Project o exportados a Excel (guardar como CSV). Una fila por asignación; acepta fechas dd/mm/aaaa y separador coma o punto y coma.</p>
        <pre class="code">proyecto,codigo_proyecto,cliente,tarea,inicio,fin,horas_planeadas,recurso_email
Diagnóstico BI,BI-DIAG,Retail Demo,Entrevistas,07/09/2026,18/09/2026,24,ana@fortia.com.mx</pre>
        <p class="small muted">El cliente debe existir en el catálogo de Administración; si no, el proyecto queda sin cliente y se avisa.</p>
        <form id="csv-form" class="form-grid">
          <label class="field" style="grid-column:1/-1">Archivo<input type="file" name="file" accept=".csv,text/csv" required></label>
          <div class="row" style="grid-column:1/-1"><button type="button" data-dry="1">Vista previa</button><button class="primary" type="submit">Importar</button></div>
        </form>
        <div id="csv-result" style="margin-top:12px"></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px"><h2>Historial de importaciones</h2><div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>Origen</th><th>Archivo</th><th>Proyecto</th><th>Usuario</th><th>Resultado</th></tr></thead>
      <tbody>${log.map((l) => `<tr><td class="small">${esc(l.createdAt)}</td><td>${esc(l.source)}</td><td>${esc(l.filename || '')}</td><td>${esc(l.projectName || '')}</td><td>${esc(l.userName || '')}</td>
        <td class="small">+${l.summary.tasksCreated ?? 0} / ~${l.summary.tasksUpdated ?? 0} / −${l.summary.tasksDeactivated ?? 0} tareas · ${l.summary.assignments ?? 0} asign.
        ${l.summary.unmatchedResources?.length ? `<span class="over">· ${l.summary.unmatchedResources.length} sin vincular</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin importaciones.</td></tr>'}</tbody>
    </table></div></div>`;

  const wire = (formId, resultId, endpoint, build) => {
    const form = $(formId);
    const run = async (dryRun) => {
      try {
        const { name, text } = await readFile(form.file);
        const res = await api('POST', endpoint, { ...build(form, text), filename: name, dryRun });
        $(resultId).innerHTML = summaryHtml(res);
        if (!dryRun) { toast('Importación completada'); setTimeout(route, 1500); }
      } catch (err) { $(resultId).innerHTML = `<div class="notice">${esc(err.message)}</div>`; }
    };
    form.onsubmit = (e) => { e.preventDefault(); run(false); };
    $('[data-dry]', form).onclick = () => run(true);
  };
  wire('#xml-form', '#xml-result', '/import/msproject', (f, text) => ({
    xml: text, projectId: f.projectId.value || null, code: f.code.value || null, clientId: f.clientId.value ? Number(f.clientId.value) : null,
  }));
  wire('#csv-form', '#csv-result', '/import/csv', (f, text) => ({ csv: text }));
}

// ---------- Usuarios ----------
async function viewUsers() {
  const { items } = await api('GET', '/users');
  const byId = new Map(items.map((u) => [u.id, u]));
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>Usuarios</h1><div class="sub">El correo debe coincidir con el del recurso en Project para vincular asignaciones${state.auth.microsoft ? ' y con la cuenta de Microsoft 365 para entrar' : ''}.</div></div>
      <button class="primary" id="new-user">Nuevo usuario</button></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Área</th><th>Aprueba sus horas</th><th class="num">Horas semanales</th><th>Eficiencia</th><th>Acceso</th><th>Estatus</th><th></th></tr></thead>
      <tbody>${items.map((u) => `<tr style="${u.active ? '' : 'opacity:.55'}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(roleLabel(u.role))}</td><td>${esc(u.area || '')}</td>
        <td>${esc(byId.get(u.managerId)?.name || '')}</td><td class="num">${fmtH(u.weeklyCapacity)}</td><td>${u.tracksTime ? 'Cuenta' : 'No cuenta'}</td>
        <td class="small">${u.authProvider === 'microsoft' ? 'Microsoft 365' : 'Contraseña'}<div class="muted">${u.lastLoginAt ? `Último: ${esc(u.lastLoginAt.slice(0, 10))}` : 'Nunca ha entrado'}</div></td>
        <td>${u.active ? 'Activo' : 'Inactivo'}</td><td><button class="ghost" data-edit="${u.id}">Editar</button></td></tr>`).join('')}</tbody>
    </table></div></div>`;
  $('#new-user').onclick = () => userDialog({}, items);
  $$('[data-edit]').forEach((b) => { b.onclick = () => userDialog(byId.get(Number(b.dataset.edit)), items); });
}

function userDialog(u, all) {
  const dlg = document.createElement('dialog');
  const leaders = all.filter((x) => x.role !== 'consultor' && x.id !== u.id && x.active);
  dlg.innerHTML = `<form method="dialog" id="uform"><h2>${u.id ? 'Editar usuario' : 'Nuevo usuario'}</h2>
    <div class="form-grid">
      <label class="field">Nombre<input name="name" required value="${esc(u.name || '')}"></label>
      <label class="field">Correo<input name="email" type="email" required value="${esc(u.email || '')}"></label>
      <label class="field">Rol<select name="role">${['consultor', 'lider', 'admin'].map((r) => `<option value="${r}" ${r === (u.role || 'consultor') ? 'selected' : ''}>${esc(roleLabel(r))}</option>`).join('')}</select></label>
      <label class="field">Área<input name="area" value="${esc(u.area || '')}"></label>
      <label class="field">Gestor que aprueba sus horas<select name="managerId"><option value="">—</option>${leaders.map((l) => `<option value="${l.id}" ${l.id === u.managerId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label class="field">Horas semanales<input name="weeklyCapacity" type="number" min="0" max="80" step="0.5" value="${u.weeklyCapacity ?? state.meta.weeklyHours}"></label>
      ${state.auth.local ? `<label class="field">${u.id ? 'Nueva contraseña (opcional)' : 'Contraseña inicial'}<input name="password" type="password" minlength="8" ${u.id ? '' : 'required'} autocomplete="new-password"></label>` : ''}
    </div>
    <p><label class="check"><input type="checkbox" name="tracksTime" ${u.tracksTime !== false ? 'checked' : ''}> Cuenta para disponibilidad y eficiencia</label>
      <label class="check" style="margin-left:14px"><input type="checkbox" name="active" ${u.active !== false ? 'checked' : ''}> Activo</label>
      ${u.linked ? '<br><label class="check" style="margin-top:8px"><input type="checkbox" name="unlinkMicrosoft"> Desvincular cuenta de Microsoft 365 (si la cuenta se recreó en Entra ID)</label>' : ''}</p>
    <div class="row"><span class="spacer"></span><button value="cancel" formnovalidate>Cancelar</button><button class="primary" value="ok">Guardar</button></div></form>`;
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue === 'ok') {
      const f = new FormData($('#uform', dlg));
      const body = Object.fromEntries(f.entries());
      body.tracksTime = f.has('tracksTime');
      body.active = f.has('active');
      body.unlinkMicrosoft = f.has('unlinkMicrosoft');
      body.weeklyCapacity = Number(body.weeklyCapacity);
      body.managerId = body.managerId ? Number(body.managerId) : null;
      if (!body.password) delete body.password;
      try {
        await api(u.id ? 'PUT' : 'POST', u.id ? `/users/${u.id}` : '/users', body);
        toast('Usuario guardado');
        route();
      } catch (err) { fail(err); }
    }
    dlg.remove();
  });
}

function openPasswordDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog" id="pwform"><h2>Cambiar contraseña</h2>
    <div class="form-grid"><label class="field">Actual<input name="current" type="password" required autocomplete="current-password"></label>
    <label class="field">Nueva (mín. 8)<input name="next" type="password" minlength="8" required autocomplete="new-password"></label></div>
    <div class="row" style="margin-top:12px"><span class="spacer"></span><button value="cancel" formnovalidate>Cancelar</button><button class="primary" value="ok">Guardar</button></div></form>`;
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue === 'ok') {
      const f = new FormData($('#pwform', dlg));
      try { await api('PUT', '/me/password', Object.fromEntries(f.entries())); toast('Contraseña actualizada'); } catch (err) { fail(err); }
    }
    dlg.remove();
  });
}

boot();
