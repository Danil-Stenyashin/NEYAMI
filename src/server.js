import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, parseTags, encodeTags, decodeTags } from './db.js';
import { hashPassword, verifyPassword, newToken, parseCookies } from './auth.js';
import { recommend, bridge, buildContext, describeProfile, buildContextSignals, buildProfiles, applyTagOverrides, buildSoundProfile } from './recommender.js';
import { sanitizeFeatures, describeSound } from './sound.js';
import { BINS, bestMoment, segmentsToBins, seekBin } from './moments.js';
import { archiveSearch, archiveItem, archiveFetchTracks, jamendoSearch, jamendoFetchTracks, ImportError } from './importers.js';
import { coverSvg } from './covers.js';
import { parseLink, soundcloudInfo } from './links.js';
import { DEMO_DESCRIPTION } from './demo.js';

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
  '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8', '.json': 'application/json; charset=utf-8',
};
const TASTE_ACTIONS = new Set(['forget', 'boost', 'block']);
const EVENT_TYPES = new Set(['play', 'complete', 'skip', 'preview_complete', 'preview_skip']);
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_COVER = 5 * 1024 * 1024;
const REPORT_REASONS = new Set(['copyright', 'illegal', 'spam', 'impersonation']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({ dataDir = path.join(ROOT, 'data'), fetchImpl = globalThis.fetch } = {}) {
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

  const readBody = (req, limit) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Слишком большой файл')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

  // За HTTPS-прокси или туннелем (например, для iPhone вне дома) cookie помечается Secure
  const isHttps = (req) => req.socket.encrypted || String(req.headers['x-forwarded-proto'] ?? '').startsWith('https');

  const startSession = (req, res, userId, user) => {
    const token = newToken();
    q('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
    send(res, 200, { user }, {
      'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${isHttps(req) ? '; Secure' : ''}`,
    });
  };

  const TRACK_SELECT = `
    SELECT t.id, t.user_id, t.title, t.description, t.tags, t.explicit, t.duration, t.energy_peak, t.features, t.created_at,
           t.cover, t.source, t.source_url, t.license, t.added_by, t.embed_url,
           u.username AS artist, u.imported AS artist_imported,
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

  const toTrack = (r, viewerId = 0) => ({
    moment: bestMoment(loadHeat(r.id), r.duration, r.energy_peak),
    cover: `/api/tracks/${r.id}/cover${r.cover ? `?v=${r.cover.slice(0, 8)}` : ''}`,
    source: r.source ?? 'upload', source_url: r.source_url ?? null, license: r.license ?? null,
    embed: r.embed_url ?? null, // трек по ссылке — играет официальный плеер сервиса
    can_edit: Boolean(viewerId) && (r.user_id === viewerId || r.added_by === viewerId),
    id: r.id, title: r.title, description: r.description, tags: decodeTags(r.tags),
    explicit: Boolean(r.explicit), duration: r.duration, created_at: r.created_at,
    artist: { id: r.user_id, username: r.artist },
    likes: r.likes, plays: r.plays, my_reaction: r.my_reaction,
    features: sanitizeFeatures(r.features),
  });

  /**
   * Артист для трека, загруженного не самим автором (папка, импорт).
   * Привязываем только к «импортированным» артистам — к профилю живого человека чужой трек не прилипнет.
   */
  const resolveArtist = (rawName, me) => {
    const name = String(rawName ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name || name.toLowerCase() === me.username.toLowerCase()) return me.id;
    for (const candidate of [name, `${name} (импорт)`]) {
      const row = q('SELECT id, imported FROM users WHERE username = ?').get(candidate);
      if (row?.imported) return row.id;
      if (!row) {
        const { lastInsertRowid } = q('INSERT INTO users (username, pass_hash, bio, imported, created_at) VALUES (?, ?, ?, 1, ?)')
          .run(candidate, '!', 'Артист добавлен вместе с треками', Date.now());
        return Number(lastInsertRowid);
      }
    }
    return me.id;
  };

  const saveCover = (buf, type) => {
    const ext = IMAGE_TYPES[String(type ?? '').toLowerCase()];
    if (!ext || !buf?.length || buf.length > MAX_COVER) return null;
    const name = `cover-${crypto.randomBytes(12).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, name), buf);
    return name;
  };

  /** Сохраняет трек из памяти (импорт). Возвращает id. */
  const insertImported = (t, me) => {
    const fileName = `${crypto.randomBytes(16).toString('hex')}.mp3`;
    fs.writeFileSync(path.join(uploadsDir, fileName), t.audio);
    const artistId = resolveArtist(t.artist, me);
    const cover = t.cover ? saveCover(t.cover.buf, t.cover.type) : null;
    const { lastInsertRowid } = q(`INSERT INTO tracks (user_id, title, description, tags, explicit, file, mime, size, duration,
        cover, source, source_url, license, added_by, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      artistId, t.title || 'Без названия', t.description ?? '', encodeTags(parseTags(t.tags)), fileName, t.mime,
      t.audio.length, t.duration ?? null, cover, t.source, t.sourceUrl ?? null, t.license ?? null,
      artistId === me.id ? null : me.id, Date.now(),
    );
    return Number(lastInsertRowid);
  };

  /**
   * Синтезированные демо-треки нужны, только пока нет настоящей музыки.
   * Как только её набирается достаточно — убираем их, чтобы не мешали волне.
   */
  const DEMO_LIMIT = 10;
  const cleanupDemo = () => {
    const real = q('SELECT COUNT(*) AS n FROM tracks WHERE description != ?').get(DEMO_DESCRIPTION).n;
    if (real < DEMO_LIMIT) return 0;
    const demo = q('SELECT id, file, cover FROM tracks WHERE description = ?').all(DEMO_DESCRIPTION);
    for (const t of demo) {
      q('DELETE FROM tracks WHERE id = ?').run(t.id);
      if (t.file) fs.rm(path.join(uploadsDir, t.file), { force: true }, () => {});
    }
    return demo.length;
  };

  const canEdit = (trackId, me) => {
    const row = q('SELECT user_id, added_by, file, cover FROM tracks WHERE id = ?').get(trackId);
    if (!row) throw new HttpError(404, 'Трек не найден');
    if (row.user_id !== me.id && row.added_by !== me.id) throw new HttpError(403, 'Это может только тот, кто добавил трек');
    return row;
  };

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
    startSession(req, res, Number(lastInsertRowid), { id: Number(lastInsertRowid), username: name });
  });

  route('POST', '/api/login', async (req, res) => {
    const { username, password } = await readJson(req);
    const row = q('SELECT id, username, pass_hash FROM users WHERE username = ?').get(String(username ?? ''));
    if (!row || !verifyPassword(String(password ?? ''), row.pass_hash)) throw new HttpError(401, 'Неверное имя или пароль');
    startSession(req, res, row.id, { id: row.id, username: row.username });
  });

  route('POST', '/api/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) q('DELETE FROM sessions WHERE token = ?').run(token);
    send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  });

  const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return ''; } })();
  route('GET', '/api/me', async (req, res) => send(res, 200, { user: currentUser(req), version: VERSION }));

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
    send(res, 200, { tracks: rows.map((r) => toTrack(r, me?.id ?? 0)) });
  });

  route('GET', '/api/tracks/:id', async (req, res, p) => {
    const viewer = currentUser(req)?.id ?? 0;
    send(res, 200, { track: toTrack(getTrack(Number(p.id), viewer), viewer) });
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
    const features = sanitizeFeatures(url.searchParams.get('features'));
    // Из своей папки можно добавить трек другого артиста (по тегам файла)
    const artistId = url.searchParams.get('artist') ? resolveArtist(url.searchParams.get('artist'), me) : me.id;
    const source = url.searchParams.get('source') === 'folder' ? 'folder' : 'upload';
    const { lastInsertRowid } = q(`INSERT INTO tracks (user_id, title, description, tags, explicit, file, mime, size, duration, energy_peak, features,
      source, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      artistId, title, String(url.searchParams.get('description') ?? '').slice(0, 5000),
      encodeTags(parseTags(url.searchParams.get('tags'))), url.searchParams.get('explicit') === '1' ? 1 : 0,
      fileName, mime, size, Number.isFinite(duration) && duration > 0 ? duration : null,
      Number.isFinite(peak) && peak >= 0 ? peak : null, features ? JSON.stringify(features) : null,
      source, artistId === me.id ? null : me.id, Date.now(),
    );
    cleanupDemo();
    send(res, 201, { track: toTrack(getTrack(Number(lastInsertRowid), me.id), me.id) });
  });

  route('DELETE', '/api/tracks/:id', async (req, res, p) => {
    const me = requireUser(req);
    const row = canEdit(Number(p.id), me);
    q('DELETE FROM tracks WHERE id = ?').run(Number(p.id));
    if (row.file) fs.rm(path.join(uploadsDir, row.file), { force: true }, () => {});
    if (row.cover) fs.rm(path.join(uploadsDir, row.cover), { force: true }, () => {});
    send(res, 200, { ok: true });
  });

  // ---------- обложки ----------
  route('GET', '/api/tracks/:id/cover', async (req, res, p) => {
    const row = q('SELECT t.id, t.title, t.cover, u.username AS artist FROM tracks t JOIN users u ON u.id = t.user_id WHERE t.id = ?').get(Number(p.id));
    if (!row) throw new HttpError(404, 'Трек не найден');
    const file = row.cover && path.join(uploadsDir, row.cover);
    if (file && fs.existsSync(file)) {
      const type = Object.entries(IMAGE_TYPES).find(([, e]) => file.endsWith(`.${e}`))?.[0] ?? 'image/jpeg';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.end(coverSvg(row.id, row.title, row.artist));
  });

  route('POST', '/api/tracks/:id/cover', async (req, res, p) => {
    const me = requireUser(req);
    const row = canEdit(Number(p.id), me);
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES[type]) throw new HttpError(415, 'Обложка: jpg, png, webp или gif');
    const buf = await readBody(req, MAX_COVER);
    const name = saveCover(buf, type);
    if (!name) throw new HttpError(400, 'Не удалось сохранить обложку');
    q('UPDATE tracks SET cover = ? WHERE id = ?').run(name, Number(p.id));
    if (row.cover) fs.rm(path.join(uploadsDir, row.cover), { force: true }, () => {});
    send(res, 200, { track: toTrack(getTrack(Number(p.id), me.id), me.id) });
  });

  // Анализ звука для треков, добавленных импортом: браузер декодирует и присылает признаки
  route('PUT', '/api/tracks/:id/analysis', async (req, res, p) => {
    const me = requireUser(req);
    canEdit(Number(p.id), me);
    const { duration, peak, features } = await readJson(req);
    const f = sanitizeFeatures(features);
    q(`UPDATE tracks SET duration = COALESCE(?, duration), energy_peak = COALESCE(?, energy_peak),
       features = COALESCE(?, features) WHERE id = ?`).run(
      Number(duration) > 0 ? Number(duration) : null, Number(peak) >= 0 ? Number(peak) : null,
      f ? JSON.stringify(f) : null, Number(p.id));
    send(res, 200, { ok: true });
  });

  // ---------- импорт свободной музыки ----------
  const importErr = (e) => {
    if (e instanceof ImportError) throw new HttpError(400, e.message);
    if (e instanceof HttpError) throw e;
    console.error('Импорт:', e);
    const why = e?.cause?.code || e?.cause?.message || e?.message || 'неизвестная ошибка';
    throw new HttpError(502, `Не удалось связаться с источником (${String(why).slice(0, 120)}). Проверьте интернет и попробуйте ещё раз`);
  };
  const jamendoKey = () => q("SELECT value FROM app_settings WHERE key = 'jamendo_key'").get()?.value ?? process.env.JAMENDO_KEY ?? '';

  route('GET', '/api/import/settings', async (req, res) => {
    requireUser(req);
    send(res, 200, { jamendo: Boolean(jamendoKey()) });
  });
  route('PUT', '/api/import/settings', async (req, res) => {
    requireUser(req);
    const key = String((await readJson(req)).jamendo_key ?? '').trim();
    if (key && !/^[A-Za-z0-9]{4,64}$/.test(key)) throw new HttpError(400, 'Ключ Jamendo выглядит неправильно');
    if (key) q("INSERT INTO app_settings (key, value) VALUES ('jamendo_key', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key);
    else q("DELETE FROM app_settings WHERE key = 'jamendo_key'").run();
    send(res, 200, { jamendo: Boolean(key) });
  });

  // Трек по ссылке (SoundCloud / Яндекс Музыка): сохраняем только ссылку и описание, звук не храним
  route('POST', '/api/tracks/link', async (req, res) => {
    const me = requireUser(req);
    const body = await readJson(req);
    const link = (() => { try { return parseLink(body.url); } catch (e) { return importErr(e); } })();
    const dupe = q('SELECT id FROM tracks WHERE embed_url = ?').get(link.embed);
    if (dupe) return send(res, 200, { track: toTrack(getTrack(dupe.id, me.id), me.id), existed: true });
    let info = { title: '', artist: '', cover: null };
    if (link.service === 'soundcloud') info = await soundcloudInfo(fetchImpl, link.page).catch(importErr);
    const title = String(body.title ?? '').trim().slice(0, 200) || info.title;
    const artist = String(body.artist ?? '').trim().slice(0, 100) || info.artist;
    if (!title) throw new HttpError(400, 'Укажите название трека');
    if (!artist) throw new HttpError(400, 'Укажите артиста');
    const artistId = resolveArtist(artist, me);
    const cover = info.cover ? saveCover(info.cover.buf, info.cover.type) : null;
    const service = link.service === 'soundcloud' ? 'SoundCloud' : 'Яндекс Музыки';
    const { lastInsertRowid } = q(`INSERT INTO tracks (user_id, title, description, tags, explicit, file, mime, size, cover, source,
        source_url, embed_url, added_by, created_at) VALUES (?, ?, ?, ?, 0, '', 'text/html', 0, ?, ?, ?, ?, ?, ?)`).run(
      artistId, title, `Играет через официальный плеер ${service}.`, encodeTags(parseTags(body.tags)), cover,
      link.service, link.page, link.embed, artistId === me.id ? null : me.id, Date.now());
    send(res, 201, { track: toTrack(getTrack(Number(lastInsertRowid), me.id), me.id) });
  });

  route('GET', '/api/import/archive', async (req, res, _p, url) => {
    requireUser(req);
    const items = await archiveSearch(fetchImpl, url.searchParams.get('q')).catch(importErr);
    send(res, 200, { items });
  });
  route('GET', '/api/import/archive/:id', async (req, res, p) => {
    requireUser(req);
    send(res, 200, { item: await archiveItem(fetchImpl, decodeURIComponent(p.id)).catch(importErr) });
  });
  route('POST', '/api/import/archive', async (req, res) => {
    const me = requireUser(req);
    const { id, files, limit } = await readJson(req);
    const list = await archiveFetchTracks(fetchImpl, String(id ?? ''), {
      files: Array.isArray(files) ? files.map(String) : null,
      limit: Math.min(12, Math.max(1, Number(limit) || 6)),
    }).catch(importErr);
    const ids = list.map((t) => insertImported(t, me));
    cleanupDemo();
    send(res, 201, { tracks: ids.map((i) => toTrack(getTrack(i, me.id), me.id)) });
  });
  route('GET', '/api/import/jamendo', async (req, res, _p, url) => {
    requireUser(req);
    send(res, 200, { tracks: await jamendoSearch(fetchImpl, jamendoKey(), url.searchParams.get('q')).catch(importErr) });
  });
  route('POST', '/api/import/jamendo', async (req, res) => {
    const me = requireUser(req);
    const { ids } = await readJson(req);
    const list = await jamendoFetchTracks(fetchImpl, jamendoKey(), ids).catch(importErr);
    const saved = list.map((t) => insertImported(t, me));
    cleanupDemo();
    send(res, 201, { tracks: saved.map((i) => toTrack(getTrack(i, me.id), me.id)) });
  });

  route('GET', '/api/tracks/:id/stream', async (req, res, p) => {
    const row = q('SELECT file, mime FROM tracks WHERE id = ?').get(Number(p.id));
    if (!row) throw new HttpError(404, 'Трек не найден');
    if (!row.file) throw new HttpError(404, 'Этот трек играет через плеер SoundCloud или Яндекс Музыки');
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
    // новая оценка — новое мнение: отметка «забыт» снимается
    q('DELETE FROM taste_forgotten WHERE user_id = ? AND track_id = ?').run(me.id, id);
    if (value === 0) q('DELETE FROM reactions WHERE user_id = ? AND track_id = ?').run(me.id, id);
    else q(`INSERT INTO reactions (user_id, track_id, value, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (user_id, track_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`)
      .run(me.id, id, value, Date.now());
    send(res, 200, { track: toTrack(getTrack(id, me.id), me.id) });
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
    send(res, 200, { tracks: rows.map((r) => toTrack(r, me?.id ?? 0)) });
  });

  route('GET', '/api/users/:name', async (req, res, p) => {
    const me = currentUser(req);
    const u = q('SELECT id, username, bio, created_at FROM users WHERE username = ?').get(decodeURIComponent(p.name));
    if (!u) throw new HttpError(404, 'Пользователь не найден');
    const followers = q('SELECT COUNT(*) AS n FROM follows WHERE artist_id = ?').get(u.id).n;
    const following = me ? Boolean(q('SELECT 1 FROM follows WHERE follower_id = ? AND artist_id = ?').get(me.id, u.id)) : false;
    const tracks = q(`${TRACK_SELECT} WHERE t.user_id = ? ORDER BY t.created_at DESC`).all(me?.id ?? 0, u.id).map((r) => toTrack(r, me?.id ?? 0));
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
    q('SELECT discovery, underground, hide_explicit, private_mode, context FROM wave_settings WHERE user_id = ?').get(userId)
    ?? { discovery: 0.5, underground: 0.5, hide_explicit: 0, private_mode: 0, context: 1 };

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
      context: body.context === undefined ? cur.context : (body.context ? 1 : 0),
    };
    q(`INSERT INTO wave_settings (user_id, discovery, underground, hide_explicit, private_mode, context) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET discovery = excluded.discovery, underground = excluded.underground,
       hide_explicit = excluded.hide_explicit, private_mode = excluded.private_mode, context = excluded.context`)
      .run(me.id, next.discovery, next.underground, next.hide_explicit, next.private_mode, next.context);
    send(res, 200, { settings: next });
  });

  // MVP: считаем на лету. При росте каталога — предрасчёт co-likes и кандидатов в фоне (см. README).
  // Смещение часового пояса клиента (как Date#getTimezoneOffset), нужно для «волны по контексту»
  const parseTz = (url) => {
    const tz = Number(url?.searchParams.get('tz'));
    return Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0;
  };
  const loadRecoInputs = (me, url) => {
    const since = Date.now() - 180 * 24 * 3600 * 1000;
    const tracks = q(`SELECT t.id, t.user_id, t.title, t.tags, t.explicit, t.features, t.created_at, u.username AS artist
                      FROM tracks t JOIN users u ON u.id = t.user_id`).all()
      .map((r) => ({ ...r, tags: decodeTags(r.tags), explicit: Boolean(r.explicit), features: sanitizeFeatures(r.features) }));
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
      // оценки «забытых» треков не учитываются, пока человек не оценит трек заново
      reactions: q(`SELECT r.track_id, r.value, r.created_at FROM reactions r
                    LEFT JOIN taste_forgotten f ON f.user_id = r.user_id AND f.track_id = r.track_id
                    WHERE r.user_id = ? AND (f.created_at IS NULL OR r.created_at > f.created_at)`).all(me.id),
      allLikes,
      stats,
      follows: new Set(q('SELECT artist_id FROM follows WHERE follower_id = ?').all(me.id).map((r) => r.artist_id)),
      settings: getSettings(me.id),
      tagOverrides: new Map(q('SELECT tag, action FROM taste_tags WHERE user_id = ?').all(me.id).map((r) => [r.tag, r.action])),
      exclude: new Set(String(url?.searchParams.get('exclude') ?? '').split(',').map(Number).filter(Boolean)),
      tzOffset: parseTz(url),
    };
  };
  const hydrate = (me, result) => ({
    items: result.items.map((it) => ({ track: toTrack(getTrack(it.track.id, me.id), me.id), reasons: it.reasons, score: it.score })),
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
  route('GET', '/api/taste', async (req, res, _p, url) => {
    const me = requireUser(req);
    const inputs = loadRecoInputs(me, url);
    const ctx = buildContext(inputs);
    const profile = describeProfile(ctx);
    profile.influences = profile.influences.map((i) => ({ ...i, track: toTrack(getTrack(i.track_id, me.id), me.id) }));
    // Вкус по времени суток: середины слотов «ночь / утро / день / вечер», будни и выходные
    const now = Date.now();
    profile.bySlot = [];
    for (const weekend of [false, true]) {
      for (const hour of [3, 9, 15, 21]) {
        const cs = buildContextSignals({ events: inputs.events, reactions: inputs.reactions, now, target: { hour, weekend }, tzOffset: inputs.tzOffset });
        const tags = applyTagOverrides(buildProfiles(cs.signal, ctx.trackById).tags, inputs.tagOverrides);
        const sound = buildSoundProfile(cs.signal, ctx.trackById).like;
        profile.bySlot.push({
          hour, weekend, confidence: Math.round(cs.confidence * 100) / 100,
          topTags: [...tags].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4),
          sound: sound ? describeSound(sound) : null,
        });
      }
    }
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

  // «Забыть трек»: волна перестаёт на него опираться. История прослушиваний стирается,
  // а лайк остаётся в «Мне нравится» — коллекцию человек не теряет.
  route('DELETE', '/api/taste/tracks/:id', async (req, res, p) => {
    const me = requireUser(req);
    const id = Number(p.id);
    getTrack(id);
    q('DELETE FROM events WHERE user_id = ? AND track_id = ?').run(me.id, id);
    q(`INSERT INTO taste_forgotten (user_id, track_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, track_id) DO UPDATE SET created_at = excluded.created_at`).run(me.id, id, Date.now() + 1);
    send(res, 200, { ok: true });
  });

  // ---------- static ----------
  const serveStatic = (req, res, pathname) => {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'Некорректный адрес'); }
    let file = path.normalize(path.join(PUBLIC_DIR, decoded));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Запрещено');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      // код приложения всегда перепроверяется — обновления видны сразу; иконки можно кэшировать
      'Cache-Control': ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
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
