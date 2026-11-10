import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, bridge, classifyEvent, buildUserSignals } from '../src/recommender.js';

const NOW = Date.UTC(2026, 10, 10);
const DAY = 86_400_000;
const rng = () => 0.5; // детерминированно: без случайного шума

const catalog = [
  { id: 1, user_id: 10, artist: 'lofi_cat', title: 'Rain', tags: ['lofi', 'chill'], created_at: NOW - 30 * DAY },
  { id: 2, user_id: 10, artist: 'lofi_cat', title: 'Night', tags: ['lofi', 'night'], created_at: NOW - 30 * DAY },
  { id: 3, user_id: 11, artist: 'lofi_dog', title: 'Tea', tags: ['lofi', 'chill'], created_at: NOW - 30 * DAY },
  { id: 4, user_id: 12, artist: 'dnb_rat', title: 'Rush', tags: ['dnb', 'energy'], created_at: NOW - 30 * DAY },
  { id: 5, user_id: 12, artist: 'dnb_rat', title: 'Amen', tags: ['dnb', 'jungle'], created_at: NOW - 30 * DAY },
  { id: 6, user_id: 13, artist: 'mid', title: 'Bridge', tags: ['chill', 'liquid', 'dnb'], created_at: NOW - 30 * DAY },
  { id: 7, user_id: 14, artist: 'rock', title: 'Riff', tags: ['rock', 'explicit'], explicit: true, created_at: NOW - 30 * DAY },
].map((t) => ({ explicit: false, ...t }));

test('ранний и поздний пропуск различаются', () => {
  assert.equal(classifyEvent({ type: 'skip', position: 5, duration: 200 }), 'skip_early');
  assert.equal(classifyEvent({ type: 'skip', position: 150, duration: 200 }), 'skip_late');
  assert.equal(classifyEvent({ type: 'skip', position: 3, duration: 8 }), 'skip_late');
});

test('лайк перевешивает пропуск, старые сигналы затухают', () => {
  const { signal } = buildUserSignals({
    now: NOW,
    events: [
      { track_id: 1, type: 'complete', created_at: NOW },
      { track_id: 2, type: 'complete', created_at: NOW - 365 * DAY },
    ],
    reactions: [{ track_id: 4, value: -1, created_at: NOW }],
  });
  assert.ok(signal.get(1) > signal.get(2));
  assert.ok(signal.get(4) < 0);
});

test('волна учится на тегах: любителю lofi — lofi, дизлайк исключён', () => {
  const { items, profile } = recommend({
    userId: 99, tracks: catalog, now: NOW, rng, count: 7,
    reactions: [{ track_id: 1, value: 1, created_at: NOW }, { track_id: 4, value: -1, created_at: NOW }],
    events: [{ track_id: 1, type: 'complete', created_at: NOW - 3 * 3_600_000 }],
  });
  const ids = items.map((i) => i.track.id);
  assert.ok(!ids.includes(4), 'дизлайкнутый трек не возвращается');
  assert.ok(ids.indexOf(3) < ids.indexOf(5), 'lofi выше dnb');
  assert.equal(profile.topTags[0][0] === 'lofi' || profile.topTags[0][0] === 'chill', true);
  assert.ok(items[0].reasons.length > 0, 'у каждого трека есть объяснение');
  assert.notEqual(ids[0], 1, 'трек, звучавший 3 часа назад, не ставим первым');
});

test('любимый трек, который давно не звучал, возвращается', () => {
  const { items } = recommend({
    userId: 99, tracks: catalog, now: NOW, rng, count: 7, settings: { discovery: 0.2 },
    reactions: [{ track_id: 1, value: 1, created_at: NOW - 10 * DAY }],
    events: [{ track_id: 1, type: 'complete', created_at: NOW - 10 * DAY }],
  });
  assert.equal(items[0].track.id, 1);
  assert.ok(items[0].reasons.some((r) => r.includes('давно не звучал')));
});

