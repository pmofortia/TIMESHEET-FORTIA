// Lector de archivos XML de Microsoft Project (formato MSPDI, el que genera
// "Archivo > Guardar como > XML" en Project de escritorio y Project Online).
import { XMLParser } from 'fast-xml-parser';

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// Duraciones ISO-8601 de Project, p. ej. "PT40H0M0S" o "P2DT4H0M0S".
export function durationToHours(value) {
  if (value == null || value === '') return 0;
  const m = String(value).match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  // En MSPDI los días de <Work> ya vienen expresados en horas; un "D" suelto
  // se interpreta como jornada de 8 h, igual que el calendario estándar.
  return Math.round((Number(d) * 8 + Number(h) + Number(min) / 60 + Number(s) / 3600) * 100) / 100;
}

const dateOnly = (v) => (v ? String(v).slice(0, 10) : null);

export function parseMspdi(xml) {
  const parser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
  });
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new Error(`El archivo no es un XML válido: ${err.message}`);
  }
  const project = doc?.Project;
  if (!project || (!project.Tasks && !project.Name && !project.Title)) {
    throw new Error('El XML no parece ser un archivo de Microsoft Project (falta el nodo <Project>). Expórtalo con "Guardar como > XML".');
  }

  const projectName = String(project.Title || project.Name || 'Proyecto sin nombre').replace(/\.(mpp|xml)$/i, '');
  const rawTasks = asArray(project.Tasks?.Task);
  const tasks = [];
  const path = []; // nombres de tareas resumen por nivel
  for (const t of rawTasks) {
    const uid = String(t.UID ?? '');
    const level = Number(t.OutlineLevel ?? 1);
    // UID 0 es la tarea resumen del proyecto completo.
    if (uid === '' || (uid === '0' && level === 0)) continue;
    if (String(t.IsNull ?? '0') === '1') continue;
    const name = String(t.Name ?? '').trim();
    if (!name) continue;
    const isSummary = String(t.Summary ?? '0') === '1';
    path.length = Math.max(level - 1, 0);
    tasks.push({
      uid,
      name,
      wbs: t.WBS ? String(t.WBS) : null,
      outlineLevel: level,
      parentPath: path.filter(Boolean).join(' › ') || null,
      start: dateOnly(t.Start),
      finish: dateOnly(t.Finish),
      work: durationToHours(t.Work),
      isSummary,
      isMilestone: String(t.Milestone ?? '0') === '1',
    });
    // La tarea resumen de nivel 1 suele repetir el nombre del proyecto: no aporta a la ruta.
    if (isSummary) path[level - 1] = level === 1 && name === projectName ? null : name;
  }

  const resources = new Map();
  for (const r of asArray(project.Resources?.Resource)) {
    const uid = String(r.UID ?? '');
    // Type 1 = recurso de trabajo (persona); 0 = material, 2 = costo.
    if (!uid || uid === '0' || String(r.Type ?? '1') !== '1') continue;
    if (!r.Name) continue;
    resources.set(uid, {
      uid,
      name: String(r.Name).trim(),
      email: r.EmailAddress ? String(r.EmailAddress).trim() : null,
    });
  }

  const assignments = [];
  for (const a of asArray(project.Assignments?.Assignment)) {
    const resourceUid = String(a.ResourceUID ?? '');
    if (!resources.has(resourceUid)) continue; // -65535 = sin asignar
    assignments.push({
      taskUid: String(a.TaskUID ?? ''),
      resourceUid,
      work: durationToHours(a.Work),
    });
  }

  return {
    name: projectName,
    tasks,
    resources: [...resources.values()],
    assignments,
  };
}
