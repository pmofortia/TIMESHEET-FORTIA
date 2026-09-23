// Timesheet Fortia — SPA sin dependencias ni paso de build.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { me: null, categories: [], today: null, dirty: false, pending: 0 };

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
const isWeekend = (s) => [0, 6].includes(parseD(s).getUTCDay());
const catLabel = (k) => state.categories.find((c) => c.key === k)?.label || k;
const catShort = { facturable: 'Facturable', preventa: 'Preventa', interno: 'Interno', capacitacion: 'Capacitación', administrativo: 'Administrativo', ausencia: 'Ausencia' };
const catColor = (k) => `var(--cat-${k})`;
const dot = (k) => `<span class="cat-dot" style="background:${catColor(k)}"></span>`;
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
  if (res.status === 401 && path !== '/auth/login') {
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
    const data = await api('GET', '/me');
    Object.assign(state, { me: data.user, categories: data.categories, today: data.today });
    renderShell();
    route();
  } catch {
    renderLogin();
  }
}

function renderLogin() {
  $('#app').innerHTML = `
    <div class="login"><div class="card">
      <h1>Timesheet Fortia</h1>
      <p class="muted">Registro semanal de horas por proyecto</p>
      <form id="login-form">
        <label class="field">Correo<input name="email" type="email" autocomplete="username" required autofocus></label>
        <label class="field">Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="primary" type="submit">Entrar</button>
        <p class="small muted" id="login-error" role="alert"></p>
      </form>
    </div></div>`;
  $('#login-form').addEventListener('submit', async (e) => {
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
  { href: '#/proyectos', label: 'Proyectos', match: 'proyectos', manager: true },
  { href: '#/importar', label: 'Importar de Project', match: 'importar', manager: true },
  { href: '#/usuarios', label: 'Usuarios', match: 'usuarios', admin: true },
];

function renderShell() {
  const roleLabel = { consultor: 'Consultor', lider: 'Líder de proyecto', admin: 'Administrador' }[state.me.role];
  $('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="rgba(255,255,255,.16)"/><path d="M16 7v9l6 4" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></svg>
          <div>Fortia<small>Timesheet</small></div></div>
        <nav class="nav" aria-label="Principal">
          ${NAV.filter((n) => (!n.manager || isManager()) && (!n.admin || state.me.role === 'admin'))
            .map((n) => `<a href="${n.href}" data-match="${n.match}">${n.label}${n.badge ? '<span class="badge-count hidden" id="pending-badge"></span>' : ''}</a>`).join('')}
        </nav>
        <div class="me"><b>${esc(state.me.name)}</b><span>${roleLabel}</span>
          <div class="row"><button id="btn-password" type="button">Contraseña</button><button id="btn-logout" type="button">Salir</button></div></div>
      </aside>
      <main class="main" id="main"></main>
    </div>`;
  $('#btn-logout').onclick = async () => { await api('POST', '/auth/logout').catch(() => {}); state.me = null; location.hash = ''; renderLogin(); };
  $('#btn-password').onclick = openPasswordDialog;
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
    usuarios: viewUsers,
  };
  (views[section] || views.semana)().catch((err) => { main.innerHTML = `<div class="notice">${esc(err.message)}</div>`; });
}

// ---------- Grid semanal (compartido entre captura y revisión) ----------
function gridHtml(sheet, editable) {
  const { days, rows } = sheet;
  const byDay = Object.fromEntries(days.map((d) => [d, 0]));
  let grand = 0;
  const body = rows.map((r) => {
    let total = 0;
    const cells = days.map((d) => {
      const h = Number(r.hours[d] || 0);
      total += h; byDay[d] += h;
      return `<td class="day ${isWeekend(d) ? 'weekend' : ''}"><input class="h" type="number" inputmode="decimal" min="0" max="24" step="0.25"
        data-task="${r.taskId}" data-date="${d}" value="${h || ''}" aria-label="${esc(r.taskName)} ${dow(d)} ${fmtDay(d)}" ${editable ? '' : 'disabled'}></td>`;
    }).join('');
    grand += total;
    const planned = r.plannedHours != null ? ` · plan ${fmtH(r.plannedHours)} · acumulado ${fmtH(r.loggedToDate)}` : '';
    const dates = r.start ? ` · ${fmtDay(r.start)} – ${fmtDate(r.finish)}` : '';
    const over = r.plannedHours && r.loggedToDate > r.plannedHours;
    return `<tr data-row="${r.taskId}">
      <td class="task">
        <div class="task-name">${dot(r.category)}${esc(r.taskName)}</div>
        <div class="task-meta">${esc(r.projectCode)} · ${esc(r.projectName)}${r.parentPath ? ` › ${esc(r.parentPath)}` : ''}</div>
        <div class="task-meta ${over ? 'over' : ''}">${esc(catShort[r.category] || r.category)}${dates}${planned}${over ? ' · excede lo planeado' : ''}</div>
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
        ${days.map((d) => `<th class="day ${isWeekend(d) ? 'weekend' : ''}">${dow(d)}<span class="date">${fmtDay(d)}</span></th>`).join('')}
        <th class="num">Total</th>${editable ? '<th></th>' : ''}</tr></thead>
      <tbody>${body || `<tr><td colspan="10" class="muted">No tienes tareas asignadas en esta semana. Agrega una actividad abajo.</td></tr>`}</tbody>
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
  for (const t of sheet.available) (groups[`${t.projectCode} · ${t.projectName}`] ||= []).push(t);

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Semana del ${fmtDay(sheet.days[0])} al ${fmtDate(sheet.days[6])}</h1>
        <div class="sub">Capacidad semanal: ${fmtH(sheet.capacity)} · ${statusBadge(sheet.timesheet.status)}</div></div>
      <div class="row">
        <a class="btn" href="#/semana/${sheet.prevWeek}" aria-label="Semana anterior">← Anterior</a>
        <a class="btn" href="#/semana/${weekStart(state.today)}">Hoy</a>
        <a class="btn" href="#/semana/${sheet.nextWeek}" aria-label="Semana siguiente">Siguiente →</a>
        <input type="date" id="jump" value="${sheet.week}" aria-label="Ir a fecha">
      </div>
    </div>
    ${sheet.timesheet.status === 'rechazado' ? `<div class="notice"><b>Tu líder rechazó este timesheet.</b> ${esc(sheet.timesheet.reviewComment || '')}</div>` : ''}
    ${sheet.timesheet.status === 'enviado' ? '<div class="notice info">Enviado a aprobación. Si necesitas corregirlo, pide a tu líder que lo reabra.</div>' : ''}
    <div class="card">
      <div id="grid">${gridHtml(sheet, editable)}</div>
      ${editable ? `
      <div class="row" style="margin-top:14px">
        <select id="add-task" aria-label="Agregar actividad">
          <option value="">+ Agregar actividad…</option>
          ${Object.entries(groups).map(([g, ts]) => `<optgroup label="${esc(g)}">${ts.map((t) =>
            `<option value="${t.taskId}">${esc(t.taskName)}${t.assigned ? '' : ' (abierta)'}</option>`).join('')}</optgroup>`).join('')}
        </select>
        <button type="button" id="copy-prev">Copiar tareas de la semana anterior</button>
        <span class="spacer"></span>
        <span class="muted" id="cap-hint"></span>
        <button type="button" id="save">Guardar borrador</button>
        <button type="button" class="primary" id="submit">Enviar a aprobación</button>
      </div>` : ''}
    </div>
    <p class="small muted">Solo aparecen las tareas que Project te asigna en las fechas de esta semana, más las que ya tengan horas.
      Las actividades internas (capacitación, preventa, vacaciones…) están abiertas para todos.</p>`;

  $('#jump').onchange = (e) => { if (e.target.value) location.hash = `#/semana/${weekStart(e.target.value)}`; };
  if (!editable) return;

  const updateHint = () => {
    const t = total();
    const hint = $('#cap-hint');
    hint.textContent = `${fmtH(t)} de ${fmtH(sheet.capacity)}`;
    hint.className = t > sheet.capacity + 0.01 ? 'over' : 'muted';
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
    if (t < sheet.capacity && !confirm(`Registraste ${fmtH(t)} de ${fmtH(sheet.capacity)} de capacidad. ¿Enviar de todos modos?`)) return;
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
      <div class="sub">Semana del ${fmtDay(data.days[0])} al ${fmtDate(data.days[6])} · ${fmtH(total)} de ${fmtH(data.capacity)} · ${statusBadge(s)}</div></div>
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

function stackedColumns(weekly, cats, { width = 1000, height = 260 } = {}) {
  const left = 40, bottom = 26, top = 10;
  const plotH = height - bottom - top;
  const totals = weekly.map((w) => cats.reduce((s, c) => s + w[c], 0));
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
    const segs = cats.filter((c) => w[c] > 0);
    const rects = segs.map((c, j) => {
      const y0 = y(acc), y1 = y(acc + w[c]);
      acc += w[c];
      const hgt = Math.max(y0 - y1 - (j < segs.length - 1 ? 2 : 0), 1); // 2px de separación entre segmentos
      const isTop = j === segs.length - 1;
      const r = isTop ? Math.min(4, hgt / 2, barW / 2) : 0;
      const d = `M${x},${y0}v-${hgt - r}${r ? `a${r},${r} 0 0 1 ${r},-${r}h${barW - 2 * r}a${r},${r} 0 0 1 ${r},${r}` : `h${barW}`}v${hgt - r}z`;
      return `<path class="mark" d="${d}" fill="${catColor(c)}" data-tip="<b>Semana ${fmtDay(w.week)}</b>${esc(catShort[c])}: ${fmtH(w[c])}<br>Total semana: ${fmtH(totals[i])}"/>`;
    }).join('');
    return `${rects}<text x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${fmtDay(w.week)}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Horas por semana y rubro">
    ${ticks.join('')}<line class="baseline" x1="${left}" x2="${width}" y1="${y(0)}" y2="${y(0)}"/>${cols}</svg>`;
}

const legend = (cats) => `<div class="legend">${cats.map((c) => `<span>${dot(c)}${esc(catShort[c])}</span>`).join('')}</div>`;

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

async function viewMetrics() {
  const [users, projects] = await Promise.all([api('GET', '/users'), api('GET', '/projects')]);
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const [dFrom, dTo] = presetRange('4s');
  const q = {
    from: params.get('from') || dFrom, to: params.get('to') || dTo,
    userId: params.get('userId') || '', projectId: params.get('projectId') || '', includeDrafts: params.get('includeDrafts') || '',
  };
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  const m = await api('GET', `/metrics?${qs}`);
  const cats = state.categories.map((c) => c.key);
  const tracked = users.items.filter((u) => u.active && u.tracksTime);

  $('#main').innerHTML = `
    <div class="page-head"><div><h1>Indicadores</h1><div class="sub">${fmtDate(m.range.from)} – ${fmtDate(m.range.to)} · ${m.range.weekdays} días hábiles ·
      ${m.range.includeDrafts ? 'incluye borradores' : 'solo timesheets enviados y aprobados'}</div></div>
      <a class="btn" href="/api/metrics/export.csv?${qs}">Exportar detalle CSV</a></div>
    <form class="filters" id="filters">
      <label class="field">Periodo<select name="preset"><option value="">Personalizado</option><option value="4s">Últimas 4 semanas</option>
        <option value="mes">Este mes</option><option value="mes-anterior">Mes anterior</option><option value="trimestre">Este trimestre</option><option value="anio">Este año</option></select></label>
      <label class="field">Desde<input type="date" name="from" value="${q.from}"></label>
      <label class="field">Hasta<input type="date" name="to" value="${q.to}"></label>
      ${tracked.length > 1 ? `<label class="field">Consultor<select name="userId"><option value="">Todos</option>
        ${tracked.map((u) => `<option value="${u.id}" ${String(u.id) === q.userId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>` : ''}
      <label class="field">Proyecto<select name="projectId"><option value="">Todos</option>
        ${projects.items.map((p) => `<option value="${p.id}" ${String(p.id) === q.projectId ? 'selected' : ''}>${esc(p.code)} · ${esc(p.name)}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="includeDrafts" value="1" ${q.includeDrafts ? 'checked' : ''}> Incluir borradores</label>
      <button class="primary" type="submit">Aplicar</button>
    </form>

    <div class="kpis">
      <div class="kpi"><div class="label">Cargabilidad</div><div class="value">${pct(m.kpis.utilization)}</div>
        <div class="hint">Facturable / capacidad · meta ${pct(m.target)}</div></div>
      <div class="kpi"><div class="label">Cargabilidad neta</div><div class="value">${pct(m.kpis.netUtilization)}</div>
        <div class="hint">Descontando ausencias</div></div>
      <div class="kpi"><div class="label">Horas registradas</div><div class="value">${nf.format(m.kpis.hours)}</div>
        <div class="hint">${fmtH(m.kpis.billable)} facturables</div></div>
      <div class="kpi"><div class="label">Capacidad</div><div class="value">${nf.format(m.kpis.capacity)}</div>
        <div class="hint">${m.kpis.consultants} consultores</div></div>
      <div class="kpi"><div class="label">Cumplimiento de timesheet</div><div class="value">${pct(m.kpis.compliance)}</div>
        <div class="hint">Semanas cerradas enviadas a tiempo</div></div>
    </div>

    <div class="grid-2">
      <div class="card"><h2>Horas por rubro</h2>
        ${barsH(cats.map((c) => ({ label: catShort[c], value: m.byCategory[c], color: catColor(c),
          tip: `<b>${esc(catLabel(c))}</b>${fmtH(m.byCategory[c])} · ${pct(m.kpis.hours ? m.byCategory[c] / m.kpis.hours : 0)} del total` })))}
      </div>
      <div class="card"><h2>Cargabilidad por consultor</h2>
        ${m.utilization.length ? barsH(m.utilization.map((u) => ({ label: u.name, value: u.utilization, color: 'var(--cat-facturable)',
          tip: `<b>${esc(u.name)}</b>Cargabilidad ${pct(u.utilization)} (neta ${pct(u.netUtilization)})<br>${fmtH(u.billable)} facturables de ${fmtH(u.capacity)}<br>Ocupación total ${pct(u.occupancy)}` })),
          { max: 1, target: m.target, format: pct }) : '<p class="muted">Sin consultores en el filtro.</p>'}
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h2>Tendencia semanal por rubro</h2>${legend(cats)}${stackedColumns(m.weekly, cats)}
      <details class="table-view"><summary>Ver como tabla</summary><div class="table-wrap"><table>
        <thead><tr><th>Semana</th>${cats.map((c) => `<th class="num">${catShort[c]}</th>`).join('')}</tr></thead>
        <tbody>${m.weekly.map((w) => `<tr><td>${fmtDate(w.week)}</td>${cats.map((c) => `<td class="num">${nf.format(w[c])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div></details>
    </div>

    <div class="card"><h2>Detalle por consultor</h2><div class="table-wrap"><table>
      <thead><tr><th>Consultor</th><th class="num">Capacidad</th>${cats.map((c) => `<th class="num">${dot(c)}${catShort[c]}</th>`).join('')}
        <th class="num">Total</th><th class="num">Cargab.</th><th class="num">Neta</th></tr></thead>
      <tbody>${m.utilization.map((u) => `<tr><td>${esc(u.name)}<div class="small muted">${esc(u.area || '')}</div></td><td class="num">${nf.format(u.capacity)}</td>
        ${cats.map((c) => `<td class="num">${nf.format(u.byCategory[c])}</td>`).join('')}
        <td class="num"><b>${nf.format(u.hours)}</b></td><td class="num">${pct(u.utilization)}</td><td class="num">${pct(u.netUtilization)}</td></tr>`).join('')}</tbody>
    </table></div></div>

    <div class="card"><h2>Proyectos: plan vs. real</h2><div class="table-wrap"><table>
      <thead><tr><th>Proyecto</th><th>Rubro</th><th class="num">Horas en periodo</th><th class="num">Real acumulado</th><th class="num">Planeado</th><th>Consumo del plan</th><th>Fechas</th></tr></thead>
      <tbody>${m.projects.map((p) => `<tr><td><b>${esc(p.code)}</b> · ${esc(p.name)}<div class="small muted">${esc(p.client || '')}</div></td>
        <td>${dot(p.category)}${esc(catShort[p.category])}</td><td class="num">${nf.format(p.hours)}</td><td class="num">${nf.format(p.actualToDate)}</td>
        <td class="num">${p.planned ? nf.format(p.planned) : '—'}</td>
        <td>${p.consumed != null ? `${pct(p.consumed)}<div class="progress ${p.consumed > 1 ? 'over' : ''}"><span style="width:${Math.min(p.consumed, 1) * 100}%"></span></div>` : '<span class="muted">sin plan</span>'}</td>
        <td class="small">${p.start ? `${fmtDate(p.start)} – ${fmtDate(p.finish)}` : '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin horas en el periodo.</td></tr>'}</tbody>
    </table></div></div>

    <div class="card"><h2>Cumplimiento semanal</h2>
      ${m.compliance.weeks.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Consultor</th>${m.compliance.weeks.map((w) => `<th>${fmtDay(w)}</th>`).join('')}<th class="num">Cumplimiento</th></tr></thead>
        <tbody>${m.compliance.rows.map((r) => `<tr><td>${esc(r.name)}</td>${r.weeks.map((s) => `<td>${statusBadge(s)}</td>`).join('')}
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
    const p = new URLSearchParams([...fd.entries()].filter(([, v]) => v));
    location.hash = `#/indicadores?${p}`;
  };
}

// ---------- Proyectos ----------
async function viewProjects() {
  const { items } = await api('GET', '/projects');
  const sourceLabel = { msproject: 'MS Project', csv: 'CSV/Excel', manual: 'Manual' };
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>Proyectos</h1><div class="sub">Catálogo de proyectos y actividades</div></div>
      <div class="row"><a class="btn" href="#/importar">Importar de Project</a><button class="primary" id="new-project">Nuevo proyecto</button></div></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Código</th><th>Proyecto</th><th>Cliente</th><th>Rubro</th><th>Origen</th><th class="num">Tareas</th><th class="num">Horas plan</th><th>Estatus</th></tr></thead>
      <tbody>${items.map((p) => `<tr><td><a href="#/proyectos/${p.id}"><b>${esc(p.code)}</b></a></td><td>${esc(p.name)}${p.openToAll ? ' <span class="small muted">(abierto a todos)</span>' : ''}</td>
        <td>${esc(p.client || '')}</td><td>${dot(p.category)}${esc(catShort[p.category])}</td>
        <td>${sourceLabel[p.source] || esc(p.source)}${p.lastImportAt ? `<div class="small muted">${esc(p.lastImportAt.slice(0, 16))}</div>` : ''}</td>
        <td class="num">${p.tasks}</td><td class="num">${nf.format(p.planned)}</td><td>${esc(p.status)}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
  $('#new-project').onclick = () => projectDialog();
}

async function projectDialog(p = {}) {
  const users = (await api('GET', '/users')).items.filter((u) => u.active && u.role !== 'consultor');
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog" id="pform"><h2>${p.id ? 'Editar proyecto' : 'Nuevo proyecto'}</h2>
    <div class="form-grid">
      <label class="field">Código<input name="code" required value="${esc(p.code || '')}"></label>
      <label class="field">Nombre<input name="name" required value="${esc(p.name || '')}"></label>
      <label class="field">Cliente<input name="client" value="${esc(p.client || '')}"></label>
      <label class="field">Rubro<select name="category">${state.categories.map((c) => `<option value="${c.key}" ${c.key === (p.category || 'facturable') ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
      <label class="field">Líder<select name="pmId"><option value="">—</option>${users.map((u) => `<option value="${u.id}" ${u.id === p.pmId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <label class="field">Estatus<select name="status"><option value="activo">Activo</option><option value="cerrado" ${p.status === 'cerrado' ? 'selected' : ''}>Cerrado</option></select></label>
    </div>
    <p><label class="check"><input type="checkbox" name="openToAll" ${p.openToAll ? 'checked' : ''}> Abierto a todos (cualquiera puede registrar sin asignación)</label></p>
    <div class="row"><span class="spacer"></span><button value="cancel" formnovalidate>Cancelar</button><button class="primary" value="ok">Guardar</button></div></form>`;
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue === 'ok') {
      const f = new FormData($('#pform', dlg));
      const body = Object.fromEntries(f.entries());
      body.openToAll = f.has('openToAll');
      body.pmId = body.pmId ? Number(body.pmId) : null;
      try {
        await api(p.id ? 'PUT' : 'POST', p.id ? `/projects/${p.id}` : '/projects', body);
        toast('Proyecto guardado');
        route();
      } catch (err) { fail(err); }
    }
    dlg.remove();
  });
}

async function viewProject(id) {
  const [{ items: projects }, { items: tasks }, { items: users }] = await Promise.all([
    api('GET', '/projects'), api('GET', `/projects/${Number(id)}/tasks`), api('GET', '/users')]);
  const p = projects.find((x) => x.id === Number(id));
  if (!p) throw new Error('Proyecto no encontrado');
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>${esc(p.code)} · ${esc(p.name)}</h1><div class="sub">${esc(p.client || '')} · ${dot(p.category)}${esc(catLabel(p.category))}</div></div>
      <div class="row"><a class="btn" href="#/proyectos">← Proyectos</a><button id="edit">Editar</button></div></div>
    <div class="card"><h2>Tareas</h2><div class="table-wrap"><table>
      <thead><tr><th>WBS</th><th>Tarea</th><th>Inicio</th><th>Fin</th><th>Recursos</th><th class="num">Plan</th><th class="num">Real</th><th>Avance de horas</th></tr></thead>
      <tbody>${tasks.map((t) => {
        const c = t.planned ? t.actual / t.planned : null;
        return `<tr style="${t.active ? '' : 'opacity:.5'}${t.isSummary ? ';font-weight:600' : ''}">
        <td class="small muted">${esc(t.wbs || '')}</td>
        <td style="padding-left:${10 + Math.max(t.level - 1, 0) * 14}px">${esc(t.name)}${t.active ? '' : ' <span class="small">(ya no está en el plan)</span>'}${t.category ? ` <span class="small muted">${dot(t.category)}${esc(catShort[t.category])}</span>` : ''}</td>
        <td class="small nowrap">${t.start ? fmtDate(t.start) : '—'}</td><td class="small nowrap">${t.finish ? fmtDate(t.finish) : '—'}</td>
        <td class="small">${esc(t.resources || '')}</td>
        <td class="num">${t.isSummary ? '' : nf.format(t.planned)}</td><td class="num">${t.isSummary ? '' : nf.format(t.actual)}</td>
        <td>${!t.isSummary && c != null ? `<div class="progress ${c > 1 ? 'over' : ''}"><span style="width:${Math.min(c, 1) * 100}%"></span></div>` : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="8" class="muted">Sin tareas. Importa el plan desde Project o agrega tareas manualmente.</td></tr>'}</tbody>
    </table></div></div>
    <div class="card"><h2>Agregar tarea manual</h2>
      <form id="tform" class="form-grid">
        <label class="field">Nombre<input name="name" required></label>
        <label class="field">Inicio<input name="start" type="date"></label>
        <label class="field">Fin<input name="finish" type="date"></label>
        <label class="field">Horas planeadas<input name="planned" type="number" min="0" step="0.5"></label>
        <label class="field">Rubro (si difiere del proyecto)<select name="category"><option value="">Igual que el proyecto</option>
          ${state.categories.map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join('')}</select></label>
        <label class="field">Asignar a<select name="userIds" multiple size="4">${users.filter((u) => u.active).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
        <button class="primary" type="submit">Agregar</button>
      </form>
      <p class="small muted">Si el proyecto viene de Project, lo recomendable es mantener el plan allá y reimportar: la reimportación desactiva las tareas que ya no estén en el archivo.</p>
    </div>`;
  $('#edit').onclick = () => projectDialog(p);
  $('#tform').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', `/projects/${p.id}/tasks`, {
        name: f.get('name'), start: f.get('start') || null, finish: f.get('finish') || null,
        planned: Number(f.get('planned') || 0), category: f.get('category') || null, userIds: f.getAll('userIds').map(Number),
      });
      toast('Tarea agregada');
      route();
    } catch (err) { fail(err); }
  };
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
      ${s.matchedResources.length ? `<br>Recursos vinculados: ${s.matchedResources.map((m) => `${esc(m.resource)} → ${esc(m.user)}`).join(', ')}` : ''}
      ${s.unmatchedResources.length ? `<br><b class="over">Recursos sin usuario en el sistema (sus asignaciones se omiten):</b> ${s.unmatchedResources.map((m) => esc(m.resource + (m.email ? ` <${m.email}>` : ''))).join(', ')}` : ''}
      ${s.warnings.length ? `<br>Advertencias: ${s.warnings.map(esc).join('; ')}` : ''}
    </div>`).join('') + (res.errors?.length ? `<div class="notice">${res.errors.map(esc).join('<br>')}</div>` : '');
}

async function viewImport() {
  const [{ items: projects }, { items: log }] = await Promise.all([api('GET', '/projects'), api('GET', '/import/log')]);
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>Importar actividades de Microsoft Project</h1>
      <div class="sub">Las tareas y asignaciones del plan se convierten en los renglones del timesheet de cada consultor.</div></div></div>
    <div class="grid-2">
      <div class="card"><h2>Archivo XML de Project</h2>
        <p class="small">En Project: <b>Archivo › Guardar como › Tipo: Formato XML (*.xml)</b>. Se leen tareas, fechas, trabajo planeado y asignaciones.
          Los recursos se vinculan con los usuarios por <b>correo electrónico</b> (campo "Correo electrónico" del recurso) o, si no hay, por nombre exacto.</p>
        <form id="xml-form" class="form-grid">
          <label class="field" style="grid-column:1/-1">Archivo<input type="file" name="file" accept=".xml,text/xml" required></label>
          <label class="field">Proyecto destino<select name="projectId"><option value="">Crear o detectar por nombre</option>
            ${projects.filter((p) => !p.openToAll).map((p) => `<option value="${p.id}">${esc(p.code)} · ${esc(p.name)}</option>`).join('')}</select></label>
          <label class="field">Código (si es nuevo)<input name="code" placeholder="Ej. ERP-GID"></label>
          <label class="field">Cliente<input name="client"></label>
          <label class="field">Rubro<select name="category">${state.categories.map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join('')}</select></label>
          <div class="row" style="grid-column:1/-1"><button type="button" data-dry="1">Vista previa</button><button class="primary" type="submit">Importar</button></div>
        </form>
        <div id="xml-result" style="margin-top:12px"></div>
      </div>
      <div class="card"><h2>CSV / Excel</h2>
        <p class="small">Para planes que no están en Project o exportados a Excel (guardar como CSV). Una fila por asignación; acepta fechas dd/mm/aaaa y separador coma o punto y coma.</p>
        <pre class="code">proyecto,codigo_proyecto,cliente,rubro,tarea,inicio,fin,horas_planeadas,recurso_email
Diagnóstico BI,BI-DIAG,Retail SA,facturable,Entrevistas,07/09/2026,18/09/2026,24,ana@fortia.com.mx</pre>
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
    xml: text, projectId: f.projectId.value || null, code: f.code.value || null, client: f.client.value || null, category: f.category.value,
  }));
  wire('#csv-form', '#csv-result', '/import/csv', (f, text) => ({ csv: text }));
}

// ---------- Usuarios ----------
async function viewUsers() {
  const { items } = await api('GET', '/users');
  const byId = new Map(items.map((u) => [u.id, u]));
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>Usuarios</h1><div class="sub">El correo debe coincidir con el del recurso en Project para vincular asignaciones.</div></div>
      <button class="primary" id="new-user">Nuevo usuario</button></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Área</th><th>Líder</th><th class="num">Capacidad</th><th>Cargabilidad</th><th>Estatus</th><th></th></tr></thead>
      <tbody>${items.map((u) => `<tr style="${u.active ? '' : 'opacity:.55'}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(u.area || '')}</td>
        <td>${esc(byId.get(u.managerId)?.name || '')}</td><td class="num">${fmtH(u.weeklyCapacity)}</td><td>${u.tracksTime ? 'Cuenta' : 'No cuenta'}</td>
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
      <label class="field">Rol<select name="role">${['consultor', 'lider', 'admin'].map((r) => `<option ${r === (u.role || 'consultor') ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label class="field">Área<input name="area" value="${esc(u.area || '')}"></label>
      <label class="field">Líder (aprueba sus horas)<select name="managerId"><option value="">—</option>${leaders.map((l) => `<option value="${l.id}" ${l.id === u.managerId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label class="field">Capacidad semanal (h)<input name="weeklyCapacity" type="number" min="0" max="80" step="0.5" value="${u.weeklyCapacity ?? 40}"></label>
      <label class="field">${u.id ? 'Nueva contraseña (opcional)' : 'Contraseña inicial'}<input name="password" type="password" minlength="8" ${u.id ? '' : 'required'} autocomplete="new-password"></label>
    </div>
    <p><label class="check"><input type="checkbox" name="tracksTime" ${u.tracksTime !== false ? 'checked' : ''}> Cuenta para capacidad y cargabilidad</label>
      <label class="check" style="margin-left:14px"><input type="checkbox" name="active" ${u.active !== false ? 'checked' : ''}> Activo</label></p>
    <div class="row"><span class="spacer"></span><button value="cancel" formnovalidate>Cancelar</button><button class="primary" value="ok">Guardar</button></div></form>`;
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue === 'ok') {
      const f = new FormData($('#uform', dlg));
      const body = Object.fromEntries(f.entries());
      body.tracksTime = f.has('tracksTime');
      body.active = f.has('active');
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
