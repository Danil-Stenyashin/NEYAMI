import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { archiveSearch, archiveFetchTracks, download, jamendoSearch, ImportError } from '../src/importers.js';

// --- поддельная сеть в формате ответов Internet Archive и Jamendo ---
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000, 1)]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const json = (obj) => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });
const file = (buf, type, url) => {
  const r = new Response(buf, { headers: { 'content-type': type, 'content-length': String(buf.length) } });
  Object.defineProperty(r, 'url', { value: url });
  return r;
};
const requested = [];
async function fakeFetch(url) {
  requested.push(url);
  const u = new URL(url);
  if (u.pathname === '/advancedsearch.php') {
    return json({ response: { docs: [
      { identifier: 'night-lofi-ep', title: 'Night Lofi EP', creator: 'Луна', licenseurl: 'https://creativecommons.org/licenses/by/4.0/', subject: 'lofi; chill' },
      { identifier: 'bad id!', title: 'нельзя' },
    ] } });
  }
  if (u.pathname === '/metadata/night-lofi-ep') {
    return json({
      metadata: { title: 'Night Lofi EP', creator: 'Луна', licenseurl: 'https://creativecommons.org/licenses/by/4.0/', subject: ['lofi', 'chill'] },
      files: [
        { name: '01 Rain.mp3', title: 'Rain', length: '2:05', size: '2000' },
        { name: '01 Rain_64kb.mp3' },
        { name: 'cover.jpg' },
        { name: '02 Tea.mp3', length: '61.5', size: '2000' },
      ],
    });
  }
  if (u.pathname === '/metadata/evil') return json({ metadata: { title: 'x', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' }, files: [{ name: 'a.mp3' }] });
  if (u.pathname.startsWith('/download/evil/')) return file(MP3, 'audio/mpeg', 'https://169.254.169.254/latest');
  if (u.pathname.startsWith('/download/')) return file(MP3, 'audio/mpeg', `https://ia800000.us.archive.org${u.pathname}`);
  if (u.pathname.startsWith('/services/img/')) return file(JPG, 'image/jpeg', url);
  if (u.hostname === 'api.jamendo.com') {
    if (u.searchParams.get('client_id') !== 'goodkey') return json({ headers: { status: 'failed', error_message: 'Invalid client id' }, results: [] });
    return json({ headers: { status: 'success' }, results: [{
      id: '777', name: 'Sunrise', artist_name: 'Ветер', album_name: 'Утро', duration: 180,
      image: 'https://usercontent.jamendo.com/img.jpg', audio: 'https://prod-1.storage.jamendo.com/a.mp3',
      audiodownload: 'https://prod-1.storage.jamendo.com/d.mp3', audiodownload_allowed: true,
      license_ccurl: 'http://creativecommons.org/licenses/by-sa/3.0/', shareurl: 'https://www.jamendo.com/track/777',
      musicinfo: { tags: { genres: ['ambient'], vartags: ['calm'] } },
    }] });
  }
  if (u.hostname === 'soundcloud.com' && u.pathname === '/oembed') {
    const page = u.searchParams.get('url');
    if (page.endsWith('/missing')) return new Response('not found', { status: 404 });
    return json({ title: 'Night Drive by Ночной Пилот', author_name: 'Ночной Пилот', thumbnail_url: 'https://i1.sndcdn.com/artworks-abc-large.jpg' });
  }
  if (u.hostname.endsWith('sndcdn.com')) return file(JPG, 'image/jpeg', url);
  if (u.hostname.endsWith('jamendo.com')) return file(u.pathname.endsWith('.jpg') ? JPG : MP3, u.pathname.endsWith('.jpg') ? 'image/jpeg' : 'audio/mpeg', url);
  throw new Error(`неожиданный запрос: ${url}`);
}

test('поиск в Internet Archive: только свободные лицензии и корректные id', async () => {
  const items = await archiveSearch(fakeFetch, 'lofi');
  assert.equal(items.length, 1);
  assert.equal(items[0].artist, 'Луна');
  assert.equal(items[0].licenseName, 'CC BY 4.0');
  assert.deepEqual(items[0].tags, ['lofi', 'chill']);
  assert.ok(decodeURIComponent(requested.at(-1)).includes('creativecommons'));
});

test('треки альбома: только полноценные mp3, без 64-килобитных копий', async () => {
  const list = await archiveFetchTracks(fakeFetch, 'night-lofi-ep');
  assert.deepEqual(list.map((t) => t.title), ['Rain', 'Tea']);
  assert.equal(list[0].duration, 125);
  assert.ok(list[0].cover?.buf.length);
  assert.match(list[0].description, /CC BY 4.0/);
});

test('скачивание с чужого сервера после переадресации запрещено', async () => {
  await assert.rejects(archiveFetchTracks(fakeFetch, 'evil'), /чужой сервер/);
  await assert.rejects(download(fakeFetch, 'https://example.com/a.mp3', { hosts: ['archive.org'], max: 10, kind: 'audio' }), ImportError);
  await assert.rejects(archiveFetchTracks(fakeFetch, '../etc'), /идентификатор/);
});

test('Jamendo: без ключа — понятная ошибка, с ключом — треки', async () => {
  await assert.rejects(jamendoSearch(fakeFetch, '', 'calm'), /ключ/);
  await assert.rejects(jamendoSearch(fakeFetch, 'wrong', 'calm'), /Invalid client id/);
  const list = await jamendoSearch(fakeFetch, 'goodkey', 'calm');
  assert.equal(list[0].artist, 'Ветер');
  assert.deepEqual(list[0].tags, ['ambient', 'calm']);
});

// --- через API сервера ---
let server; let base; let dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neyami-import-'));
  server = createApp({ dataDir: dir, fetchImpl: fakeFetch });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
function client() {
  let cookie = '';
  return async (p, { method = 'GET', json: body, raw, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(cookie && { cookie }), ...(body && { 'content-type': 'application/json' }), ...headers },
      body: body ? JSON.stringify(body) : raw,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, type: ct, data: ct.includes('json') ? await res.json() : await res.text() };
  };
}

test('импорт альбома: треки приписаны автору, с обложкой и лицензией; удалить может импортёр', async () => {
  const me = client();
  await me('/api/register', { method: 'POST', json: { username: 'collector', password: 'password1' } });
  const r = await me('/api/import/archive', { method: 'POST', json: { id: 'night-lofi-ep' } });
  assert.equal(r.status, 201);
  const [t] = r.data.tracks;
  assert.equal(t.artist.username, 'Луна');
  assert.equal(t.source, 'archive');
  assert.match(t.license, /creativecommons/);
  assert.ok(t.can_edit);
  assert.deepEqual(t.tags, ['lofi', 'chill']);
  const cover = await me(t.cover);
  assert.equal(cover.type, 'image/jpeg');

  // под импортированным артистом войти нельзя
  const login = await client()('/api/login', { method: 'POST', json: { username: 'Луна', password: '!' } });
  assert.equal(login.status, 401);

  // посторонний удалить не может, импортёр — может
  const other = client();
  await other('/api/register', { method: 'POST', json: { username: 'stranger', password: 'password1' } });
  assert.equal((await other(`/api/tracks/${t.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await me(`/api/tracks/${t.id}`, { method: 'DELETE' })).status, 200);
});

test('чужой трек не прилипнет к профилю живого пользователя с тем же именем', async () => {
  const real = client();
  await real('/api/register', { method: 'POST', json: { username: 'Ветер', password: 'password1' } });
  const me = client();
  await me('/api/register', { method: 'POST', json: { username: 'jamfan', password: 'password1' } });
  assert.equal((await me('/api/import/jamendo?q=calm')).status, 400); // ключа ещё нет
  await me('/api/import/settings', { method: 'PUT', json: { jamendo_key: 'goodkey' } });
  const found = await me('/api/import/jamendo?q=calm');
  const r = await me('/api/import/jamendo', { method: 'POST', json: { ids: [found.data.tracks[0].id] } });
  assert.equal(r.status, 201);
  assert.equal(r.data.tracks[0].artist.username, 'Ветер (импорт)');
  const profile = await real('/api/users/%D0%92%D0%B5%D1%82%D0%B5%D1%80');
  assert.equal(profile.data.tracks.length, 0);
});

test('у трека без своей обложки — сгенерированная, одинаковая при повторе', async () => {
  const me = client();
  await me('/api/register', { method: 'POST', json: { username: 'covers', password: 'password1' } });
  const up = await me('/api/tracks?title=Plain', { method: 'POST', raw: MP3, headers: { 'content-type': 'audio/mpeg' } });
  const a = await me(up.data.track.cover);
  const b = await me(up.data.track.cover);
  assert.match(a.type, /svg/);
  assert.equal(a.data, b.data);
  // своя обложка
  const set = await me(`/api/tracks/${up.data.track.id}/cover`, { method: 'POST', raw: JPG, headers: { 'content-type': 'image/jpeg' } });
  assert.equal(set.status, 200);
  assert.equal((await me(set.data.track.cover)).type, 'image/jpeg');
  // папка: трек другого артиста из тегов файла
  const folder = await me('/api/tracks?title=Song&artist=%D0%9B%D1%83%D0%BD%D0%B0&source=folder', { method: 'POST', raw: MP3, headers: { 'content-type': 'audio/mpeg' } });
  assert.equal(folder.data.track.artist.username, 'Луна');
  assert.equal(folder.data.track.source, 'folder');
  assert.ok(folder.data.track.can_edit);
});

import { parseLink } from '../src/links.js';

test('ссылки: только треки SoundCloud и Яндекс Музыки, адрес плеера собирается сам', () => {
  const sc = parseLink('https://soundcloud.com/night-pilot/night-drive?si=123&utm_source=x');
  assert.equal(sc.service, 'soundcloud');
  assert.equal(sc.page, 'https://soundcloud.com/night-pilot/night-drive');
  assert.ok(sc.embed.startsWith('https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fnight-pilot%2Fnight-drive'));
  const ya = parseLink('https://music.yandex.ru/album/123/track/456');
  assert.equal(ya.embed, 'https://music.yandex.ru/iframe/track/456/123');
  assert.throws(() => parseLink('https://soundcloud.com/night-pilot/sets/album'), /отдельный трек/);
  assert.throws(() => parseLink('https://music.yandex.ru/artist/1'), /album/);
  assert.throws(() => parseLink('https://evil.example/soundcloud.com/a/b'), /SoundCloud и Яндекс/);
  assert.throws(() => parseLink('javascript:alert(1)'), /https/);
});

test('трек по ссылке: SoundCloud подставляет название и обложку, Яндекс просит ввести; звук не хранится', async () => {
  const me = client();
  await me('/api/register', { method: 'POST', json: { username: 'linker', password: 'password1' } });
  const sc = await me('/api/tracks/link', { method: 'POST', json: { url: 'https://soundcloud.com/night-pilot/night-drive', tags: 'synthwave' } });
  assert.equal(sc.status, 201);
  assert.equal(sc.data.track.title, 'Night Drive');
  assert.equal(sc.data.track.artist.username, 'Ночной Пилот');
  assert.equal(sc.data.track.source, 'soundcloud');
  assert.match(sc.data.track.embed, /^https:\/\/w\.soundcloud\.com\/player\//);
  assert.equal((await me(sc.data.track.cover)).type, 'image/jpeg');
  assert.equal((await me(`/api/tracks/${sc.data.track.id}/stream`)).status, 404);
  // повторная ссылка не плодит дубликаты
  const again = await me('/api/tracks/link', { method: 'POST', json: { url: 'https://soundcloud.com/night-pilot/night-drive' } });
  assert.equal(again.data.track.id, sc.data.track.id);
  assert.equal((await me('/api/tracks/link', { method: 'POST', json: { url: 'https://soundcloud.com/night-pilot/missing' } })).status, 400);

  const noTitle = await me('/api/tracks/link', { method: 'POST', json: { url: 'https://music.yandex.ru/album/1/track/2' } });
  assert.equal(noTitle.status, 400);
  const ya = await me('/api/tracks/link', { method: 'POST', json: { url: 'https://music.yandex.ru/album/1/track/2', title: 'Песня', artist: 'Исполнитель' } });
  assert.equal(ya.status, 201);
  assert.equal(ya.data.track.embed, 'https://music.yandex.ru/iframe/track/2/1');
  assert.equal((await me(`/api/tracks/${ya.data.track.id}`, { method: 'DELETE' })).status, 200);
});
