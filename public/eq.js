// Эквалайзер и «живая» визуализация на Web Audio.
// Цепочка подключается лениво: пока эквалайзер выключен и визуализация не нужна, звук идёт
// напрямую — так на iPhone музыка не прерывается при заблокированном экране.

export const BANDS = [
  { f: 60, type: 'lowshelf', label: 'Низ' },
  { f: 250, type: 'peaking', label: 'Тепло' },
  { f: 1000, type: 'peaking', label: 'Середина' },
  { f: 4000, type: 'peaking', label: 'Голос' },
  { f: 12000, type: 'highshelf', label: 'Воздух' },
];

export const PRESETS = {
  flat: { name: 'Как есть', gains: [0, 0, 0, 0, 0] },
  bass: { name: 'Больше баса', gains: [6, 3, 0, 0, 0] },
  vocal: { name: 'Голос чётче', gains: [-2, -1, 2, 4, 2] },
  electro: { name: 'Электроника', gains: [5, 1, -2, 2, 4] },
  warm: { name: 'Тёплый звук', gains: [3, 3, 0, -2, -3] },
  night: { name: 'Тихо ночью', gains: [-4, -1, 1, 1, -3] },
};

const KEY = 'neyami-eq';
let ctx = null;
let filters = [];
let analyser = null;

export function loadEq() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (v && Array.isArray(v.gains) && v.gains.length === BANDS.length) return v;
  } catch { /* приватный режим и т.п. */ }
  return { on: false, preset: 'flat', gains: [...PRESETS.flat.gains] };
}
export function saveEq(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* не критично */ }
}

export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Подключает цепочку к <audio>. Вызывать из жеста пользователя (клик), иначе браузер не даст звук. */
export function ensureGraph(audio) {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return true;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;
  try {
    ctx = new Ctx();
    const src = ctx.createMediaElementSource(audio);
    filters = BANDS.map((b) => {
      const f = ctx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.f;
      if (b.type === 'peaking') f.Q.value = 1.0;
      return f;
    });
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.82;
    let node = src;
    for (const f of filters) { node.connect(f); node = f; }
    node.connect(analyser);
    analyser.connect(ctx.destination);
    return true;
  } catch {
    ctx = null;
    return false;
  }
}

export const graphReady = () => Boolean(ctx);

export function applyEq(state) {
  if (!ctx) return;
  filters.forEach((f, i) => {
    f.gain.setTargetAtTime(state.on ? state.gains[i] : 0, ctx.currentTime, 0.05);
  });
}

/** Уровни по частотам 0..1 для визуализации (или null, если цепочки нет). */
export function levels(count = 32) {
  if (!analyser) return null;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const out = new Array(count);
  const usable = Math.floor(data.length * 0.7); // самые верхние частоты почти всегда пустые
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i / count) ** 1.6 * usable);
    const to = Math.max(from + 1, Math.floor(((i + 1) / count) ** 1.6 * usable));
    let m = 0;
    for (let j = from; j < to; j++) m = Math.max(m, data[j]);
    out[i] = m / 255;
  }
  return out;
}