test('коллаборативный сигнал: «кто лайкнул X, лайкнул и Y»', () => {
  const allLikes = [1, 2, 3].flatMap((u) => [{ user_id: u, track_id: 1 }, { user_id: u, track_id: 5 }]);
  const { items } = recommend({
    userId: 99, tracks: catalog, now: NOW, rng, count: 7, allLikes,
    reactions: [{ track_id: 1, value: 1, created_at: NOW }],
  });
  const amen = items.find((i) => i.track.id === 5);
  assert.ok(amen.reasons.some((r) => r.includes('Rain')), amen.reasons.join(' | '));
});

test('правки вкуса: block скрывает тег, boost поднимает', () => {
  const tagOverrides = new Map([['lofi', 'block'], ['jungle', 'boost']]);
  const { items } = recommend({ userId: 99, tracks: catalog, now: NOW, rng, count: 7, tagOverrides });
  const ids = items.map((i) => i.track.id);
  assert.ok(![1, 2, 3].some((id) => ids.includes(id)), 'lofi заблокирован');
  assert.equal(ids[0], 5, 'jungle первым');
  assert.ok(items[0].reasons[0].includes('#jungle'));
});

test('скрытие 18+ — по желанию слушателя', () => {
  const on = recommend({ userId: 99, tracks: catalog, now: NOW, rng, count: 10, settings: { hide_explicit: 1 } });
  const off = recommend({ userId: 99, tracks: catalog, now: NOW, rng, count: 10 });
  assert.ok(!on.items.some((i) => i.track.id === 7));
  assert.ok(off.items.some((i) => i.track.id === 7));
});

test('свои треки и уже выданные не попадают в волну', () => {
  const { items } = recommend({ userId: 10, tracks: catalog, now: NOW, rng, count: 10, exclude: new Set([3]) });
  const ids = items.map((i) => i.track.id);
  assert.ok(!ids.includes(1) && !ids.includes(2) && !ids.includes(3));
});

test('один артист не играет два раза подряд, если есть альтернатива', () => {
  const { items } = recommend({ userId: 99, tracks: catalog, now: NOW, rng, count: 6 });
  for (let i = 1; i < items.length; i++) {
    assert.notEqual(items[i].track.user_id, items[i - 1].track.user_id);
  }
});

test('мост идёт от lofi к dnb через промежуточный трек', () => {
  const { items } = bridge({ userId: 99, tracks: catalog, now: NOW, rng, from: 'lofi', to: 'dnb', length: 5 });
  const tags = items.map((i) => i.track.tags);
  assert.ok(tags[0].includes('lofi'), 'начинаем с lofi');
  assert.ok(tags.at(-1).includes('dnb'), 'заканчиваем dnb');
  const mid = items.findIndex((i) => i.track.id === 6);
  assert.ok(mid > 0 && mid < items.length - 1, 'гибридный трек — в середине');
});

// ---------- звук и контекст ----------
import { localTime, contextKernel } from '../src/recommender.js';

const CALM = { bpm: 75, energy: 0.2, percussive: 0.2, brightness: 0.2, dynamics: 0.3 };
const HARD = { bpm: 174, energy: 0.9, percussive: 0.9, brightness: 0.8, dynamics: 0.6 };
const sonic = [
  { id: 1, user_id: 10, artist: 'a', title: 'Calm A', tags: ['lofi'], features: CALM },
  { id: 2, user_id: 11, artist: 'b', title: 'Hard A', tags: ['dnb'], features: HARD },
  { id: 3, user_id: 12, artist: 'c', title: 'Без тегов, спокойный', tags: [], features: { ...CALM, bpm: 78 } },
  { id: 4, user_id: 13, artist: 'd', title: 'Без тегов, жёсткий', tags: [], features: { ...HARD, bpm: 172 } },
  { id: 5, user_id: 14, artist: 'e', title: 'Calm B', tags: ['lofi'], features: CALM },
  { id: 6, user_id: 15, artist: 'f', title: 'Hard B', tags: ['dnb'], features: HARD },
].map((t) => ({ explicit: false, created_at: NOW - 30 * DAY, ...t }));

