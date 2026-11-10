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
