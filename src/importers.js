/**
 * Импорт свободной музыки (Creative Commons) из Internet Archive и Jamendo.
 *
 * Сервер сам скачивает файлы, поэтому адреса никогда не берутся из запроса как есть:
 * они собираются из проверенных идентификаторов, а после переадресаций проверяется,
 * что файл пришёл с хоста этого сервиса (защита от SSRF). Размер файла ограничен.
 * fetch передаётся снаружи — так модуль легко тестировать без сети.
 */

const IA = 'https://archive.org';
const JAMENDO = 'https://api.jamendo.com/v3.0';
const MAX_AUDIO = 60 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

export class ImportError extends Error {}

const hostOk = (url, suffixes) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && suffixes.some((s) => hostname === s || hostname.endsWith(`.${s}`));
  } catch { return false; }
};
const IA_HOSTS = ['archive.org'];
const JAMENDO_HOSTS = ['jamendo.com'];

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new ImportError(`Источник ответил ошибкой ${res.status}`);
  return res.json();
}

/** Скачивает файл целиком в память с ограничением размера и проверкой хоста после переадресаций. */
export async function download(fetchImpl, url, { hosts, max, kind }) {
  if (!hostOk(url, hosts)) throw new ImportError('Недопустимый адрес файла');
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new ImportError(`Не удалось скачать файл (${res.status})`);
  if (res.url && !hostOk(res.url, hosts)) throw new ImportError('Файл переадресован на чужой сервер');
  const type = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (kind === 'audio' && type && !type.startsWith('audio/') && type !== 'application/octet-stream') {
    throw new ImportError('По ссылке не аудиофайл');
  }
  if (kind === 'image' && type && !type.startsWith('image/')) throw new ImportError('По ссылке не картинка');
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) throw new ImportError('Файл слишком большой');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new ImportError('Файл слишком большой');
  if (!buf.length) throw new ImportError('Пустой файл');
  return { buf, type };
}

const licenseName = (url) => {
  const m = /creativecommons\.org\/(?:licenses|publicdomain)\/([a-z-]+)\/?([\d.]+)?/i.exec(String(url ?? ''));
  if (!m) return url ? 'свободная лицензия' : '';
  return m[1].toLowerCase() === 'zero' || m[1].toLowerCase() === 'mark' ? 'общественное достояние' : `CC ${m[1].toUpperCase()}${m[2] ? ` ${m[2]}` : ''}`;
};

const first = (v) => (Array.isArray(v) ? v[0] : v);
const splitSubjects = (s) => (Array.isArray(s) ? s : String(s ?? '').split(/[;,]/)).map((x) => String(x).trim()).filter(Boolean);

// ---------------- Internet Archive ----------------