test('трек без тегов находится по звучанию', () => {
  const { items } = recommend({
    userId: 99, tracks: sonic, now: NOW, rng, count: 6,
    reactions: [{ track_id: 1, value: 1, created_at: NOW - 3 * DAY }, { track_id: 5, value: 1, created_at: NOW - 3 * DAY }],
  });
  const ids = items.map((i) => i.track.id);
  assert.ok(ids.indexOf(3) < ids.indexOf(4), 'спокойный без тегов выше жёсткого');
  const calmUntagged = items.find((i) => i.track.id === 3);
  assert.ok(calmUntagged.reasons.some((r) => r.startsWith('Звучит в вашем духе')), calmUntagged.reasons.join(' | '));
});

test('местное время и ядро контекста', () => {
  const msk = -180; // UTC+3
  assert.equal(localTime(Date.UTC(2026, 10, 10, 21, 0), msk).hour, 0);
  assert.equal(localTime(Date.UTC(2026, 10, 14, 12, 0), 0).weekend, true); // суббота
  const k = contextKernel({ hour: 23, weekend: false }, 0);
  assert.ok(k(Date.UTC(2026, 10, 10, 1, 0)) > 0.6, 'через полночь — близко');
  assert.ok(k(Date.UTC(2026, 10, 10, 11, 0)) < 0.01, 'полдень — далеко');
});

test('волна по контексту: ночью — спокойное, утром — энергичное', () => {
  const at = (day, hour) => Date.UTC(2026, 10, day, hour, 0); // будни, UTC
  const events = [];
  for (let d = 2; d <= 6; d++) {
    events.push({ track_id: 1, type: 'complete', created_at: at(d, 23) }); // ночью lofi
    events.push({ track_id: 2, type: 'complete', created_at: at(d, 8) });  // утром dnb
  }
  const base = { userId: 99, tracks: sonic, events, rng, count: 6, tzOffset: 0 };
  const night = recommend({ ...base, now: at(10, 23) });
  const morning = recommend({ ...base, now: at(10, 8) });
  const rank = (r, id) => r.items.findIndex((i) => i.track.id === id);
  assert.ok(rank(night, 5) < rank(night, 6), 'ночью lofi выше dnb');
  assert.ok(rank(morning, 6) < rank(morning, 5), 'утром dnb выше lofi');
  assert.ok(night.items.some((i) => i.reasons.some((r) => r.includes('ночью'))));
  assert.equal(night.profile.context.slot, 'ночью');
  // без контекста порядок одинаковый в любое время
  const off = (now) => recommend({ ...base, now, settings: { context: 0 } }).items.map((i) => i.track.id).join();
  assert.equal(off(at(10, 23)), off(at(10, 8)));
});

test('мост по звуку проходит через трек без тегов', () => {
  const mid = { id: 7, user_id: 16, artist: 'g', title: 'Середина', tags: [], explicit: false, created_at: NOW - 30 * DAY,
    features: { bpm: 115, energy: 0.55, percussive: 0.55, brightness: 0.5, dynamics: 0.45 } };
  const { items, path } = bridge({ userId: 99, tracks: [...sonic, mid], now: NOW, rng, from: 'lofi', to: 'dnb', length: 5 });
  assert.ok(path.from.includes('BPM') && path.to.includes('BPM'));
  const ids = items.map((i) => i.track.id);
  assert.ok([1, 5].includes(ids[0]) && [2, 6].includes(ids.at(-1)), ids.join());
  const energy = items.map((i) => i.track.features.energy);
  assert.ok(energy[0] < energy.at(-1), 'энергия растёт по пути');
});
