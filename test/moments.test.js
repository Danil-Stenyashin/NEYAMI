import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BINS, bestMoment, segmentsToBins } from '../src/moments.js';

const empty = () => ({ heard: new Array(BINS).fill(0), seeks: new Array(BINS).fill(0) });

test('мало данных → берём пик энергии из анализа звука', () => {
  const m = bestMoment(empty(), 200, 90);
  assert.equal(m.source, 'audio');
  assert.ok(m.start <= 90 && m.end >= 90);
});

test('нет ничего → разумная точка ~трети трека', () => {
  const m = bestMoment(empty(), 180, null);
  assert.equal(m.source, 'default');
  assert.equal(m.start, 59.4);
});

test('начало, которое слушают все, не считается дропом', () => {
  const heat = empty();
  for (let i = 0; i < BINS; i++) heat.heard[i] = Math.round(50 * Math.exp(-i / 30)); // естественное убывание
  const m = bestMoment(heat, 200, 120);
  assert.equal(m.source, 'audio', 'без всплесков слушатели ничего не «подсказали»');
});

test('всплеск прослушиваний и перемотки в середине → это и есть дроп', () => {
  const heat = empty();
  for (let i = 0; i < BINS; i++) heat.heard[i] = Math.round(50 * Math.exp(-i / 30));
  for (let i = 60; i < 68; i++) heat.heard[i] += 25; // переслушивают
  heat.seeks[60] = 12; // и перематывают сюда
  const m = bestMoment(heat, 200, 20);
  assert.equal(m.source, 'listeners');
  assert.ok(m.start >= 110 && m.start <= 125, `start=${m.start}`);
  assert.ok(m.confidence > 0);
});

test('отрезки переводятся в бины, мусор игнорируется', () => {
  const bins = segmentsToBins([[0, 10], [50, 40], ['x', 3], [99, 99.1]], 100);
  assert.deepEqual([...bins].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49]);
});

test('слабый всплеск от пары слушателей не перебивает анализ звука', () => {
  // реальный случай: один слушатель начал с подсказанного дропа — это не доказательство
  const heat = empty();
  const h = [4, 4, 4, 4, 4, 3, 2, 2, 2, 2, 2, 2, 3, 3, 3, 2, 2, 2];
  for (let i = 0; i < BINS; i++) heat.heard[i] = h[i] ?? 1;
  const m = bestMoment(heat, 24, 6);
  assert.equal(m.source, 'audio');
  assert.equal(m.start, 3);
});
