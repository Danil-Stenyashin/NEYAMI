import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, parseTags, encodeTags, decodeTags } from './db.js';
import { hashPassword, verifyPassword, newToken, parseCookies } from './auth.js';
import { recommend, bridge, buildContext, describeProfile } from './recommender.js';
import { BINS, bestMoment, segmentsToBins, seekBin } from './moments.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_UPLOAD = 100 * 1024 * 1024; // 100 МБ — без жёстких лимитов на длину миксов
const SESSION_TTL = 30 * 24 * 3600 * 1000;

const AUDIO_TYPES = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac',
  'audio/x-flac': 'flac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/webm': 'webm',
};
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const TASTE_ACTIONS = new Set(['forget', 'boost', 'block']);
const EVENT_TYPES = new Set(['play', 'complete', 'skip', 'preview_complete', 'preview_skip']);
const REPORT_REASONS = new Set(['copyright', 'illegal', 'spam', 'impersonation']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({ dataDir = path.join(ROOT, 'data') } = {}) {
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'neyami.db'));
  const q = (sql) => db.prepare(sql);

  // ---------- helpers ----------
  const send = (res, status, body, headers = {}) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(data);
  };

  const readJson = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });

  const currentUser = (req) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) return null;
    const row = q(`SELECT u.id, u.username, s.created_at FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token = ?`).get(token);
    if (!row || Date.now() - row.created_at > SESSION_TTL) return null;
    return { id: row.id, username: row.username };
  };
  const requireUser = (req) => {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Нужно войти');
    return u;
  };

  const startSession = (res, userId, user) => {
    const token = newToken();
    q('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
    send(res, 200, { user }, {
      'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`,
    });
  };

  const TRACK_SELECT = `
    SELECT t.id, t.user_id, t.title, t.description, t.tags, t.explicit, t.duration, t.energy_peak, t.created_at,
           u.username AS artist,
           (SELECT COUNT(*) FROM reactions r WHERE r.track_id = t.id AND r.value = 1) AS likes,
           (SELECT COUNT(*) FROM events e WHERE e.track_id = t.id AND e.type = 'play') AS plays,
           COALESCE((SELECT value FROM reactions mr WHERE mr.track_id = t.id AND mr.user_id = ?), 0) AS my_reaction
    FROM tracks t JOIN users u ON u.id = t.user_id`;

  const heatStmt = () => q('SELECT bin, heard, seeks FROM track_heat WHERE track_id = ?');
  const loadHeat = (trackId) => {
    const heat = { heard: new Array(BINS).fill(0), seeks: new Array(BINS).fill(0) };
    for (const r of heatStmt().all(trackId)) { heat.heard[r.bin] = r.heard; heat.seeks[r.bin] = r.seeks; }
    return heat;
  };

  const toTrack = (r) => ({
    moment: bestMoment(loadHeat(r.id), r.duration, r.energy_peak),
    id: r.id, title: r.title, description: r.description, tags: decodeTags(r.tags),
    explicit: Boolean(r.explicit), duration: r.duration, created_at: r.created_at,
    artist: { id: r.user_id, username: r.artist },
    likes: r.likes, plays: r.plays, my_reaction: r.my_reaction,
  });

  const getTrack = (id, viewerId = 0) => {
    const row = q(`${TRACK_SELECT} WHERE t.id = ?`).get(viewerId, id);
    if (!row) throw new HttpError(404, 'Трек не найден');
    return row;
  };

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler });
  };

  route('POST', '/api/register', async (req, res) => {
    const { username, password } = await readJson(req);
    const name = String(username ?? '').trim();
    if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(name)) throw new HttpError(400, 'Имя: 3–32 символа, буквы, цифры, _ . -');
    if (String(password ?? '').length < 8) throw new HttpError(400, 'Пароль — минимум 8 символов');
    if (q('SELECT 1 FROM users WHERE username = ?').get(name)) throw new HttpError(409, 'Имя уже занято');
    const { lastInsertRowid } = q('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)')
      .run(name, hashPassword(String(password)), Date.now());
    startSession(res, Number(lastInsertRowid), { id: Number(lastInsertRowid), username: name });
  });

  route('POST', '/api/login', async (req, res) => {
    const { username, password } = await readJson(req);
    const row = q('SELECT id, username, pass_hash FROM users WHERE username = ?').get(String(username ?? ''));
    if (!row || !verifyPassword(String(password ?? ''), row.pass_hash)) throw new HttpError(401, 'Неверное имя или пароль');
    startSession(res, row.id, { id: row.id, username: row.username });
  });

  route('POST', '/api/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) q('DELETE FROM sessions WHERE token = ?').run(token);
    send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  });

  route('GET', '/api/me', async (req, res) => send(res, 200, { user: currentUser(req) }));

  // Лента / поиск. Сортировка только по времени или по явным метрикам — никакой скрытой «выдачи».
  route('GET', '/api/tracks', async (req, res, _p, url) => {
    const me = currentUser(req);
    const where = [];
    const args = [me?.id ?? 0];
    const text = url.searchParams.get('q')?.trim();
    if (text) {
      where.push('(t.title LIKE ? OR u.username LIKE ? OR t.tags LIKE ? OR t.description LIKE ?)');
      const like = `%${text.replace(/[%_]/g, '')}%`;
      args.push(like, like, like, like);
    }
    const tag = parseTags(url.searchParams.get('tag') ?? '')[0];
    if (tag) { where.push('t.tags LIKE ?'); args.push(`%,${tag},%`); }
    const user = url.searchParams.get('user');
    if (user) { where.push('u.username = ?'); args.push(user); }
    if (url.searchParams.get('feed') === 'following' && me) {
      where.push('t.user_id IN (SELECT artist_id FROM follows WHERE follower_id = ?)');
      args.push(me.id);
    }
    const order = url.searchParams.get('sort') === 'top' ? 'likes DESC, t.created_at DESC' : 't.created_at DESC';
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const rows = q(`${TRACK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                    ORDER BY ${order} LIMIT ${limit}`).all(...args);
    send(res, 200, { tracks: rows.map(toTrack) });
  });

  route('GET', '/api/tracks/:id', async (req, res, p) => {
    send(res, 200, { track: toTrack(getTrack(Number(p.id), currentUser(req)?.id ?? 0)) });
  });

  // Загрузка: тело запроса — сам аудиофайл, метаданные — в query string.
  route('POST', '/api/tracks', async (req, res, _p, url) => {
    const me = requireUser(req);
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const ext = AUDIO_TYPES[mime];
    if (!ext) throw new HttpError(415, 'Поддерживаются mp3, ogg, opus, wav, flac, m4a, aac, webm');
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_UPLOAD) throw new HttpError(413, 'Файл больше 100 МБ');
    const title = String(url.searchParams.get('title') ?? '').trim().slice(0, 200);
    if (!title) throw new HttpError(400, 'Укажите название');

    const fileName = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    const filePath = path.join(uploadsDir, fileName);
    const size = await new Promise((resolve, reject) => {
      let total = 0;
      const out = fs.createWriteStream(filePath);
      const fail = (err) => { out.destroy(); fs.rm(filePath, { force: true }, () => reject(err)); };
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_UPLOAD) { req.destroy(); fail(new HttpError(413, 'Файл больше 100 МБ')); }
      });
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => resolve(total));
      req.pipe(out);
    });
    if (size === 0) { fs.rmSync(filePath, { force: true }); throw new HttpError(400, 'Пустой файл'); }

    const duration = Number(url.searchParams.get('duration'));
    const peak = Number(url.searchParams.get('peak'));
    const { lastInsertRowid } = q(`INSERT INTO tracks (user_id, title, description, tags, explicit, file, mime, size, duration, energy_peak, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      me.id, title, String(url.searchParams.get('description') ?? '').slice(0, 5000),
      encodeTags(parseTags(url.searchParams.get('tags'))), url.searchParams.get('explicit') === '1' ? 1 : 0,
      fileName, mime, size, Number.isFinite(duration) && duration > 0 ? duration : null,
      Number.isFinite(peak) && peak >= 0 ? peak : null, Date.now(),
    );
    send(res, 201, { track: toTrack(getTrack(Number(lastInsertRowid), me.id)) });
  });

  route('DELETE', '/api/tracks/:id', async (req, res, p) => {
    const me = requireUser(req);
    const row = q('SELECT user_id, file FROM tracks WHERE id = ?').get(Number(p.id));
    if (!row) throw new HttpError(404, 'Трек не найден');
    if (row.user_id !== me.id) throw new HttpError(403, 'Удалять можно только свои треки');
    q('DELETE FROM tracks WHERE id = ?').run(Number(p.id));
    fs.rm(path.join(uploadsDir, row.file), { force: true }, () => {});
    send(res, 200, { ok: true });
  });

  route('GET', '/api/tracks/:id/stream', async (req, res, p) => {
    const row = q('SELECT file, mime FROM tracks WHERE id = ?').get(Number(p.id));
    if (!row) throw new HttpError(404, 'Трек не найден');
    const filePath = path.join(uploadsDir, row.file);
    const { size } = fs.statSync(filePath);
    const base = { 'Content-Type': row.mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
                   'Cache-Control': 'private, max-age=3600' };
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { ...base, 'Content-Length': size });
      return fs.createReadStream(filePath).pipe(res);
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start, end;
    if (m && m[1] !== '') { start = Number(m[1]); end = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1; }
    else if (m && m[2] !== '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    if (!m || start === undefined || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });

  route('POST', '/api/tracks/:id/react', async (req, res, p) => {
    const me = requireUser(req);
    const id = Number(p.id);
    getTrack(id);
    const value = Math.sign(Number((await readJson(req)).value) || 0);
    if (value === 0) q('DELETE FROM reactions WHERE user_id = ? AND track_id = ?').run(me.id, id);
    else q(`INSERT INTO reactions (user_id, track_id, value, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (user_id, track_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`)
      .run(me.id, id, value, Date.now());
    send(res, 200, { track: toTrack(getTrack(id, me.id)) });
  });

  route('POST', '/api/tracks/:id/report', async (req, res, p) => {
    const me = requireUser(req);
    const id = Number(p.id);
    getTrack(id);
    const { reason, details } = await readJson(req);
    if (!REPORT_REASONS.has(reason)) throw new HttpError(400, 'Жалоба возможна только на нарушение закона или прав');
    q('INSERT INTO reports (user_id, track_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(me.id, id, reason, String(details ?? '').slice(0, 2000), Date.now());
    send(res, 201, { ok: true });
  });

  route('POST', '/api/events', async (req, res) => {
    const me = requireUser(req);
    const { track_id, type, position, duration } = await readJson(req);
    if (!EVENT_TYPES.has(type)) throw new HttpError(400, 'Неизвестный тип события');
    getTrack(Number(track_id));
    if (getSettings(me.id).private_mode) return send(res, 202, { ok: true, stored: false });
    const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
    q('INSERT INTO events (user_id, track_id, type, position, duration, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(me.id, Number(track_id), type, num(position), num(duration), Date.now());
    send(res, 201, { ok: true });
  });

  route('GET', '/api/likes', async (req, res) => {
    const me = requireUser(req);
    const rows = q(`${TRACK_SELECT} JOIN reactions lr ON lr.track_id = t.id AND lr.user_id = ? AND lr.value = 1
                    ORDER BY lr.created_at DESC`).all(me.id, me.id);
    send(res, 200, { tracks: rows.map(toTrack) });
  });

  route('GET', '/api/users/:name', async (req, res, p) => {
    const me = currentUser(req);
    const u = q('SELECT id, username, bio, created_at FROM users WHERE username = ?').get(decodeURIComponent(p.name));
    if (!u) throw new HttpError(404, 'Пользователь не найден');
    const followers = q('SELECT COUNT(*) AS n FROM follows WHERE artist_id = ?').get(u.id).n;
    const following = me ? Boolean(q('SELECT 1 FROM follows WHERE follower_id = ? AND artist_id = ?').get(me.id, u.id)) : false;
    const tracks = q(`${TRACK_SELECT} WHERE t.user_id = ? ORDER BY t.created_at DESC`).all(me?.id ?? 0, u.id).map(toTrack);
    send(res, 200, { user: { ...u, followers, following }, tracks });
  });

  route('POST', '/api/users/:name/follow', async (req, res, p) => {
    const me = requireUser(req);
    const u = q('SELECT id FROM users WHERE username = ?').get(decodeURIComponent(p.name));
    if (!u) throw new HttpError(404, 'Пользователь не найден');
    if (u.id === me.id) throw new HttpError(400, 'Нельзя подписаться на себя');
    const { follow } = await readJson(req);
    if (follow === false) q('DELETE FROM follows WHERE follower_id = ? AND artist_id = ?').run(me.id, u.id);
    else q('INSERT OR IGNORE INTO follows (follower_id, artist_id, created_at) VALUES (?, ?, ?)').run(me.id, u.id, Date.now());
    send(res, 200, { following: follow !== false });
  });

  // ---------- Волна ----------
  const getSettings = (userId) =>
    q('SELECT discovery, underground, hide_explicit, private_mode FROM wave_settings WHERE user_id = ?').get(userId)
    ?? { discovery: 0.5, underground: 0.5, hide_explicit: 0, private_mode: 0 };

  route('GET', '/api/wave/settings', async (req, res) => send(res, 200, { settings: getSettings(requireUser(req).id) }));

  route('PUT', '/api/wave/settings', async (req, res) => {
    const me = requireUser(req);
    const body = await readJson(req);
    const cur = getSettings(me.id);
    const unit = (x, d) => (Number.isFinite(Number(x)) ? Math.min(1, Math.max(0, Number(x))) : d);
    const next = {
      discovery: unit(body.discovery, cur.discovery),
      underground: unit(body.underground, cur.underground),
      hide_explicit: body.hide_explicit === undefined ? cur.hide_explicit : (body.hide_explicit ? 1 : 0),
      private_mode: body.private_mode === undefined ? cur.private_mode : (body.private_mode ? 1 : 0),
    };
    q(`INSERT INTO wave_settings (user_id, discovery, underground, hide_explicit, private_mode) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET discovery = excluded.discovery, underground = excluded.underground,
       hide_explicit = excluded.hide_explicit, private_mode = excluded.private_mode`)
      .run(me.id, next.discovery, next.underground, next.hide_explicit, next.private_mode);
    send(res, 200, { settings: next });
  });

  // MVP: считаем на лету. При росте каталога — предрасчёт co-likes и кандидатов в фоне (см. README).
  const loadRecoInputs = (me, url) => {
    const since = Date.now() - 180 * 24 * 3600 * 1000;
    const tracks = q(`SELECT t.id, t.user_id, t.title, t.tags, t.explicit, t.created_at, u.username AS artist
                      FROM tracks t JOIN users u ON u.id = t.user_id`).all()
      .map((r) => ({ ...r, tags: decodeTags(r.tags), explicit: Boolean(r.explicit) }));
    const stats = new Map();
    for (const r of q(`SELECT track_id, SUM(type = 'play') AS plays, SUM(type = 'complete') AS completes,
                       SUM(type = 'skip') AS skips FROM events GROUP BY track_id`).all()) {
      stats.set(r.track_id, { plays: r.plays, completes: r.completes, skips: r.skips, likes: 0 });
    }
    const allLikes = q('SELECT user_id, track_id FROM reactions WHERE value = 1').all();
    for (const l of allLikes) {
      const s = stats.get(l.track_id) ?? { plays: 0, completes: 0, skips: 0, likes: 0 };
      s.likes += 1;
      stats.set(l.track_id, s);
    }
    return {
      userId: me.id,
      tracks,
      events: q('SELECT track_id, type, position, duration, created_at FROM events WHERE user_id = ? AND created_at > ?').all(me.id, since),
      reactions: q('SELECT track_id, value, created_at FROM reactions WHERE user_id = ?').all(me.id),
      allLikes,
      stats,
      follows: new Set(q('SELECT artist_id FROM follows WHERE follower_id = ?').all(me.id).map((r) => r.artist_id)),
      settings: getSettings(me.id),
      tagOverrides: new Map(q('SELECT tag, action FROM taste_tags WHERE user_id = ?').all(me.id).map((r) => [r.tag, r.action])),
      exclude: new Set(String(url?.searchParams.get('exclude') ?? '').split(',').map(Number).filter(Boolean)),
    };
  };
  const hydrate = (me, result) => ({
    items: result.items.map((it) => ({ track: toTrack(getTrack(it.track.id, me.id)), reasons: it.reasons, score: it.score })),
    profile: result.profile,
  });

  route('GET', '/api/wave', async (req, res, _p, url) => {
    const me = requireUser(req);
    const count = Math.min(30, Math.max(1, Number(url.searchParams.get('count')) || 10));
    send(res, 200, hydrate(me, recommend({ ...loadRecoInputs(me, url), count })));
  });

  // Волна-мост: от одного тега к другому
  route('GET', '/api/wave/bridge', async (req, res, _p, url) => {
    const me = requireUser(req);
    const from = parseTags(url.searchParams.get('from'))[0];
    const to = parseTags(url.searchParams.get('to'))[0];
    if (!from || !to || from === to) throw new HttpError(400, 'Укажите два разных тега');
    const length = Math.min(30, Math.max(2, Number(url.searchParams.get('length')) || 8));
    send(res, 200, hydrate(me, bridge({ ...loadRecoInputs(me, url), from, to, length })));
  });

  route('GET', '/api/tags', async (req, res) => {
    const counts = new Map();
    for (const r of q('SELECT tags FROM tracks').all()) {
      for (const t of decodeTags(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    send(res, 200, { tags: [...counts].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })) });
  });

  // ---------- Тепловая карта и лучший момент ----------
  // Клиент присылает реально прозвучавшие отрезки и точки перемотки (после ухода с трека).
  route('POST', '/api/tracks/:id/listen', async (req, res, p) => {
    const me = requireUser(req);
    const id = Number(p.id);
    const row = q('SELECT duration FROM tracks WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Трек не найден');
    if (getSettings(me.id).private_mode) return send(res, 202, { ok: true, stored: false });
    const body = await readJson(req);
    const duration = row.duration ?? Number(body.duration);
    if (!(duration > 0)) throw new HttpError(400, 'Неизвестна длительность');
    if (!row.duration) q('UPDATE tracks SET duration = ? WHERE id = ?').run(duration, id);
    const segments = Array.isArray(body.segments) ? body.segments.slice(0, 200) : [];
    const seeks = Array.isArray(body.seeks) ? body.seeks.slice(0, 50) : [];
    const upsert = q(`INSERT INTO track_heat (track_id, bin, heard, seeks) VALUES (?, ?, ?, ?)
      ON CONFLICT (track_id, bin) DO UPDATE SET heard = heard + excluded.heard, seeks = seeks + excluded.seeks`);
    // каждый бин засчитывается одному слушателю максимум один раз за прослушивание
    for (const bin of segmentsToBins(segments, duration)) upsert.run(id, bin, 1, 0);
    const seekBins = new Set(seeks.map((t) => seekBin(Number(t), duration)).filter((b) => b !== null));
    for (const bin of seekBins) upsert.run(id, bin, 0, 1);
    send(res, 201, { ok: true });
  });

  route('GET', '/api/tracks/:id/heat', async (req, res, p) => {
    const row = getTrack(Number(p.id));
    const heat = loadHeat(row.id);
    send(res, 200, { heat, moment: bestMoment(heat, row.duration, row.energy_peak) });
  });

  // ---------- Прозрачный вкус ----------
  route('GET', '/api/taste', async (req, res) => {
    const me = requireUser(req);
    const inputs = loadRecoInputs(me, null);
    const ctx = buildContext(inputs);
    const profile = describeProfile(ctx);
    profile.influences = profile.influences.map((i) => ({ ...i, track: toTrack(getTrack(i.track_id, me.id)) }));
    send(res, 200, {
      profile,
      overrides: [...inputs.tagOverrides].map(([tag, action]) => ({ tag, action })),
      settings: inputs.settings,
    });
  });

  route('PUT', '/api/taste/tags', async (req, res) => {
    const me = requireUser(req);
    const { tag: rawTag, action } = await readJson(req);
    const tag = parseTags(rawTag)[0];
    if (!tag) throw new HttpError(400, 'Укажите тег');
    if (action == null) q('DELETE FROM taste_tags WHERE user_id = ? AND tag = ?').run(me.id, tag);
    else if (!TASTE_ACTIONS.has(action)) throw new HttpError(400, 'Действие: forget, boost или block');
    else q(`INSERT INTO taste_tags (user_id, tag, action, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (user_id, tag) DO UPDATE SET action = excluded.action, created_at = excluded.created_at`)
      .run(me.id, tag, action, Date.now());
    send(res, 200, { ok: true });
  });

  // «Забыть трек»: убирает его из истории и оценок — волна перестаёт на него опираться
  route('DELETE', '/api/taste/tracks/:id', async (req, res, p) => {
    const me = requireUser(req);
    q('DELETE FROM events WHERE user_id = ? AND track_id = ?').run(me.id, Number(p.id));
    q('DELETE FROM reactions WHERE user_id = ? AND track_id = ?').run(me.id, Number(p.id));
    send(res, 200, { ok: true });
  });

  // ---------- static ----------
  const serveStatic = (req, res, pathname) => {
    let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Запрещено');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');
        return serveStatic(req, res, url.pathname);
      }
      for (const r of routes) {
        const m = r.method === req.method && r.re.exec(url.pathname);
        if (m) {
          const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
          return await r.handler(req, res, params, url);
        }
      }
      throw new HttpError(404, 'Не найдено');
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (!res.headersSent) send(res, err.status ?? 500, { error: err instanceof HttpError ? err.message : 'Внутренняя ошибка' });
      else res.destroy();
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  createApp({ dataDir: process.env.DATA_DIR }).listen(port, () => {
    console.log(`NEYAMI запущен: http://localhost:${port}`);
  });
}
