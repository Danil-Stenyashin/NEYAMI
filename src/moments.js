/**
 * Автоопределение «лучшего момента» (дропа) трека по поведению слушателей.
 *
 * Наивно взять «самую прослушиваемую часть» нельзя: все начинают с начала,
 * поэтому начало всегда лидирует, а дальше кривая только падает.
 * Поэтому смотрим на то, что ломает естественное убывание:
 *   • прослушиваний в точке больше, чем было где-то раньше → туда перематывают
 *     или переслушивают («избыток» над минимумом слева);
 *   • точки, куда целенаправленно перематывают (seek), — отдельный сильный сигнал.
 * Пока данных мало — используем пик энергии звука, посчитанный при загрузке.
 */

export const BINS = 100;
export const WINDOW_SEC = 15;
const MIN_LISTENERS = 3;
const LEAD_IN = 3; // секунды «разгона» перед дропом

/** Переводит прослушанные отрезки [[from,to],...] в номера бинов. */
export function segmentsToBins(segments, duration) {
  const hits = new Set();
  if (!(duration > 0)) return hits;
  for (const seg of segments ?? []) {
    if (!Array.isArray(seg)) continue;
    const a = Math.max(0, Math.min(Number(seg[0]), Number(seg[1])));
    const b = Math.min(duration, Math.max(Number(seg[0]), Number(seg[1])));
    if (!(b - a >= 0.5)) continue;
    const from = Math.floor((a / duration) * BINS);
    const to = Math.min(BINS - 1, Math.floor(((b - 0.001) / duration) * BINS));
    for (let i = from; i <= to; i++) hits.add(i);
  }
  return hits;
}

export function seekBin(t, duration) {
  if (!(duration > 0) || !(t >= 0) || t > duration) return null;
  return Math.min(BINS - 1, Math.floor((t / duration) * BINS));
}

/**
 * @param {{heard:number[], seeks:number[]}} heat массивы длины BINS
 * @param {number} duration длительность, сек
 * @param {number|null} energyPeak секунда энергетического пика (из анализа при загрузке)
 * @returns {{start:number, end:number, source:'listeners'|'audio'|'default', confidence:number}}
 */
export function bestMoment(heat, duration, energyPeak = null) {
  const dur = Number(duration) || 0;
  const win = Math.min(WINDOW_SEC, dur);
  const clampStart = (s) => Math.max(0, Math.min(Math.max(0, dur - win), s));
  const fallback = () => {
    if (Number.isFinite(energyPeak) && energyPeak >= 0 && dur > 0) {
      return { start: round(clampStart(energyPeak - LEAD_IN)), end: round(clampStart(energyPeak - LEAD_IN) + win), source: 'audio', confidence: 0 };
    }
    const s = clampStart(dur * 0.33);
    return { start: round(s), end: round(s + win), source: 'default', confidence: 0 };
  };
  if (!dur || !heat) return fallback();

  const heard = heat.heard ?? [];
  const seeks = heat.seeks ?? [];
  const listeners = heard[0] ?? 0;
  if (Math.max(...heard, 0) < MIN_LISTENERS) return fallback();

  // избыток над минимумом слева
  const score = new Array(BINS).fill(0);
  let minLeft = Infinity;
  for (let i = 0; i < BINS; i++) {
    const h = heard[i] ?? 0;
    minLeft = Math.min(minLeft, h);
    score[i] = (h - minLeft) + 2 * (seeks[i] ?? 0);
  }
  const total = score.reduce((a, b) => a + b, 0);
  if (total < MIN_LISTENERS) return fallback();

  const winBins = Math.max(1, Math.round((win / dur) * BINS));
  let best = 0;
  let bestSum = -1;
  let sum = 0;
  for (let i = 0; i < BINS; i++) {
    sum += score[i];
    if (i >= winBins) sum -= score[i - winBins];
    if (i >= winBins - 1 && sum > bestSum) [bestSum, best] = [sum, i - winBins + 1];
  }
  // начинаем чуть раньше пика сигнала, чтобы был «разгон» к дропу
  const peakBin = best + score.slice(best, best + winBins).indexOf(Math.max(...score.slice(best, best + winBins)));
  const start = clampStart((peakBin / BINS) * dur - LEAD_IN);
  return {
    start: round(start),
    end: round(start + win),
    source: 'listeners',
    confidence: Math.min(1, total / Math.max(10, listeners * 2)),
  };
}

const round = (x) => Math.round(x * 10) / 10;
