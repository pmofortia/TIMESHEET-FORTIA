export { ValidationError } from './services/timesheets.js';
import { ValidationError } from './services/timesheets.js';

export const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    next(err);
  }
};

export const requiredText = (value, label, max = 200) => {
  const s = String(value ?? '').trim();
  if (!s) throw new ValidationError(`${label} es obligatorio`);
  return s.slice(0, max);
};

export const optionalText = (value, max = 200) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
};

export const optionalNumber = (value, label, { min = 0, max = 1e9 } = {}) => {
  if (value === '' || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${label} inválido`);
  return n;
};

export const isUniqueError = (err) => String(err?.message).includes('UNIQUE');
