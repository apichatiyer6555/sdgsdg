import { badRequest } from './errors.js';

export function str(value, { name = 'Поле', min = 0, max = 500, required = false, trim = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw badRequest(`${name}: обязательное поле.`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw badRequest(`${name}: ожидается строка.`);
  const text = trim ? String(value).trim() : String(value);
  if (required && !text) throw badRequest(`${name}: обязательное поле.`);
  if (text.length < min) throw badRequest(`${name}: минимум ${min} симв.`);
  if (text.length > max) throw badRequest(`${name}: максимум ${max} симв.`);
  return text;
}

export function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  throw badRequest('Ожидается true/false.');
}

export function tags(value, { max = 20 } = {}) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const out = [];
  for (const item of list) {
    const tag = String(item ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out.slice(0, max);
}

export function oneOf(value, allowed, name = 'Поле') {
  if (!allowed.includes(value)) throw badRequest(`${name}: допустимо ${allowed.join(', ')}.`);
  return value;
}

export function intId(value, name = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${name}: некорректный идентификатор.`);
  return n;
}

export function validPassword(value, name = 'Пароль') {
  const text = str(value, { name, required: true, max: 200, trim: false });
  if (text.length < 10) throw badRequest(`${name}: минимум 10 символов.`);
  return text;
}
