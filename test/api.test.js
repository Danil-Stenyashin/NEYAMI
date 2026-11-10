import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

let server;
let base;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neyami-'));
  server = createApp({ dataDir: dir });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return async (p, { method = 'GET', json, body, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(cookie && { cookie }), ...(json && { 'content-type': 'application/json' }), ...headers },
      body: json ? JSON.stringify(json) : body,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : await res.arrayBuffer() };
  };
}

const fakeAudio = Buffer.alloc(4096, 7);

test('полный путь: регистрация → загрузка → волна → стрим → тепловая карта → вкус', async () => {
  const artist = client();
  const listener = client();
  assert.equal((await artist('/api/register', { method: 'POST', json: { username: 'artist', password: 'password1' } })).status, 200);
  assert.equal((await listener('/api/register', { method: 'POST', json: { username: 'fan', password: 'password1' } })).status, 200);

  const up = await artist('/api/tracks?title=Drop&tags=dnb,%23Energy&duration=200&peak=90', {
    method: 'POST', body: fakeAudio, headers: { 'content-type': 'audio/mpeg' },
  });
  assert.equal(up.status, 201);
  const track = up.data.track;
  assert.deepEqual(track.tags, ['dnb', 'energy']);
  assert.equal(track.moment.source, 'audio');

  // неаудио отклоняется
  const bad = await artist('/api/tracks?title=x', { method: 'POST', body: 'hi', headers: { 'content-type': 'text/html' } });
  assert.equal(bad.status, 415);

  const wave = await listener('/api/wave');
  assert.equal(wave.data.items[0].track.id, track.id);
  assert.ok(wave.data.items[0].reasons.length);

  // Range-запрос для перемотки
  const part = await listener(`/api/tracks/${track.id}/stream`, { headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.data.byteLength, 100);
  assert.equal(part.headers.get('content-range'), `bytes 100-199/${fakeAudio.length}`);

  // прослушивание с перемоткой → тепловая карта
  for (let i = 0; i < 4; i++) {
    const l = await listener(`/api/tracks/${track.id}/listen`, {
      method: 'POST', json: { duration: 200, segments: [[0, 10], [120, 140]], seeks: [120] },
    });
    assert.equal(l.status, 201);
  }
  const heat = await listener(`/api/tracks/${track.id}/heat`);
  assert.equal(heat.data.heat.seeks[60], 4);
  assert.equal(heat.data.moment.source, 'listeners');

  // события и режим «не запоминать»
  assert.equal((await listener('/api/events', { method: 'POST', json: { track_id: track.id, type: 'complete' } })).status, 201);
  await listener('/api/wave/settings', { method: 'PUT', json: { private_mode: true } });
  const priv = await listener('/api/events', { method: 'POST', json: { track_id: track.id, type: 'skip', position: 1 } });
  assert.equal(priv.data.stored, false);

  // вкус: тег виден, его можно заблокировать — тогда трек пропадает из волны
  const taste = await listener('/api/taste');
  assert.ok(taste.data.profile.topTags.some(([t]) => t === 'dnb'));
  await listener('/api/taste/tags', { method: 'PUT', json: { tag: 'dnb', action: 'block' } });
  assert.equal((await listener('/api/wave')).data.items.length, 0);

  // жалобы — только по юридическим причинам
  assert.equal((await listener(`/api/tracks/${track.id}/report`, { method: 'POST', json: { reason: 'dislike' } })).status, 400);
  assert.equal((await listener(`/api/tracks/${track.id}/report`, { method: 'POST', json: { reason: 'copyright' } })).status, 201);

  // удалить чужой трек нельзя
  assert.equal((await listener(`/api/tracks/${track.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await artist(`/api/tracks/${track.id}`, { method: 'DELETE' })).status, 200);
});

test('без входа волна недоступна, статика защищена от выхода из папки', async () => {
  const anon = client();
  assert.equal((await anon('/api/wave')).status, 401);
  const res = await fetch(`${base}/..%2f..%2fpackage.json`);
  const text = await res.text();
  assert.ok(!text.includes('"name": "neyami"'));
});
