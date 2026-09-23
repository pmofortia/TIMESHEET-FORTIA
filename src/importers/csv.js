// Importación alternativa desde CSV/Excel (para quien exporta de Project a
// Excel o arma el plan a mano). Una fila por asignación:
//   proyecto, tarea, inicio, fin, horas_planeadas, recurso_email[, recurso, cliente, rubro, codigo_proyecto]

export function parseCsvText(text) {
  const src = text.replace(/^﻿/, '');
  // Excel en español suele exportar con ';'.
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const normalizeHeader = (h) =>
  h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const ALIASES = {
  proyecto: ['proyecto', 'project', 'nombre_proyecto'],
  codigo_proyecto: ['codigo_proyecto', 'codigo', 'clave_proyecto', 'project_code'],
  cliente: ['cliente', 'client'],
  rubro: ['rubro', 'categoria', 'category'],
  tarea: ['tarea', 'task', 'nombre_tarea', 'actividad', 'nombre'],
  inicio: ['inicio', 'start', 'fecha_inicio', 'comienzo'],
  fin: ['fin', 'finish', 'fecha_fin', 'end'],
  horas_planeadas: ['horas_planeadas', 'horas', 'trabajo', 'work', 'hours'],
  recurso_email: ['recurso_email', 'email', 'correo', 'resource_email'],
  recurso: ['recurso', 'resource', 'nombres_de_los_recursos', 'resource_names'],
};

// Acepta 2026-09-01, 01/09/2026 (dd/mm/aaaa, formato México) y "lun 01/09/26".
export function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function parseHours(v) {
  if (v == null) return 0;
  const s = String(v).trim().replace(/\s*(h|hrs|horas)\.?$/i, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export function parseTaskCsv(text) {
  const rows = parseCsvText(text);
  if (rows.length < 2) throw new Error('El CSV no tiene filas de datos.');
  const header = rows[0].map(normalizeHeader);
  const col = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const idx = header.findIndex((h) => names.includes(h));
    if (idx >= 0) col[key] = idx;
  }
  for (const req of ['proyecto', 'tarea']) {
    if (col[req] == null) throw new Error(`Falta la columna obligatoria "${req}". Encabezados encontrados: ${rows[0].join(', ')}`);
  }
  const get = (r, key) => (col[key] == null ? '' : String(r[col[key]] ?? '').trim());
  const errors = [];
  const items = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const item = {
      line,
      project: get(r, 'proyecto'),
      projectCode: get(r, 'codigo_proyecto') || null,
      client: get(r, 'cliente') || null,
      category: get(r, 'rubro').toLowerCase() || null,
      task: get(r, 'tarea'),
      start: parseDate(get(r, 'inicio')),
      finish: parseDate(get(r, 'fin')),
      hours: parseHours(get(r, 'horas_planeadas')),
      email: get(r, 'recurso_email') || null,
      resource: get(r, 'recurso') || null,
    };
    if (!item.project || !item.task) errors.push(`Línea ${line}: proyecto y tarea son obligatorios`);
    else items.push(item);
  });
  return { items, errors };
}
