// Демо-каталог: синтезированные треки с тихим вступлением и громким «дропом»,
// артисты, слушатели с разными вкусами и привычками по времени суток, лайки и тепловые карты.
// Используется скриптом `npm run seed` и приложением для Windows при первом запуске.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, encodeTags } from './db.js';
import { hashPassword } from './auth.js';
import { BINS } from './moments.js';
import { extractFeatures } from '../public/audio-features.js';

/**
 * Заполняет пустую базу демо-данными. Если треки уже есть — ничего не делает.
 * @returns {{skipped: true} | {artists: number, tracks: number, listeners: number}}
 */
export function seedDemo({ dataDir }) {
  const uploads = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const db = openDb(path.join(dataDir, 'neyami.db'));

  if (db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n > 0) {
    db.close();
    return { skipped: true };
  }
  db.exec('BEGIN'); // одна транзакция: тысячи вставок за доли секунды, и всё или ничего

  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

  const SR = 16000;
  const DUR = 24;

  /** Синтез простого трека: аккорды + бас + перкуссия, громкая часть начиная с dropAt. */
  function synth({ bpm, root, wave, dropAt, noise }) {
    const n = SR * DUR;
    const pcm = new Int16Array(n);
    const beat = 60 / bpm;
    const scale = [0, 3, 5, 7, 10, 12];
    const osc = (f, t) => {
      const ph = (f * t) % 1;
      if (wave === 'saw') return 2 * ph - 1;
      if (wave === 'square') return ph < 0.5 ? 0.6 : -0.6;
      return Math.sin(2 * Math.PI * ph);
    };
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const step = Math.floor(t / beat);
      const note = root * Math.pow(2, scale[(step * 7) % scale.length] / 12);
      const env = Math.exp(-((t % beat) / beat) * 3);
      const loud = t >= dropAt ? 1 : 0.25 + 0.15 * (t / dropAt);
      let s = 0.35 * osc(note, t) * env + 0.2 * Math.sin(2 * Math.PI * (root / 2) * t);
      if (t >= dropAt) {
        const kick = Math.exp(-((t % beat) * 30)) * Math.sin(2 * Math.PI * 55 * t);
        s += 0.6 * kick + noise * (rand() * 2 - 1) * Math.exp(-(((t + beat / 2) % beat) * 40));
      }
      const fade = Math.min(1, t / 0.5, (DUR - t) / 0.8);
      pcm[i] = Math.max(-1, Math.min(1, s * loud * fade * 0.8)) * 32767;
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + n * 2, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(n * 2, 40);
    return { wav: Buffer.concat([header, Buffer.from(pcm.buffer)]), samples: Float32Array.from(pcm, (v) => v / 32768) };
  }

  const ARTISTS = [
    { name: 'lofi_cat', style: { bpm: 80, root: 220, wave: 'sine', noise: 0.05 }, tags: ['lofi', 'chill'],
      titles: [['Дождь на стекле', ['night']], ['Чай в 3 ночи', ['night', 'study']], ['Кассета', ['study']], ['Пыльные пластинки', []]] },
    { name: 'liquid_owl', style: { bpm: 172, root: 262, wave: 'sine', noise: 0.15 }, tags: ['dnb', 'liquid', 'chill'],
      titles: [['Тёплый ливень', []], ['Северное сияние', ['night']], ['Мост', ['lofi']]] },
    { name: 'dnb_rat', style: { bpm: 174, root: 110, wave: 'saw', noise: 0.35 }, tags: ['dnb', 'energy'],
      titles: [['Амен в метро', ['jungle']], ['Перегрузка', ['workout']], ['Нейрофанк', ['workout']], ['Подземка', ['jungle']]] },
    { name: 'synth_moth', style: { bpm: 110, root: 196, wave: 'square', noise: 0.1 }, tags: ['synthwave', 'night'],
      titles: [['Неон', ['retro']], ['Трасса 1986', ['retro', 'drive']], ['Ночной город', ['drive']], ['Хром', []]] },
    { name: 'rap_fox', style: { bpm: 90, root: 98, wave: 'square', noise: 0.25 }, tags: ['rap', 'hiphop'],
      titles: [['Без фильтров', ['explicit']], ['Район', []], ['Голос улиц', ['explicit']], ['Бит без слов', ['instrumental']]] },
    { name: 'ambient_whale', style: { bpm: 60, root: 147, wave: 'sine', noise: 0.02 }, tags: ['ambient', 'sleep'],
      titles: [['Глубина', ['chill']], ['Тихий океан', []], ['Медленные облака', ['study']]] },
    // Артист, который не ставит теги: его треки волна найдёт только по звучанию
    { name: 'no_tags_kid', style: { bpm: 172, root: 120, wave: 'saw', noise: 0.3 }, tags: [],
      titles: [['Без названия 1', []], ['Без названия 2', []]] },
  ];

  const pass = hashPassword('demo1234');
  const now = Date.now();
  const insUser = db.prepare('INSERT INTO users (username, pass_hash, bio, created_at) VALUES (?, ?, ?, ?)');
  const insTrack = db.prepare(`INSERT INTO tracks (user_id, title, description, tags, explicit, file, mime, size, duration, energy_peak, features, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'audio/wav', ?, ?, ?, ?, ?)`);

  const tracks = [];
  for (const a of ARTISTS) {
    const uid = Number(insUser.run(a.name, pass, `Демо-артист: ${a.tags.map((t) => '#' + t).join(' ')}`, now).lastInsertRowid);
    a.titles.forEach(([title, extra], k) => {
      const dropAt = 6 + Math.floor(rand() * 10);
      const { wav: buf, samples } = synth({ ...a.style, root: a.style.root * (1 + k * 0.12), dropAt });
      const features = extractFeatures(samples, SR);
      const file = `${crypto.randomBytes(16).toString('hex')}.wav`;
      fs.writeFileSync(path.join(uploads, file), buf);
      const tags = [...new Set([...a.tags, ...extra])];
      const explicit = tags.includes('explicit') ? 1 : 0;
      const age = Math.floor(rand() * 40) * 24 * 3600 * 1000;
      const id = Number(insTrack.run(uid, title, 'Синтезированный демо-трек.', encodeTags(tags.filter((t) => t !== 'explicit')),
        explicit, file, buf.length, DUR, dropAt, JSON.stringify(features), now - age).lastInsertRowid);
      tracks.push({ id, tags, dropAt, artist: a.name, features });
    });
  }

  // Слушатели с разными вкусами — чтобы работала коллаборативная фильтрация
  const LISTENERS = [
    ['night_owl', ['lofi', 'night', 'synthwave']],
    ['runner', ['dnb', 'workout', 'energy']],
    ['student', ['lofi', 'study', 'ambient']],
    ['raver', ['dnb', 'jungle', 'liquid']],
    ['driver', ['synthwave', 'drive', 'retro']],
    ['streets', ['rap', 'hiphop']],
    ['dreamer', ['ambient', 'sleep', 'chill']],
    ['mixer', ['liquid', 'chill', 'lofi']],
  ];
  const insReact = db.prepare('INSERT INTO reactions (user_id, track_id, value, created_at) VALUES (?, ?, ?, ?)');
  const insEvent = db.prepare('INSERT INTO events (user_id, track_id, type, position, duration, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const heat = new Map(tracks.map((t) => [t.id, { heard: new Array(BINS).fill(0), seeks: new Array(BINS).fill(0) }]));

  // Привычки по времени: спокойное — ночью, энергичное — утром и вечером, остальное — днём
  const DAY_MS = 24 * 3600 * 1000;
  function listenTime(t) {
    const calm = ['night', 'sleep', 'ambient', 'lofi'].some((g) => t.tags.includes(g));
    const pumped = ['workout', 'energy', 'jungle'].some((g) => t.tags.includes(g)) || (t.features?.energy ?? 0) > 0.6;
    const hour = calm ? (22 + Math.floor(rand() * 5)) % 24 : pumped ? (rand() < 0.5 ? 7 : 18) + Math.floor(rand() * 3) : 11 + Math.floor(rand() * 6);
    const midnight = new Date(now - Math.floor(1 + rand() * 20) * DAY_MS);
    midnight.setHours(0, 0, 0, 0); // местное время машины, на которой запущен сид
    return midnight.getTime() + hour * 3600 * 1000 + Math.floor(rand() * 3600 * 1000);
  }

  for (const [name, likes] of LISTENERS) {
    const uid = Number(insUser.run(name, pass, '', now).lastInsertRowid);
    for (const t of tracks) {
      const match = t.tags.filter((g) => likes.includes(g)).length;
      const p = match ? 0.45 + 0.2 * match : 0.12;
      if (rand() > p) continue;
      const ts = listenTime(t);
      insEvent.run(uid, t.id, 'play', 0, DUR, ts);
      const h = heat.get(t.id);
      if (match) {
        insEvent.run(uid, t.id, 'complete', DUR, DUR, ts + 1);
        if (rand() < 0.7) insReact.run(uid, t.id, 1, ts + 2);
        // слушали целиком, а дроп ещё и переслушивали
        const dropBin = Math.floor((t.dropAt / DUR) * BINS);
        for (let b = 0; b < BINS; b++) h.heard[b] += 1;
        if (rand() < 0.6) { h.seeks[dropBin] += 1; for (let b = dropBin; b < Math.min(BINS, dropBin + 20); b++) h.heard[b] += 1; }
      } else {
        const pos = 2 + rand() * 4;
        insEvent.run(uid, t.id, 'skip', pos, DUR, ts + 1);
        for (let b = 0; b < Math.floor((pos / DUR) * BINS); b++) h.heard[b] += 1;
      }
    }
  }
  const insHeat = db.prepare('INSERT INTO track_heat (track_id, bin, heard, seeks) VALUES (?, ?, ?, ?)');
  for (const [id, h] of heat) for (let b = 0; b < BINS; b++) if (h.heard[b] || h.seeks[b]) insHeat.run(id, b, h.heard[b], h.seeks[b]);

  insUser.run('demo', pass, 'Чистый аккаунт — попробуйте волну с нуля', now);
  db.exec('COMMIT');
  db.close();
  return { artists: ARTISTS.length, tracks: tracks.length, listeners: LISTENERS.length };
}
