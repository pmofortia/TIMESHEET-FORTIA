// Fechas como cadenas 'YYYY-MM-DD' interpretadas en UTC para evitar
// desfases por zona horaria. Las semanas inician en lunes.

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function toDate(s) {
  return new Date(`${s}T00:00:00Z`);
}

export function fmt(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(s, n) {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

export function weekStart(s) {
  const d = toDate(s);
  const dow = (d.getUTCDay() + 6) % 7; // lunes = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return fmt(d);
}

// La semana laboral de Fortia es de lunes a viernes.
export function weekDays(start) {
  return Array.from({ length: 5 }, (_, i) => addDays(start, i));
}

export function today() {
  return fmt(new Date());
}

export function isWeekday(s) {
  const dow = toDate(s).getUTCDay();
  return dow >= 1 && dow <= 5;
}

export function countWeekdays(from, to) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWeekday(d)) n++;
  return n;
}

export function weeksBetween(from, to) {
  const weeks = [];
  for (let w = weekStart(from); w <= to; w = addDays(w, 7)) weeks.push(w);
  return weeks;
}
