import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures } from '../public/audio-features.js';
import { tempoDistance, soundSimilarity, sanitizeFeatures, centroid, describeSound } from '../src/sound.js';

const SR = 16000;
function clicks(bpm, { amp = 0.5, tone = 220, noise = 0, seconds = 20 } = {}) {
  const out = new Float32Array(SR * seconds);
  const beat = 60 / bpm;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const ph = t % beat;
    out[i] = amp * Math.exp(-ph * 25) * Math.sin(2 * Math.PI * tone * t) + noise * rnd() * Math.exp(-ph * 40);
  }
  return out;
}

test('темп определяется по звуку', () => {
  for (const bpm of [70, 90, 110, 128, 140]) {
    const f = extractFeatures(clicks(bpm), SR);
    assert.ok(Math.abs(f.bpm - bpm) <= 2, `${bpm} → ${f.bpm}`);
  }
});

test('громкий шумный трек ярче и энергичнее тихого', () => {
  const soft = extractFeatures(clicks(90, { amp: 0.05 }), SR);
  const hard = extractFeatures(clicks(170, { amp: 0.8, tone: 880, noise: 0.6 }), SR);
  assert.ok(hard.energy > soft.energy);
  assert.ok(hard.brightness > soft.brightness);
});

test('щелчки ударнее ровного тянущегося звука', () => {
  const pad = new Float32Array(SR * 20).map((_, i) => 0.4 * Math.sin(2 * Math.PI * 220 * i / SR) * (0.8 + 0.2 * Math.sin(i / SR)));
  const pf = extractFeatures(pad, SR);
  const cf = extractFeatures(clicks(120), SR);
  assert.ok(pf.percussive < 0.2, `pad ${pf.percussive}`);
  assert.ok(cf.percussive > 0.6, `clicks ${cf.percussive}`);
});

test('слишком короткий звук не анализируется', () => {
  assert.equal(extractFeatures(new Float32Array(100), SR), null);
});

test('87 и 174 BPM считаются близкими, 87 и 120 — нет', () => {
  assert.ok(tempoDistance(87, 174) < 0.3);
  assert.ok(tempoDistance(87, 120) > 0.7);
  assert.equal(tempoDistance(100, 100), 0);
});

test('сходство звучания', () => {
  const calm = { bpm: 70, energy: 0.2, percussive: 0.2, brightness: 0.2, dynamics: 0.3 };
  const calm2 = { bpm: 72, energy: 0.25, percussive: 0.2, brightness: 0.25, dynamics: 0.3 };
  const hard = { bpm: 174, energy: 0.9, percussive: 0.9, brightness: 0.8, dynamics: 0.6 };
  assert.ok(soundSimilarity(calm, calm2) > 0.8);
  assert.ok(soundSimilarity(calm, hard) < 0);
  assert.equal(soundSimilarity(null, calm), 0);
});

test('признаки от клиента проверяются', () => {
  assert.equal(sanitizeFeatures('not json'), null);
  assert.equal(sanitizeFeatures({ bpm: 120 }), null);
  const f = sanitizeFeatures('{"bpm":9999,"energy":5,"brightness":0.5,"dynamics":0.5,"percussive":-1}');
  assert.deepEqual(f, { bpm: null, energy: 1, brightness: 0.5, dynamics: 0.5, percussive: 0 });
});

test('центр профиля и описание', () => {
  const c = centroid([[{ bpm: 80, energy: 0.2, percussive: 0.2, brightness: 0.2, dynamics: 0.2 }, 1],
    [{ bpm: 160, energy: 0.4, percussive: 0.4, brightness: 0.4, dynamics: 0.4 }, 1]]);
  assert.equal(c.bpm, 113); // среднее в логарифмах: sqrt(80·160)
  assert.equal(c.energy, 0.3);
  assert.equal(describeSound({ bpm: 174, energy: 0.9, percussive: 0.8, brightness: 0.7, dynamics: 0.5 }), 'быстро, энергично, с плотным ритмом, ярко');
  assert.equal(describeSound({ bpm: 72, energy: 0.2, percussive: 0.2, brightness: 0.2, dynamics: 0.5 }), 'неспешно, спокойно, мягко, тепло');
});
