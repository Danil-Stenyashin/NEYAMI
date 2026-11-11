/**
 * Треки по ссылке: SoundCloud и Яндекс Музыка играют через свои официальные встроенные плееры.
 * Сам звук NEYAMI не скачивает и не хранит — это музыка под лицензиями этих сервисов.
 * Адрес плеера собирается только из проверенных частей ссылки.
 */
import { ImportError, download } from './importers.js';

const YANDEX_HOSTS = ['music.yandex.ru', 'music.yandex.com', 'music.yandex.by', 'music.yandex.kz', 'music.yandex.uz'];

export function parseLink(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw new ImportError('Это не похоже на ссылку'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ImportError('Нужна обычная ссылка https://');
  const host = u.hostname.replace(/^www\.|^m\./, '');

  if (host === 'soundcloud.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || ['sets', 'likes', 'tracks', 'albums', 'reposts'].includes(parts[1])) {
      throw new ImportError('Нужна ссылка на отдельный трек SoundCloud, например soundcloud.com/артист/трек');
    }
    if (!parts.slice(0, 2).every((p) => /^[A-Za-z0-9_-]{1,100}$/.test(p))) throw new ImportError('Непонятная ссылка SoundCloud');
    const page = `https://soundcloud.com/${parts[0]}/${parts[1]}`;
    const embed = `https://w.soundcloud.com/player/?url=${encodeURIComponent(page)}&auto_play=true&visual=false&hide_related=true&show_comments=false&show_teaser=false`;
    return { service: 'soundcloud', page, embed };
  }

  if (YANDEX_HOSTS.includes(host)) {
    const m = /^\/album\/(\d{1,12})\/track\/(\d{1,12})\/?$/.exec(u.pathname);
    if (!m) throw new ImportError('Нужна ссылка на трек Яндекс Музыки вида music.yandex.ru/album/…/track/…');
    const [, album, track] = m;
    return {
      service: 'yandex',
      page: `https://music.yandex.ru/album/${album}/track/${track}`,
      embed: `https://music.yandex.ru/iframe/track/${track}/${album}`,
    };
  }
  if (host === 'on.soundcloud.com') throw new ImportError('Короткие ссылки on.soundcloud.com не поддерживаются — откройте трек и скопируйте полную ссылку');
  throw new ImportError('Поддерживаются ссылки на треки SoundCloud и Яндекс Музыки');
}

/** Название, артист и обложка трека SoundCloud через его официальный oEmbed. */
export async function soundcloudInfo(fetchImpl, page) {
  const res = await fetchImpl(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(page)}`);
  if (!res.ok) throw new ImportError(res.status === 404 ? 'Трек не найден или закрыт автором' : `SoundCloud ответил ошибкой ${res.status}`);
  const d = await res.json();
  let title = String(d.title ?? '').trim();
  const artist = String(d.author_name ?? '').trim();
  const suffix = ` by ${artist}`;
  if (artist && title.endsWith(suffix)) title = title.slice(0, -suffix.length);
  let cover = null;
  if (d.thumbnail_url) {
    cover = await download(fetchImpl, d.thumbnail_url.replace('-large.', '-t500x500.'), { hosts: ['sndcdn.com'], max: 5 * 1024 * 1024, kind: 'image' })
      .catch(() => null);
  }
  return { title: title.slice(0, 200), artist: artist.slice(0, 100), cover };
}
