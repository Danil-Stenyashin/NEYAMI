/**
 * Звуковой профиль: сравнение треков по реальному звучанию
 * (признаки считает public/audio-features.js).
 */

const WEIGHTS = { tempo: 0.3, energy: 0.25, percussive: 0.2, brightness: 0.15, dynamics: 0.1 };
const KEYS = ['energy', 'percussive', 'brightness', 'dynamics'];
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Проверяет и нормализует признаки (из запроса клиента или БД). */
export function sanitizeFeatures(raw) {
  let f = raw;
  if (typeof f === 'string') {
    try { f = JSON.parse(f); } catch { return null; }
  }
  if (!f || typeof f !== 'object') return null;
  const out = {};
  const bpm = Number(f.bpm);
  out.bpm = Number.isFinite(bpm) && bpm >= 40 && bpm <= 250 ? Math.round(bpm) : null;
  for (const k of KEYS) {
    const v = Number(f[k]);
    if (!Number.isFinite(v)) return null;
    out[k] = clamp(v, 0, 1);
  }
  return out;
}

/** Разница темпов с учётом «вдвое быстрее/медленнее» (87 и 174 BPM — почти одно и то же). 0..1 */
export function tempoDistance(a, b) {
  if (!a || !b) return 0.5;
  const d = Math.log2(a / b);
  const oct = Math.min(Math.abs(d), Math.abs(d - 1) + 0.15, Math.abs(d + 1) + 0.15);
  return clamp(oct / 0.6, 0, 1);
}

/** Сходство звучания: 1 — одинаково, -1 — совсем непохоже. */
export function soundSimilarity(a, b) {
  if (!a || !b) return 0;
  let dist = WEIGHTS.tempo * tempoDistance(a.bpm, b.bpm);
  for (const k of KEYS) dist += WEIGHTS[k] * Math.abs(a[k] - b[k]);
  return 1 - 2.5 * dist;
}

/** Взвешенный центр набора признаков (темп усредняется в логарифмах). */
export function centroid(items) {
  let wSum = 0;
  let bpmW = 0;
  let logBpm = 0;
  const acc = Object.fromEntries(KEYS.map((k) => [k, 0]));
  for (const [f, w] of items) {
    if (!f || !(w > 0)) continue;
    wSum += w;
    for (const k of KEYS) acc[k] += f[k] * w;
    if (f.bpm) { logBpm += Math.log2(f.bpm) * w; bpmW += w; }
  }
  if (!wSum) return null;
  const out = { bpm: bpmW ? Math.round(2 ** (logBpm / bpmW)) : null };
  for (const k of KEYS) out[k] = Math.round((acc[k] / wSum) * 1000) / 1000;
  out.weight = wSum;
  return out;
}

/** Линейная интерполяция между двумя звуковыми точками (для моста). */
export function lerpSound(a, b, t) {
  if (!a || !b) return a ?? b ?? null;
  const out = { bpm: a.bpm && b.bpm ? Math.round(2 ** ((1 - t) * Math.log2(a.bpm) + t * Math.log2(b.bpm))) : a.bpm ?? b.bpm };
  for (const k of KEYS) out[k] = (1 - t) * a[k] + t * b[k];
  return out;
}

/** Темп обычными словами. */
export function tempoWord(bpm) {
  if (!bpm) return '';
  if (bpm < 85) return 'неспешно';
  if (bpm < 110) return 'размеренно';
  if (bpm < 135) return 'бодро';
  return 'быстро';
}

/** Короткое человеческое описание звучания — без терминов. */
export function describeSound(f) {
  if (!f) return '';
  const parts = [];
  if (f.bpm) parts.push(tempoWord(f.bpm));
  parts.push(f.energy > 0.62 ? 'энергично' : f.energy < 0.38 ? 'спокойно' : 'ровно');
  if (f.percussive > 0.65) parts.push('с плотным ритмом');
  else if (f.percussive < 0.3) parts.push('мягко');
  if (f.brightness > 0.6) parts.push('ярко');
  else if (f.brightness < 0.25) parts.push('тепло');
  return parts.join(', ');
}
