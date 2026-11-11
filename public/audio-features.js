/**
 * Анализ звука без библиотек. Работает и в браузере (при загрузке трека), и в Node (сид, тесты):
 * на вход — моно-сэмплы Float32Array и частота дискретизации.
 *
 * Признаки (все, кроме bpm, нормированы в 0..1):
 *   bpm         — темп, ударов в минуту
 *   energy      — громкость/плотность (средний RMS в дБ)
 *   brightness  — «яркость» (частота пересечений нуля ≈ где сосредоточен спектр)
 *   dynamics    — насколько трек «дышит»: разброс громкости
 *   percussive  — ударность: сила атак относительно общего уровня
 */

const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function extractFeatures(samples, sampleRate) {
  const len = samples.length;
  if (!len || !sampleRate) return null;

  // --- кадры по 50 мс: энергия, пересечения нуля
  const hop = Math.max(1, Math.round(sampleRate * 0.05));
  const frames = Math.floor(len / hop);
  if (frames < 20) return null; // меньше секунды — анализировать нечего
  const rmsDb = [];
  let rmsSum = 0;
  let crossings = 0;
  let counted = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    let zc = 0;
    let prev = samples[f * hop];
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const x = samples[i];
      s += x * x;
      if ((x >= 0) !== (prev >= 0)) zc++;
      prev = x;
    }
    const rms = Math.sqrt(s / hop);
    rmsSum += rms;
    if (rms > 0.003) { // тишину не учитываем
      rmsDb.push(20 * Math.log10(rms));
      crossings += zc;
      counted += hop;
    }
  }
  const meanDb = 20 * Math.log10(Math.max(1e-6, rmsSum / frames));
  const energy = clamp01((meanDb + 40) / 37);
  const zcFreq = counted ? (crossings / counted) * sampleRate / 2 : 0;
  const brightness = clamp01(Math.log2(1 + zcFreq / 100) / Math.log2(1 + 4000 / 100));
  let dynamics = 0;
  if (rmsDb.length > 1) {
    const m = rmsDb.reduce((a, b) => a + b, 0) / rmsDb.length;
    const sd = Math.sqrt(rmsDb.reduce((a, b) => a + (b - m) ** 2, 0) / rmsDb.length);
    dynamics = clamp01(sd / 12);
  }

  // --- огибающая атак с шагом 10 мс: для ударности и темпа
  const hop2 = Math.max(1, Math.round(sampleRate * 0.01));
  const n2 = Math.floor(len / hop2);
  const env = new Float32Array(n2);
  for (let f = 0; f < n2; f++) {
    let s = 0;
    for (let i = f * hop2; i < (f + 1) * hop2; i++) s += samples[i] * samples[i];
    env[f] = Math.sqrt(s / hop2);
  }
  const flux = new Float32Array(n2);
  let fluxSum = 0;
  let envSum = 0;
  for (let i = 1; i < n2; i++) {
    flux[i] = Math.max(0, env[i] - env[i - 1]);
    fluxSum += flux[i];
    envSum += env[i];
  }
  // доля «атак» в общей громкости; мягкая кривая, чтобы шкала не упиралась в 1
  const percussive = clamp01(envSum ? 1 - Math.exp(-(fluxSum / envSum) * 8) : 0);

  return { bpm: estimateTempo(flux), energy: round(energy), brightness: round(brightness), dynamics: round(dynamics), percussive: round(percussive) };
}

/** Темп по автокорреляции огибающей атак (кадры по 10 мс), с предпочтением «естественных» темпов около 120. */
function estimateTempo(flux) {
  const n = flux.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += flux[i];
  mean /= n || 1;
  const x = Float32Array.from(flux, (v) => v - mean);
  const minLag = 30;  // 200 BPM
  const maxLag = 100; // 60 BPM
  if (n < maxLag * 3) return null;
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
    ac[lag] = s / (n - lag);
  }
  let best = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 6000 / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = ac[lag] * (0.6 + 0.4 * prior);
    if (score > bestScore) [bestScore, best] = [score, lag];
  }
  if (best < 0 || !(ac[best] > 0)) return null;
  // параболическая интерполяция пика — точнее, чем шаг в 10 мс
  const a = ac[best - 1];
  const b = ac[best];
  const c = ac[best + 1];
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  return Math.round(6000 / (best + Math.max(-0.5, Math.min(0.5, shift))));
}

const round = (x) => Math.round(x * 1000) / 1000;