/** Поиск альбомов/подборок под свободной лицензией. */
export async function archiveSearch(fetchImpl, query, { rows = 24 } = {}) {
  const q = String(query ?? '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim().slice(0, 80);
  if (!q) return [];
  const params = new URLSearchParams({
    q: `(${q}) AND mediatype:(audio) AND licenseurl:(*creativecommons* OR *publicdomain*)`,
    rows: String(rows),
    output: 'json',
    sort: 'downloads desc',
  });
  for (const f of ['identifier', 'title', 'creator', 'licenseurl', 'subject', 'year']) params.append('fl[]', f);
  const data = await getJson(fetchImpl, `${IA}/advancedsearch.php?${params}`);
  return (data?.response?.docs ?? [])
    .filter((d) => ID_RE.test(d.identifier ?? ''))
    .map((d) => ({
      id: d.identifier,
      title: String(first(d.title) ?? d.identifier).slice(0, 200),
      artist: String(first(d.creator) ?? 'Неизвестный автор').slice(0, 100),
      license: d.licenseurl ?? null,
      licenseName: licenseName(d.licenseurl),
      tags: splitSubjects(d.subject).slice(0, 6),
      year: d.year ?? null,
      cover: `${IA}/services/img/${d.identifier}`,
      page: `${IA}/details/${d.identifier}`,
    }));
}

/** Треки внутри альбома: только mp3, с названиями и длительностью. */
export async function archiveItem(fetchImpl, id) {
  if (!ID_RE.test(String(id))) throw new ImportError('Некорректный идентификатор');
  const data = await getJson(fetchImpl, `${IA}/metadata/${id}`);
  const meta = data?.metadata ?? {};
  const files = (data?.files ?? [])
    .filter((f) => /\.mp3$/i.test(f.name ?? '') && !/_64kb\.mp3$/i.test(f.name) && !f.name.includes('/..'))
    .map((f) => ({
      file: f.name,
      title: String(f.title ?? f.name.replace(/\.mp3$/i, '').replace(/^\d+[\s._-]+/, '')).slice(0, 200),
      artist: String(f.creator ?? f.artist ?? first(meta.creator) ?? 'Неизвестный автор').slice(0, 100),
      duration: parseLength(f.length),
      size: Number(f.size) || null,
    }));
  return {
    id,
    title: String(first(meta.title) ?? id),
    artist: String(first(meta.creator) ?? 'Неизвестный автор'),
    license: meta.licenseurl ?? null,
    licenseName: licenseName(meta.licenseurl),
    tags: splitSubjects(meta.subject).slice(0, 6),
    cover: `${IA}/services/img/${id}`,
    page: `${IA}/details/${id}`,
    tracks: files,
  };
}

function parseLength(v) {
  if (v == null) return null;
  if (/^\d+(\.\d+)?$/.test(String(v))) return Number(v);
  const parts = String(v).split(':').map(Number);
  if (parts.some((x) => !Number.isFinite(x))) return null;
  return parts.reduce((a, x) => a * 60 + x, 0);
}

/** Готовит треки альбома к сохранению: аудио и обложка скачаны, метаданные проверены. */
export async function archiveFetchTracks(fetchImpl, id, { files = null, limit = 10 } = {}) {
  const item = await archiveItem(fetchImpl, id);
  if (!item.license) throw new ImportError('У этой записи нет свободной лицензии');
  let chosen = item.tracks;
  if (Array.isArray(files) && files.length) chosen = chosen.filter((t) => files.includes(t.file));
  chosen = chosen.filter((t) => !t.size || t.size <= MAX_AUDIO).slice(0, limit);
  if (!chosen.length) throw new ImportError('В записи нет подходящих mp3');
  const cover = await download(fetchImpl, item.cover, { hosts: IA_HOSTS, max: MAX_IMAGE, kind: 'image' }).catch(() => null);
  const out = [];
  for (const t of chosen) {
    const url = `${IA}/download/${encodeURIComponent(id)}/${t.file.split('/').map(encodeURIComponent).join('/')}`;
    const audio = await download(fetchImpl, url, { hosts: IA_HOSTS, max: MAX_AUDIO, kind: 'audio' });
    out.push({
      title: t.title, artist: t.artist, tags: item.tags, duration: t.duration,
      audio: audio.buf, mime: 'audio/mpeg', cover,
      source: 'archive', sourceUrl: item.page, license: item.license,
      description: `Из Internet Archive: «${item.title}». Лицензия: ${item.licenseName}.`,
    });
  }
  return out;
}

// ---------------- Jamendo ----------------

const jamendoTrack = (t) => ({
  id: String(t.id),
  title: String(t.name ?? '').slice(0, 200),
  artist: String(t.artist_name ?? 'Неизвестный автор').slice(0, 100),
  album: t.album_name ?? '',
  duration: Number(t.duration) || null,
  cover: t.image || t.album_image || null,
  audio: t.audiodownload_allowed === false ? null : (t.audiodownload || t.audio || null),
  license: t.license_ccurl ?? null,
  licenseName: licenseName(t.license_ccurl),
  tags: [...(t.musicinfo?.tags?.genres ?? []), ...(t.musicinfo?.tags?.vartags ?? [])].slice(0, 6),
  page: t.shareurl ?? null,
});

export async function jamendoSearch(fetchImpl, key, query, { limit = 24 } = {}) {
  if (!key) throw new ImportError('Нужен ключ Jamendo — его можно получить бесплатно на developer.jamendo.com');
  const params = new URLSearchParams({
    client_id: key, format: 'json', limit: String(limit), include: 'musicinfo',
    audioformat: 'mp32', order: 'popularity_total', search: String(query ?? '').slice(0, 80),
  });
  const data = await getJson(fetchImpl, `${JAMENDO}/tracks/?${params}`);
  if (data?.headers?.status === 'failed') throw new ImportError(data.headers.error_message || 'Jamendo отклонил запрос (проверьте ключ)');
  return (data?.results ?? []).map(jamendoTrack).filter((t) => t.audio);
}

/** Треки заново запрашиваются по id через API — адресам из браузера не доверяем. */
export async function jamendoFetchTracks(fetchImpl, key, ids) {
  const clean = [...new Set((ids ?? []).map(String).filter((x) => /^\d{1,12}$/.test(x)))].slice(0, 20);
  if (!clean.length) throw new ImportError('Не выбраны треки');
  const params = new URLSearchParams({ client_id: key, format: 'json', include: 'musicinfo', audioformat: 'mp32', limit: String(clean.length) });
  for (const id of clean) params.append('id[]', id);
  const data = await getJson(fetchImpl, `${JAMENDO}/tracks/?${params}`);
  const out = [];
  for (const t of (data?.results ?? []).map(jamendoTrack)) {
    if (!t.audio) continue;
    const audio = await download(fetchImpl, t.audio, { hosts: JAMENDO_HOSTS, max: MAX_AUDIO, kind: 'audio' });
    const cover = t.cover
      ? await download(fetchImpl, t.cover, { hosts: JAMENDO_HOSTS, max: MAX_IMAGE, kind: 'image' }).catch(() => null)
      : null;
    out.push({
      title: t.title, artist: t.artist, tags: t.tags, duration: t.duration,
      audio: audio.buf, mime: 'audio/mpeg', cover,
      source: 'jamendo', sourceUrl: t.page, license: t.license,
      description: `С Jamendo${t.album ? `: альбом «${t.album}»` : ''}. Лицензия: ${t.licenseName}.`,
    });
  }
  if (!out.length) throw new ImportError('Эти треки нельзя скачать');
  return out;
}
