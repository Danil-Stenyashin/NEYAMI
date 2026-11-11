// NEYAMI — клиент. Без фреймворков: hash-роутинг, один <audio>, состояние в модуле.
import { extractFeatures } from './audio-features.js';
import { icon, hydrateIcons } from './icons.js';
import { BANDS, PRESETS, loadEq, saveEq, ensureGraph, applyEq, graphReady, levels, isIOS } from './eq.js';
import { readId3, guessFromFilename } from './id3.js';

// Темп и приветствие — обычными словами
const tempoWord = (bpm) => (!bpm ? '' : bpm < 85 ? 'неспешно' : bpm < 110 ? 'размеренно' : bpm < 135 ? 'бодро' : 'быстро');
function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Доброе утро';
  if (h >= 12 && h < 18) return 'Добрый день';
  if (h >= 18 && h < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}

// Часовой пояс — для «волны по контексту» (утро/вечер/выходные считаются по местному времени)
const TZ = new Date().getTimezoneOffset();

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const audio = $('#audio');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (sec) => {
  if (!Number.isFinite(sec)) return '0:00';
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function api(path, { method = 'GET', body, headers } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Нет связи с сервером NEYAMI — проверьте, что он запущен и вы в той же сети');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const state = {
  me: null,
  settings: null,
  queue: [],          // [{track, reasons}]
  mode: null,         // 'wave' | 'bridge' | 'list' | 'preview'
  seen: new Set(),    // треки, уже выданные волной в этой сессии
  bridge: null,       // {from, to, length}
  cur: null,          // текущий трек и трекинг прослушивания
};

// ============================================================
// Плеер + трекинг прослушивания (для волны и автодропа)
// ============================================================

/*
 * cur = {
 *   track, reasons, preview,
 *   segments: [[from,to]], segStart, lastT, seeks: [t],
 *   outcomeSent, programmaticSeek
 * }
 */
function closeSegment() {
  const c = state.cur;
  if (!c || c.segStart == null) return;
  // Отрезок, начатый с нашей же подсказки (быстрый поиск, кнопка ⤓), не засчитываем:
  // иначе алгоритм учился бы на собственных догадках и дроп «уползал» бы к началу.
  if (!c.segSuggested && c.lastT - c.segStart >= 0.5) c.segments.push([c.segStart, c.lastT]);
  c.segStart = null;
}

function flushListen() {
  const c = state.cur;
  if (!c || !state.me) return;
  closeSegment();
  const heardSec = c.segments.reduce((a, [f, t]) => a + (t - f), 0);
  if (heardSec >= 1 && audio.duration > 0) {
    api(`/api/tracks/${c.track.id}/listen`, {
      method: 'POST',
      body: { duration: audio.duration, segments: c.segments, seeks: c.seeks },
    }).catch(() => {});
  }
  c.segments = [];
  c.seeks = [];
}

function sendEvent(type, extra = {}) {
  if (!state.me || !state.cur) return;
  api('/api/events', {
    method: 'POST',
    body: { track_id: state.cur.track.id, type, position: audio.currentTime, duration: audio.duration, ...extra },
  }).catch(() => {});
}

/** Уход с текущего трека: фиксирует итог (дослушал / пропустил) и отправляет тепловую карту. */
function leaveCurrent() {
  const c = state.cur;
  if (!c) return { early: false };
  let early = false;
  if (!c.outcomeSent && !c.preview && audio.duration > 0) {
    const frac = audio.currentTime / audio.duration;
    if (frac >= 0.8) sendEvent('complete');
    else {
      sendEvent('skip');
      early = audio.currentTime < Math.min(30, audio.duration * 0.35);
    }
    c.outcomeSent = true;
  }
  flushListen();
  return { early };
}

function playTrack(item, { startAt = 0, preview = false } = {}) {
  leaveCurrent();
  unlocking = false;
  const { track, reasons = [] } = item;
  const cur = (state.cur = {
    track, reasons, preview,
    segments: [], seeks: [], segStart: null, lastT: startAt,
    outcomeSent: false, programmaticSeek: startAt > 0, segSuggested: startAt > 0,
  });
  // Старт с нужной секунды через media fragment (#t=) — так работает и на iPhone,
  // где метаданные не грузятся до play(). Запасной вариант — перемотка после загрузки.
  audio.src = `/api/tracks/${track.id}/stream${startAt > 0 ? `#t=${startAt.toFixed(1)}` : ''}`;
  if (startAt > 0) {
    audio.addEventListener('loadedmetadata', () => {
      if (state.cur === cur && Math.abs(audio.currentTime - startAt) > 1) {
        cur.programmaticSeek = true;
        audio.currentTime = startAt;
      }
    }, { once: true });
  }
  audio.play().catch(() => {
    setToggle(false); // браузер не дал запустить звук сам — ждём нажатия ▶
  });
  if (!preview) sendEvent('play');
  renderPlayer();
  updateMediaSession(track);
  loadHeat(track);
}

// ---------- iPhone: «разблокировка» звука первым касанием ----------
// Safari разрешает звук только из жеста пользователя. Волна же сначала ходит на сервер,
// и play() после await был бы заблокирован. Поэтому при первом касании проигрываем
// тишину на том же <audio> — дальше он «разблокирован» навсегда.
let unlocked = false;
let unlocking = false;
let silentUrl = null;
function silentWav() {
  const n = 800;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, t) => [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  // эквалайзер, включённый в прошлый раз, оживает от первого касания (без жеста браузер не даст звук)
  const eqState = loadEq();
  if (eqState.on && ensureGraph(audio)) applyEq(eqState);
  if (audio.src) return; // уже что-то играет — значит, разблокирован
  silentUrl = silentWav();
  unlocking = true;
  audio.src = silentUrl;
  audio.play().then(() => {
    if (audio.src === silentUrl) { audio.pause(); audio.removeAttribute('src'); }
  }).catch(() => {}).finally(() => { unlocking = false; });
}
for (const ev of ['touchend', 'click', 'keydown']) document.addEventListener(ev, unlockAudio, { capture: true });

// ---------- Экран блокировки, наушники, клавиши мультимедиа ----------
function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist.username,
      album: 'NEYAMI',
      artwork: [
        { src: new URL(track.cover, location.href).href, sizes: '400x400' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  } catch { /* старые браузеры */ }
}
if ('mediaSession' in navigator) {
  const handlers = {
    play: () => audio.play(),
    pause: () => audio.pause(),
    nexttrack: () => (state.mode === 'preview' ? previewAction('no') : next()),
    previoustrack: () => { audio.currentTime = 0; },
    seekto: (d) => { if (Number.isFinite(d.seekTime)) audio.currentTime = d.seekTime; },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* не поддерживается */ }
  }
}
let lastPositionUpdate = 0;
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!(audio.duration > 0) || Date.now() - lastPositionUpdate < 1000) return;
  lastPositionUpdate = Date.now();
  try {
    navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate });
  } catch { /* ignore */ }
}

audio.addEventListener('playing', () => {
  if (unlocking) return;
  const c = state.cur;
  if (c && c.segStart == null) c.segStart = c.lastT = audio.currentTime;
  // если старт с дропа прошёл без события перемотки — следующая перемотка уже от человека
  if (c && c.programmaticSeek && !audio.seeking) c.programmaticSeek = false;
  setToggle(true);
  $('.wave-btn')?.classList.add('playing');
});
audio.addEventListener('pause', () => {
  closeSegment();
  setToggle(false);
  $('.wave-btn')?.classList.remove('playing');
});
audio.addEventListener('timeupdate', () => {
  updatePositionState();
  const c = state.cur;
  if (c && !audio.seeking && !audio.paused) {
    if (c.segStart == null) c.segStart = audio.currentTime;
    c.lastT = audio.currentTime;
  }
  updateProgress();
});
audio.addEventListener('seeking', () => closeSegment());
audio.addEventListener('seeked', () => {
  const c = state.cur;
  if (!c) return;
  // перемотку, сделанную человеком, считаем сигналом «вот здесь интересно»
  if (!c.programmaticSeek) c.seeks.push(audio.currentTime);
  c.segSuggested = c.programmaticSeek; // дальше слушают либо с нашей подсказки, либо с выбранного места
  c.programmaticSeek = false;
  c.segStart = audio.paused ? null : audio.currentTime;
  c.lastT = audio.currentTime;
});
audio.addEventListener('ended', () => {
  if (unlocking || !state.cur) return;
  const c = state.cur;
  if (c && !c.outcomeSent && !c.preview) { sendEvent('complete'); c.outcomeSent = true; }
  if (c?.preview) return; // быстрый поиск сам управляет переходами
  next();
});

async function next({ refresh = false } = {}) {
  const { early } = leaveCurrent();
  // В волне ранний пропуск — сильный сигнал: перестраиваем очередь сразу
  if ((state.mode === 'wave') && (early || refresh)) state.queue = [];
  if (!state.queue.length && state.mode === 'wave') await refillWave();
  const item = state.queue.shift();
  if (!item) {
    audio.pause();
    state.cur = null;
    toast(state.mode === 'bridge' ? 'Переход завершён' : 'Музыка в очереди закончилась');
    renderPlayer();
    return;
  }
  playTrack(item);
  if (state.mode === 'wave' && state.queue.length < 3) refillWave(true);
  if (location.hash.startsWith('#/wave')) renderQueue();
}

async function refillWave(append = false) {
  if (state.cur) state.seen.add(state.cur.track.id);
  try {
    const exclude = [...state.seen, ...state.queue.map((i) => i.track.id)].slice(-300).join(',');
    const data = await api(`/api/wave?count=10&tz=${TZ}&exclude=${exclude}`);
    for (const it of data.items) state.seen.add(it.track.id);
    state.queue = append ? state.queue.concat(data.items) : data.items;
    if (data.items.length === 0 && state.seen.size) {
      state.seen = new Set(state.cur ? [state.cur.track.id] : []); // каталог закончился — начинаем новый круг
    }
    state.profile = data.profile;
    if (location.hash.startsWith('#/wave')) { renderQueue(); renderProfileChips(); }
  } catch (e) { toast(e.message); }
}

async function startWave() {
  if (!state.me) return (location.hash = '#/login');
  state.mode = 'wave';
  state.queue = [];
  await refillWave();
  next();
}

// ---------- плеер: UI ----------
function setToggle(playing) {
  $('#p-toggle').innerHTML = icon(playing ? 'pause' : 'play', 20);
  $('#p-toggle').title = playing ? 'Пауза' : 'Играть';
}
function renderPlayer() {
  const c = state.cur;
  $('#player').classList.toggle('hidden', !c);
  if (!c) return;
  const t = c.track;
  $('#p-cover').src = t.cover;
  $('#p-title').innerHTML = `${esc(t.title)} ${t.explicit ? '<span class="badge">18+</span>' : ''}`;
  $('#p-artist').innerHTML = `<a href="#/u/${encodeURIComponent(t.artist.username)}">${esc(t.artist.username)}</a>`;
  $('#p-like').innerHTML = icon(t.my_reaction > 0 ? 'heartFill' : 'heart');
  $('#p-like').classList.toggle('active', t.my_reaction > 0);
  $('#p-reasons').textContent = c.reasons.length ? 'Почему этот трек: ' + c.reasons.join(' · ') : '';
  $('#p-drop').title = `К лучшему моменту (${fmt(t.moment.start)})`;
  if (!$('#full').classList.contains('hidden')) renderFull();
}

function updateProgress() {
  const d = audio.duration;
  $('#p-time').textContent = fmt(audio.currentTime);
  $('#p-dur').textContent = fmt(d);
  if (d > 0 && !seekDragging) $('#p-seek').value = Math.round((audio.currentTime / d) * 1000);
  if (!$('#full').classList.contains('hidden')) {
    $('#full-time').textContent = fmt(audio.currentTime);
    $('#full-dur').textContent = fmt(d);
    if (d > 0 && document.activeElement !== $('#full-range')) $('#full-range').value = Math.round((audio.currentTime / d) * 1000);
  }
}

let seekDragging = false;
$('#p-seek').addEventListener('input', () => { seekDragging = true; });
$('#p-seek').addEventListener('change', (e) => {
  seekDragging = false;
  if (audio.duration > 0) audio.currentTime = (e.target.value / 1000) * audio.duration;
});
$('#p-toggle').addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
$('#p-next').addEventListener('click', () => next());
$('#p-drop').addEventListener('click', () => {
  const c = state.cur;
  if (!c) return;
  c.programmaticSeek = true; // переход к дропу — не сигнал для тепловой карты
  audio.currentTime = c.track.moment.start;
});
$('#p-like').addEventListener('click', async () => {
  const c = state.cur;
  if (!c) return;
  await react(c.track, c.track.my_reaction > 0 ? 0 : 1);
  renderPlayer();
});
$('#p-dislike').addEventListener('click', async () => {
  const c = state.cur;
  if (!c) return;
  await react(c.track, -1);
  toast('Понял, такого меньше');
  next({ refresh: true });
});

// Тепловая карта под прогрессом: где слушают чаще + отмеченный дроп
async function loadHeat(track) {
  const canvas = $('#p-heat');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  try {
    const { heat, moment } = await api(`/api/tracks/${track.id}/heat`);
    if (state.cur?.track.id !== track.id) return;
    track.moment = moment;
    drawHeat(canvas, heat, moment, track.duration || audio.duration);
  } catch { /* не критично */ }
}

function drawHeat(canvas, heat, moment, duration) {
  const ctx = canvas.getContext('2d');
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#c96442';
  const faint = css.getPropertyValue('--faint').trim() || '#a9a69c';
  const max = Math.max(1, ...heat.heard);
  const bw = w / heat.heard.length;
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = faint;
  heat.heard.forEach((v, i) => {
    const bh = Math.max(1, (v / max) * h);
    ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh);
  });
  if (duration > 0) {
    // лучший момент: участок акцентным цветом + метка начала
    const x0 = (moment.start / duration) * w;
    const x1 = (moment.end / duration) * w;
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = accent;
    heat.heard.forEach((v, i) => {
      const x = i * bw;
      if (x + bw < x0 || x > x1) return;
      const bh = Math.max(1, (v / max) * h);
      ctx.fillRect(x, h - bh, Math.max(1, bw - 1), bh);
    });
    ctx.globalAlpha = 1;
    ctx.fillRect(x0, 0, 1.5 * devicePixelRatio, h);
  }
  ctx.globalAlpha = 1;
}

async function react(track, value) {
  if (!state.me) { location.hash = '#/login'; return; }
  try {
    const { track: upd } = await api(`/api/tracks/${track.id}/react`, { method: 'POST', body: { value } });
    track.my_reaction = upd.my_reaction;
    track.likes = upd.likes;
  } catch (e) { toast(e.message); }
}

// ============================================================
// Отрисовка списков треков
// ============================================================

function trackRow(item, idx) {
  const t = item.track;
  const isMine = state.me && state.me.id === t.artist.id;
  const now = state.cur?.track.id === t.id;
  const liked = t.my_reaction > 0;
  return `
  <div class="track ${now ? 'now' : ''}" data-idx="${idx}">
    <button class="play cover-btn" data-act="play" title="Играть" style="background-image:url('${t.cover}')">${icon('play', 16)}</button>
    <div class="meta">
      <div class="title">${esc(t.title)} ${t.explicit ? '<span class="badge">18+</span>' : ''}</div>
      <div class="sub">
        <a href="#/u/${encodeURIComponent(t.artist.username)}">${esc(t.artist.username)}</a>
        <span>${fmt(t.duration)}</span>
        <span class="stat" title="Лайки">${icon('heart', 12)}${t.likes}</span>
        ${t.tags.map((g) => `<a class="chip tag" href="#/tag/${encodeURIComponent(g)}">#${esc(g)}</a>`).join('')}
      </div>
      ${item.reasons?.length ? `<div class="why" title="${esc(item.reasons.join(' · '))}">${esc(item.reasons[0])}</div>` : ''}
    </div>
    <div class="actions">
      <button data-act="drop" class="icon-btn opt" title="С лучшего момента (${fmt(t.moment.start)})">${icon('target')}</button>
      <button data-act="like" class="icon-btn ${liked ? 'active' : ''}" title="Нравится">${icon(liked ? 'heartFill' : 'heart')}</button>
      ${isMine
        ? `<button data-act="delete" class="icon-btn opt" title="Удалить">${icon('trash')}</button>`
        : `<button data-act="report" class="icon-btn opt" title="Пожаловаться на нарушение закона">${icon('flag')}</button>`}
    </div>
  </div>`;
}

const EMPTY_DEFAULT = 'Тут пока тихо. <a href="#/upload">Добавим музыки?</a>';
function renderTrackList(container, items, { mode = 'list', empty = EMPTY_DEFAULT } = {}) {
  if (!items.length) {
    container.innerHTML = `<div class="empty">${empty}</div>`;
    return;
  }
  container.innerHTML = `<div class="tracks">${items.map(trackRow).join('')}</div>`;
  container.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const idx = Number(btn.closest('.track').dataset.idx);
    const item = items[idx];
    const act = btn.dataset.act;
    if (act === 'play' || act === 'drop') {
      state.mode = mode;
      state.queue = items.slice(idx + 1);
      playTrack(item, { startAt: act === 'drop' ? item.track.moment.start : 0 });
      renderTrackList(container, items, { mode });
    } else if (act === 'like') {
      await react(item.track, item.track.my_reaction > 0 ? 0 : 1);
      renderTrackList(container, items, { mode });
      if (state.cur?.track.id === item.track.id) { state.cur.track.my_reaction = item.track.my_reaction; renderPlayer(); }
    } else if (act === 'delete') {
      if (!confirm(`Удалить «${item.track.title}»?`)) return;
      await api(`/api/tracks/${item.track.id}`, { method: 'DELETE' }).catch((er) => toast(er.message));
      items.splice(idx, 1);
      renderTrackList(container, items, { mode });
    } else if (act === 'report') {
      reportTrack(item.track);
    }
  };
}

async function reportTrack(track) {
  if (!state.me) return (location.hash = '#/login');
  const reason = prompt(
    'Жалобы принимаются только на нарушения закона или прав — не на «не нравится».\n' +
    'Введите: copyright (авторские права), illegal (незаконный контент), spam, impersonation (выдаёт себя за другого)',
  );
  if (!reason) return;
  try {
    await api(`/api/tracks/${track.id}/report`, { method: 'POST', body: { reason: reason.trim() } });
    toast('Жалоба отправлена');
  } catch (e) { toast(e.message); }
}

// ============================================================
// Страницы
// ============================================================

const routes = {
  wave: renderWave,
  quick: renderQuick,
  new: () => renderList('Новое', '/api/tracks'),
  top: () => renderList('Лучшее', '/api/tracks?sort=top'),
  following: () => requireLogin() && renderList('Новое от подписок', '/api/tracks?feed=following',
    'Подпишитесь на артистов, которые вам по душе, — их новые треки будут появляться здесь.'),
  likes: () => requireLogin() && renderList('Мне нравится', '/api/likes',
    'Отмечайте сердечком треки, которые цепляют, — они соберутся здесь.'),
  tag: (tag) => renderList(`#${tag}`, `/api/tracks?tag=${encodeURIComponent(tag)}`),
  search: (q) => renderList(`Поиск: ${q}`, `/api/tracks?q=${encodeURIComponent(q)}`,
    'Ничего не нашлось. Попробуйте другое слово — или <a href="#/upload">найдите свободную музыку</a>.'),
  u: renderProfile,
  upload: (tab) => renderUpload(tab),
  taste: renderTaste,
  login: renderLogin,
};

function requireLogin() {
  if (state.me) return true;
  location.hash = '#/login';
  return false;
}

async function router() {
  const [name = 'wave', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const arg = decodeURIComponent(rest.join('/'));
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));
  if (state.mode === 'preview' && name !== 'quick') stopPreview();
  const fn = routes[name] ?? routes.wave;
  view.innerHTML = '<p class="muted">Загрузка…</p>';
  try { await fn(arg); } catch (e) { view.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

async function renderList(title, url, empty) {
  const { tracks } = await api(url);
  view.innerHTML = `<h1>${esc(title)}</h1><div id="list"></div>`;
  renderTrackList($('#list'), tracks.map((track) => ({ track })), { empty });
}

// ---------- Волна ----------
// Настройки волны сохраняются с небольшой задержкой; изменения копятся и уходят одним запросом
let pendingSettings = {};
let settingsTimer;
function saveSettings(patch, { refill = true } = {}) {
  Object.assign(state.settings ?? (state.settings = {}), patch);
  Object.assign(pendingSettings, patch);
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    const body = pendingSettings;
    pendingSettings = {};
    await api('/api/wave/settings', { method: 'PUT', body }).catch((e) => toast(e.message));
    if (refill && state.mode === 'wave') { state.queue = []; refillWave(); }
  }, 350);
}

async function renderWave() {
  if (!state.me) {
    view.innerHTML = `
      <section class="hero">
        <h1>Музыка без цензуры и волна, которая вас слышит</h1>
        <p class="lead">Учится на том, что вы дослушиваете и пропускаете, и объясняет каждый трек.</p>
        <a href="#/login"><button class="primary wave-btn">Войти или создать аккаунт</button></a>
      </section>`;
    return;
  }
  if (!state.settings) state.settings = (await api('/api/wave/settings')).settings;
  const s = state.settings;
  const [{ tags }, { tracks: some }] = await Promise.all([api('/api/tags'), api('/api/tracks?limit=40')]);
  const fewTracks = some.length < 30;
  view.innerHTML = `
    <section class="hero">
      <h1>${greeting()}, ${esc(state.me.username)}</h1>
      <button class="primary wave-btn" id="wave-start">
        ${icon(state.mode === 'wave' ? 'rotate' : 'play', 18)}<span>${state.mode === 'wave' ? 'Начать заново' : 'Включить мою волну'}</span>
      </button>
      <div id="context-line" class="ctx-line"></div>
    </section>
    ${fewTracks ? `
    <a class="card hint" href="#/upload">
      <span>Музыки пока немного — волне не из чего выбирать. Добавим свободной музыки или вашей из папки?</span>
      <span class="hint-go">Добавить музыку →</span>
    </a>` : ''}

    <section class="tune">
      <div class="slider">
        <div class="labels"><span>Любимое</span><span>Новое</span></div>
        <input type="range" id="discovery" min="0" max="100" value="${Math.round(s.discovery * 100)}" aria-label="Любимое или новое">
      </div>
      <div class="slider">
        <div class="labels"><span>Популярное</span><span>Малоизвестное</span></div>
        <input type="range" id="underground" min="0" max="100" value="${Math.round(s.underground * 100)}" aria-label="Популярное или андеграунд">
      </div>
    </section>

    <section class="bridge">
      <div class="row">
        <span class="bridge-label">Плавный переход</span>
        <input type="text" id="b-from" list="tags" placeholder="от, напр. lofi" value="${esc(state.bridge?.from ?? '')}">
        <span class="muted">→</span>
        <input type="text" id="b-to" list="tags" placeholder="к, напр. dnb" value="${esc(state.bridge?.to ?? '')}">
        <select id="b-len" aria-label="Длина моста">${[5, 8, 12, 20].map((n) => `<option ${n === (state.bridge?.length ?? 8) ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <button id="b-go" class="ghost" title="Плавный переход от одного настроения к другому">Построить</button>
      </div>
      <datalist id="tags">${tags.map((t) => `<option value="${esc(t.tag)}">${t.count}</option>`).join('')}</datalist>
    </section>

    <h2 id="queue-title">Дальше</h2>
    <div id="queue"></div>`;

  $('#wave-start').onclick = startWave;
  $('#discovery').oninput = (e) => saveSettings({ discovery: e.target.value / 100 });
  $('#underground').oninput = (e) => saveSettings({ underground: e.target.value / 100 });
  $('#b-go').onclick = startBridge;
  renderQueue();
  if (!state.profile) {
    api(`/api/wave?count=1&tz=${TZ}`).then((d) => { state.profile = d.profile; renderProfileChips(); }).catch(() => {});
  } else renderProfileChips();
}

// Одна короткая строка: что волна о вас думает. Подробности — на странице «Мой вкус».
function renderProfileChips() {
  const line = $('#context-line');
  if (!line || !state.profile) return;
  const p = state.profile;
  const c = p.context;
  const tags = (c && state.settings?.context !== 0 && c.confidence >= 0.3 && c.topTags.length ? c.topTags : p.topTags)
    .slice(0, 3).map(([t]) => '#' + esc(t)).join(' ');
  const when = c && state.settings?.context !== 0 ? `${c.slot[0].toUpperCase()}${c.slot.slice(1)}` : '';
  line.innerHTML = tags
    ? `${when ? `${when} · ` : ''}${tags} · <a href="#/taste">мой вкус</a>`
    : 'Слушайте и оценивайте — волна подстроится под вас';
}

function renderQueue() {
  const el = $('#queue');
  if (!el) return;
  $('#queue-title').textContent = state.mode === 'bridge'
    ? `Переход от #${state.bridge.from} к #${state.bridge.to}` : 'Дальше';
  if (!state.queue.length) {
    el.innerHTML = `<p class="muted">${state.mode ? 'Подбираю…' : 'Нажмите «Моя волна», чтобы начать.'}</p>`;
    return;
  }
  renderTrackList(el, state.queue, { mode: state.mode });
}

async function startBridge() {
  const from = $('#b-from').value.trim().replace(/^#/, '');
  const to = $('#b-to').value.trim().replace(/^#/, '');
  const length = Number($('#b-len').value);
  if (!from || !to) return toast('Укажите оба тега');
  try {
    const data = await api(`/api/wave/bridge?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&length=${length}&tz=${TZ}`);
    if (!data.items.length) return toast('Не нашёл треков с такими тегами');
    if (data.path) toast(`Звук: ${data.path.from} → ${data.path.to}`);
    state.bridge = { from, to, length };
    state.mode = 'bridge';
    state.queue = data.items;
    next();
    renderQueue();
  } catch (e) { toast(e.message); }
}

// ---------- Быстрый поиск ----------
const PREVIEW_SEC = 15;
const preview = { items: [], timer: null, startedAt: 0, item: null };

function stopPreview() {
  clearInterval(preview.timer);
  preview.timer = null;
  if (state.mode === 'preview') {
    flushListen();
    audio.pause();
    state.cur = null;
    state.mode = null;
    renderPlayer();
  }
  document.removeEventListener('keydown', previewKeys);
}

async function renderQuick() {
  if (!requireLogin()) return;
  view.innerHTML = `
    <h1>Быстрый поиск</h1>
    <p class="lead">По ${PREVIEW_SEC} секунд с лучшего момента каждого трека.</p>
    <div class="card quick" id="quick"><p class="muted">Подбираю…</p></div>
    <p class="keys">← не моё · → нравится · пробел — пауза · ↓ слушать целиком</p>
    <p class="keys touch-only">Свайп вправо — нравится, влево — не моё</p>`;
  document.addEventListener('keydown', previewKeys);
  preview.items = [];
  await previewNext();
}

async function previewNext(outcome) {
  clearInterval(preview.timer);
  // итог предыдущего трека
  if (preview.item && outcome) {
    api('/api/events', {
      method: 'POST',
      body: { track_id: preview.item.track.id, type: outcome, position: audio.currentTime, duration: audio.duration },
    }).catch(() => {});
  }
  preview.item = null;
  if (!preview.items.length) {
    const exclude = [...state.seen].slice(-300).join(',');
    const data = await api(`/api/wave?count=10&tz=${TZ}&exclude=${exclude}`).catch((e) => (toast(e.message), { items: [] }));
    data.items.forEach((i) => state.seen.add(i.track.id));
    preview.items = data.items;
  }
  const item = (preview.item = preview.items.shift());
  const box = $('#quick');
  if (!box) return;
  if (!item) {
    box.innerHTML = '<p>Вы прослушали всё, что есть. Загляните позже или <a href="#/upload">загрузите своё</a>.</p>';
    return;
  }
  state.mode = 'preview';
  const t = item.track;
  box.innerHTML = `
    <img class="q-cover" src="${t.cover}" alt="">
    <div class="q-title">${esc(t.title)} ${t.explicit ? '<span class="badge">18+</span>' : ''}</div>
    <div class="q-artist"><a href="#/u/${encodeURIComponent(t.artist.username)}">${esc(t.artist.username)}</a></div>
    <div class="chips">${t.tags.map((g) => `<span class="chip">#${esc(g)}</span>`).join('')}${t.features?.bpm ? `<span class="chip">${tempoWord(t.features.bpm)}</span>` : ''}</div>
    <div class="why">${esc(item.reasons[0] ?? '')}</div>
    <div class="q-moment">с ${fmt(t.moment.start)} · ${{ listeners: 'лучший момент определили слушатели', audio: 'лучший момент — по анализу звука', default: 'пока мало данных' }[t.moment.source]}</div>
    <div class="progress"><div id="q-bar"></div></div>
    <div class="q-actions">
      <button data-q="no" title="Не моё (←)">${icon('dislike')}Не моё</button>
      <button data-q="full" title="Слушать целиком (↓)">${icon('headphones')}Целиком</button>
      <button data-q="yes" class="primary" title="Нравится (→)">${icon('heart')}Нравится</button>
    </div>`;
  box.onclick = (e) => {
    const b = e.target.closest('button[data-q]');
    if (b) previewAction(b.dataset.q);
  };
  // Свайпы на телефоне: вправо — нравится, влево — не моё
  let touch = null;
  box.ontouchstart = (e) => { touch = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
  box.ontouchend = (e) => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      previewAction(dx > 0 ? 'yes' : 'no');
    }
  };
  playTrack(item, { startAt: t.moment.start, preview: true });
  clearInterval(preview.timer);
  preview.startedAt = null;
  preview.timer = setInterval(() => {
    if (audio.paused) return;
    if (preview.startedAt == null) preview.startedAt = audio.currentTime;
    const elapsed = audio.currentTime - preview.startedAt;
    const bar = $('#q-bar');
    if (bar) bar.style.width = `${Math.min(100, (elapsed / PREVIEW_SEC) * 100)}%`;
    if (elapsed >= PREVIEW_SEC || audio.ended) previewNext('preview_complete');
  }, 200);
}

async function previewAction(act) {
  const item = preview.item;
  if (!item) return;
  if (act === 'no') previewNext('preview_skip');
  else if (act === 'yes') {
    await react(item.track, 1);
    toast('Добавлено в «Мне нравится»');
    previewNext('preview_complete');
  } else if (act === 'full') {
    clearInterval(preview.timer);
    document.removeEventListener('keydown', previewKeys);
    state.cur.preview = false; // дальше это обычное прослушивание
    state.mode = 'wave';
    state.queue = preview.items;
    preview.item = null;
    location.hash = '#/wave';
  }
}

function previewKeys(e) {
  if (e.target.matches('input, textarea')) return;
  const map = { ArrowLeft: 'no', ArrowRight: 'yes', ArrowDown: 'full' };
  if (map[e.key]) { e.preventDefault(); previewAction(map[e.key]); }
  if (e.key === ' ') { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
}

// ---------- Мой вкус ----------
async function renderTaste() {
  if (!requireLogin()) return;
  const { profile, overrides, settings } = await api(`/api/taste?tz=${TZ}`);
  const actLabel = { forget: 'забыт', boost: 'больше', block: 'скрыт' };
  const pct = Math.round(profile.confidence * 100);
  view.innerHTML = `
    <h1>Мой вкус</h1>
    <p class="lead">Всё, что волна знает о вас. Скрытых данных нет — всё можно поправить.</p>

    <div class="card prefs">
      <div>Волна знает вас на <b>${pct}%</b></div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <label class="switch" title="Прослушивания не влияют на волну — если включает гость или ребёнок">
        <input type="checkbox" id="t-private" ${settings.private_mode ? 'checked' : ''}><span>Не запоминать прослушивания</span></label>
      <label class="switch" title="Утром, ночью и в выходные вкус разный">
        <input type="checkbox" id="t-context" ${settings.context !== 0 ? 'checked' : ''}><span>Учитывать время суток</span></label>
      <label class="switch"><input type="checkbox" id="t-explicit" ${settings.hide_explicit ? 'checked' : ''}><span>Скрывать 18+</span></label>
    </div>

    ${profile.sound ? `<h2>Ваш звук</h2>
    <div class="card sound-card">
      <div class="big-sound">${esc(profile.sound.text)}</div>
      <div class="sound-meters">
        ${[['energy', 'Энергия'], ['percussive', 'Ритм'], ['brightness', 'Яркость'], ['dynamics', 'Перепады']].map(([k, label]) => `
          <div class="taste-tag"><span>${label}</span><div class="meter"><div class="pos" style="width:${Math.round(profile.sound[k] * 100)}%"></div></div><span class="muted">${Math.round(profile.sound[k] * 100)}%</span></div>`).join('')}
      </div>
    </div>` : ''}

    <h2>По времени суток ${settings.context === 0 ? '<span class="muted">· выключено</span>' : ''}</h2>
    <div class="slots">
      ${profile.bySlot.map((sl) => `
        <div class="slot card ${sl.hour === Math.floor(localHourNow() / 6) * 6 + 3 && sl.weekend === isWeekendNow() ? 'now' : ''}">
          <div class="slot-title">${{ 3: 'Ночь', 9: 'Утро', 15: 'День', 21: 'Вечер' }[sl.hour]} <span class="muted">· ${sl.weekend ? 'выходные' : 'будни'}</span></div>
          ${sl.confidence < 0.2 || !sl.topTags.length
            ? '<div class="muted">мало данных</div>'
            : `<div class="chips">${sl.topTags.map(([t]) => `<span class="chip pos">#${esc(t)}</span>`).join('')}</div>
               ${sl.sound ? `<div class="muted slot-sound">${esc(sl.sound)}</div>` : ''}`}
        </div>`).join('')}
    </div>

    <h2>Что вам нравится</h2>
    <div class="taste-tags">${profile.topTags.map(([t, v]) => tasteTag(t, v)).join('') || '<p class="muted">Пока не знаю — послушайте немного и отметьте, что нравится.</p>'}</div>

    <h2>Чего вы избегаете</h2>
    <div class="taste-tags">${profile.avoidTags.map(([t, v]) => tasteTag(t, v)).join('') || '<p class="muted">Ничего.</p>'}</div>

    <h2>Ручные правки</h2>
    <div class="card">
      <div class="row">
        <input type="text" id="t-tag" placeholder="тег, напр. jazz">
        <button data-add="boost">Хочу больше</button>
        <button data-add="block">Не предлагать</button>
      </div>
      <div class="chips" style="margin-top:12px">
        ${overrides.map((o) => `<span class="chip ${o.action === 'block' ? 'neg' : 'pos'}">#${esc(o.tag)} — ${actLabel[o.action]}
          <a href="#" data-undo="${esc(o.tag)}" title="Отменить">${icon('x', 14)}</a></span>`).join('') || '<span class="muted">Нет правок.</span>'}
      </div>
    </div>

    <h2>Сильнее всего повлияло</h2>
    <p class="muted">«Забыть» — волна перестанет на это опираться, лайк останется.</p>
    <div class="tracks infl">
      ${profile.influences.map((i) => `
        <div class="track">
          <span class="chip ${i.weight > 0 ? 'pos' : 'neg'}">${i.weight > 0 ? '+' : ''}${i.weight}</span>
          <div class="meta"><div class="title">${esc(i.track.title)}</div><div class="sub">${esc(i.track.artist.username)}</div></div>
          <div class="actions"><button class="ghost" data-forget="${i.track_id}">Забыть</button></div>
        </div>`).join('') || '<p class="muted">Пока ничего.</p>'}
    </div>`;

  const setTag = async (tag, action) => {
    await api('/api/taste/tags', { method: 'PUT', body: { tag, action } }).catch((e) => toast(e.message));
    state.queue = state.mode === 'wave' ? [] : state.queue;
    state.profile = null;
    renderTaste();
  };
  view.onclick = async (e) => {
    const el = e.target.closest('[data-tag-act], [data-add], [data-undo], [data-forget]');
    if (!el) return;
    e.preventDefault();
    if (el.dataset.tagAct) setTag(el.dataset.tag, el.dataset.tagAct);
    else if (el.dataset.add) {
      const tag = $('#t-tag').value.trim();
      if (tag) setTag(tag, el.dataset.add);
    } else if (el.dataset.undo) setTag(el.dataset.undo, null);
    else if (el.dataset.forget) {
      await api(`/api/taste/tracks/${el.dataset.forget}`, { method: 'DELETE' });
      toast('Забыто: волна больше на него не опирается, лайк остался');
      state.profile = null;
      renderTaste();
    }
  };
  const setting = (id, key, on, off) => {
    $(id).onchange = async (e) => {
      const v = e.target.checked ? 1 : 0;
      await api('/api/wave/settings', { method: 'PUT', body: { [key]: Boolean(v) } }).catch((er) => toast(er.message));
      if (state.settings) state.settings[key] = v;
      if (key !== 'private_mode' && state.mode === 'wave') state.queue = [];
      state.profile = null;
      toast(v ? on : off);
    };
  };
  setting('#t-private', 'private_mode', 'Режим «не запоминать» включён', 'Волна снова учится');
  setting('#t-context', 'context', 'Волна учитывает время суток', 'Время суток не учитывается');
  setting('#t-explicit', 'hide_explicit', 'Треки 18+ скрыты', 'Треки 18+ снова показываются');
}

const localHourNow = () => new Date().getHours();
const isWeekendNow = () => [0, 6].includes(new Date().getDay());

function tasteTag(tag, v) {
  return `
    <div class="taste-tag">
      <a href="#/tag/${encodeURIComponent(tag)}">#${esc(tag)}</a>
      <div class="meter"><div class="${v >= 0 ? 'pos' : 'neg'}" style="width:${Math.round(Math.abs(v) * 100)}%"></div></div>
      <span class="ops">
        <button data-tag="${esc(tag)}" data-tag-act="boost" title="Хочу больше">${icon('plus', 16)}</button>
        <button data-tag="${esc(tag)}" data-tag-act="forget" title="Забыть — не учитывать в волне">${icon('rotate', 16)}</button>
        <button data-tag="${esc(tag)}" data-tag-act="block" title="Не предлагать вообще">${icon('ban', 16)}</button>
      </span>
    </div>`;
}

// ---------- Профиль артиста ----------
async function renderProfile(name) {
  const { user, tracks } = await api(`/api/users/${encodeURIComponent(name)}`);
  const isMe = state.me?.id === user.id;
  view.innerHTML = `
    <h1>${esc(user.username)}</h1>
    <p class="lead">${user.followers} подписчиков · ${tracks.length} треков${user.bio ? ` · ${esc(user.bio)}` : ''}</p>
    ${!isMe && state.me ? `<button id="follow" class="${user.following ? '' : 'primary'}">${user.following ? 'Вы подписаны' : 'Подписаться'}</button>` : ''}
    <h2>Треки</h2><div id="list"></div>`;
  renderTrackList($('#list'), tracks.map((track) => ({ track })));
  $('#follow')?.addEventListener('click', async () => {
    await api(`/api/users/${encodeURIComponent(name)}/follow`, { method: 'POST', body: { follow: !user.following } });
    renderProfile(name);
  });
}

// ---------- Загрузка ----------
/**
 * Анализ звука прямо в браузере: длительность и «энергетический пик» —
 * место, где громкость резко растёт (обычно дроп или припев).
 * Это стартовая догадка, пока слушатели не покажут настоящий лучший момент.
 */
async function analyzeAudio(file) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 44100, 44100);
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  const data = buf.getChannelData(0);
  const hop = Math.floor(buf.sampleRate / 2); // окна по 0.5 с
  const rms = [];
  for (let i = 0; i + hop <= data.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j += 4) s += data[j] * data[j];
    rms.push(Math.sqrt(s / (hop / 4)));
  }
  const features = extractFeatures(data, buf.sampleRate);
  const W = 12; // 6 секунд
  let best = 0;
  let bestScore = -Infinity;
  for (let i = W; i < rms.length - W; i++) {
    let before = 0;
    let after = 0;
    for (let k = 1; k <= W; k++) { before += rms[i - k]; after += rms[i + k - 1]; }
    const score = after + Math.max(0, after - before) * 1.5;
    if (score > bestScore) [bestScore, best] = [score, i];
  }
  return { duration: buf.duration, peak: rms.length > 2 * W ? best / 2 : null, features };
}

// ============================================================
// Большой плеер: обложка, «живой» звук, эквалайзер
// ============================================================
let vizRaf = 0;

function openFull() {
  if (!state.cur) return;
  // На компьютере визуализация слушает настоящий звук. На iPhone — спокойная анимация:
  // подключение Web Audio там может останавливать музыку при блокировке экрана.
  if (!isIOS() && ensureGraph(audio)) applyEq(loadEq());
  $('#full').classList.remove('hidden');
  document.body.classList.add('full-open');
  renderFull();
  drawViz();
}

function closeFull() {
  $('#full').classList.add('hidden');
  document.body.classList.remove('full-open');
  cancelAnimationFrame(vizRaf);
}

function renderFull() {
  const c = state.cur;
  if (!c) return closeFull();
  const t = c.track;
  $('#full-cover').src = t.cover;
  $('#full-title').textContent = t.title;
  $('#full-artist').innerHTML = `<a href="#/u/${encodeURIComponent(t.artist.username)}">${esc(t.artist.username)}</a>`;
  $('#full-why').textContent = c.reasons[0] ?? '';
  const liked = t.my_reaction > 0;
  $('#full-like').innerHTML = icon(liked ? 'heartFill' : 'heart');
  $('#full-like').classList.toggle('active', liked);
  $('#full-toggle').innerHTML = icon(audio.paused ? 'play' : 'pause', 22);
  const src = { archive: 'Internet Archive', jamendo: 'Jamendo' }[t.source];
  $('#full-source').innerHTML = src
    ? `Из ${src}${t.license ? ` · ${licenseLink(t.license, 'лицензия')}` : ''}${t.source_url ? ` · <a href="${esc(t.source_url)}" target="_blank" rel="noopener">страница</a>` : ''}`
    : '';
}

function drawViz() {
  const canvas = $('#full-viz');
  const g = canvas.getContext('2d');
  const n = 40;
  const tick = (now) => {
    if ($('#full').classList.contains('hidden')) return;
    const dpr = devicePixelRatio || 1;
    const w = (canvas.width = canvas.clientWidth * dpr);
    const h = (canvas.height = canvas.clientHeight * dpr);
    g.clearRect(0, 0, w, h);
    let lv = graphReady() && !audio.paused ? levels(n) : null;
    if (!lv) {
      const e = state.cur?.track.features?.energy ?? 0.5;
      lv = Array.from({ length: n }, (_, i) => (audio.paused ? 0.03
        : (0.2 + 0.35 * e) * (0.55 + 0.45 * Math.sin(now / 430 + i * 0.55)) * (0.65 + 0.35 * Math.sin(now / 1300 + i * 0.21))));
    }
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c96442';
    const bw = w / n;
    lv.forEach((v, i) => {
      const bh = Math.max(3 * dpr, v * h);
      g.globalAlpha = 0.35 + 0.65 * v;
      const x = i * bw + bw * 0.22;
      if (g.roundRect) { g.beginPath(); g.roundRect(x, h - bh, bw * 0.56, bh, bw * 0.28); g.fill(); }
      else g.fillRect(x, h - bh, bw * 0.56, bh);
    });
    g.globalAlpha = 1;
    vizRaf = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(vizRaf);
  vizRaf = requestAnimationFrame(tick);
}

function renderEq() {
  const st = loadEq();
  const panel = $('#eq-panel');
  panel.innerHTML = `
    <label class="switch"><input type="checkbox" id="eq-on" ${st.on ? 'checked' : ''}><span>Включить эквалайзер</span></label>
    <div class="chips eq-presets">${Object.entries(PRESETS).map(([k, pr]) =>
      `<button class="chip ${st.preset === k ? 'pos' : ''}" data-preset="${k}">${pr.name}</button>`).join('')}</div>
    <div class="eq-bands">${BANDS.map((b, i) => `
      <label><input type="range" min="-12" max="12" step="1" value="${st.gains[i]}" data-band="${i}" aria-label="${b.label}">
      <span>${b.label}</span></label>`).join('')}</div>
    ${isIOS() ? '<p class="muted small">На iPhone с эквалайзером музыка может останавливаться при заблокированном экране.</p>' : ''}`;
  const update = (patch) => {
    const next = { ...loadEq(), ...patch };
    saveEq(next);
    if (next.on) ensureGraph(audio); // вызывается из клика — браузер разрешит звук
    applyEq(next);
    return next;
  };
  panel.onchange = (e) => {
    if (e.target.id === 'eq-on') { update({ on: e.target.checked }); renderEq(); }
  };
  panel.oninput = (e) => {
    const i = e.target.dataset.band;
    if (i === undefined) return;
    const gains = [...loadEq().gains];
    gains[Number(i)] = Number(e.target.value);
    update({ gains, preset: 'custom', on: true });
    $('#eq-on').checked = true;
  };
  panel.onclick = (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    update({ preset: b.dataset.preset, gains: [...PRESETS[b.dataset.preset].gains], on: b.dataset.preset !== 'flat' });
    renderEq();
  };
}

$('#p-open').addEventListener('click', (e) => { if (!e.target.closest('a')) openFull(); });
$('#full-close').addEventListener('click', closeFull);
$('#full').addEventListener('click', (e) => {
  const b = e.target.closest('[data-proxy]');
  if (b) { $(b.dataset.proxy).click(); setTimeout(renderFull, 150); }
});
$('#eq-toggle').addEventListener('click', () => {
  const panel = $('#eq-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) renderEq();
});
$('#full-range').addEventListener('change', (e) => {
  if (audio.duration > 0) audio.currentTime = (e.target.value / 1000) * audio.duration;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFull(); });
window.addEventListener('hashchange', closeFull);
audio.addEventListener('play', () => { if (!$('#full').classList.contains('hidden')) renderFull(); });
audio.addEventListener('pause', () => { if (!$('#full').classList.contains('hidden')) renderFull(); });

// ============================================================
// Добавить музыку: свободная музыка, Jamendo, своя папка, один трек
// ============================================================

const AUDIO_EXT = { mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', webm: 'audio/webm' };
const STARTER = [
  ['lofi', 'lofi'], ['электроника', 'electronic'], ['эмбиент', 'ambient'], ['джаз', 'jazz'],
  ['рок', 'rock'], ['хип-хоп', 'hip hop'], ['пианино', 'piano'], ['синтвейв', 'synthwave'],
];

// Импортированные треки докачиваются в браузер и анализируются в фоне — темп, энергия, лучший момент
const analysisQueue = [];
let analysing = false;
function queueAnalysis(tracks) {
  analysisQueue.push(...tracks.filter((t) => !t.features));
  runAnalysis();
}
async function runAnalysis() {
  if (analysing) return;
  analysing = true;
  while (analysisQueue.length) {
    const t = analysisQueue.shift();
    try {
      const blob = await (await fetch(`/api/tracks/${t.id}/stream`)).blob();
      const info = await analyzeAudio(blob);
      await api(`/api/tracks/${t.id}/analysis`, { method: 'PUT', body: info });
    } catch { /* не получилось — не страшно, трек всё равно играет */ }
  }
  analysing = false;
}

const ADD_TABS = [
  ['archive', 'Свободная музыка'],
  ['jamendo', 'Jamendo'],
  ['folder', 'Своя папка'],
  ['single', 'Свой трек'],
];

async function renderUpload(tab) {
  if (!requireLogin()) return;
  const current = ADD_TABS.some(([k]) => k === tab) ? tab : 'archive';
  view.innerHTML = `
    <h1>Добавить музыку</h1>
    <p class="lead">Своя музыка или свободная — от независимых артистов, которые сами разрешили её слушать и делиться ею.</p>
    <div class="tabs">${ADD_TABS.map(([k, name]) => `<a href="#/upload/${k}" class="${k === current ? 'on' : ''}">${name}</a>`).join('')}</div>
    <div id="add-pane"></div>`;
  const pane = $('#add-pane');
  if (current === 'archive') renderArchivePane(pane);
  else if (current === 'jamendo') renderJamendoPane(pane);
  else if (current === 'folder') renderFolderPane(pane);
  else renderSingleUpload(pane);
}

function licenseLink(url, name) {
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name || 'лицензия')}</a>` : esc(name || '');
}

function renderArchivePane(pane) {
  pane.innerHTML = `
    <div class="card starter">
      <div>
        <div class="starter-title">Пусто? Соберу стартовую подборку</div>
        <div class="muted">Пара альбомов lofi, электроники, эмбиента, джаза, рока, хип-хопа, пианино и синтвейва — около 25 треков.</div>
      </div>
      <button class="primary" id="starter">Собрать</button>
    </div>
    <div id="starter-status" class="muted"></div>
    <form id="ia-search" class="row find">
      <input type="text" name="q" placeholder="Жанр, настроение или артист — например, piano, chill, rock" required>
      <button class="primary">Найти</button>
    </form>
    <p class="muted small">Источник — Internet Archive: музыка под свободными лицензиями Creative Commons. У каждого трека сохраняются автор и лицензия.</p>
    <div id="ia-results" class="albums"></div>`;

  const results = $('#ia-results');
  const add = async (id, btn, limit = 6) => {
    btn.disabled = true;
    btn.textContent = 'Добавляю…';
    try {
      const { tracks } = await api('/api/import/archive', { method: 'POST', body: { id, limit } });
      btn.textContent = `Добавлено: ${tracks.length}`;
      queueAnalysis(tracks);
      return tracks.length;
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Добавить';
      toast(e.message);
      return 0;
    }
  };
  $('#ia-search').onsubmit = async (e) => {
    e.preventDefault();
    results.innerHTML = '<p class="muted">Ищу…</p>';
    try {
      const { items } = await api(`/api/import/archive?q=${encodeURIComponent(e.target.q.value)}`);
      results.innerHTML = items.length ? items.map((it) => `
        <div class="album">
          <img src="${esc(it.cover)}" alt="" loading="lazy">
          <div class="album-meta">
            <div class="title">${esc(it.title)}</div>
            <div class="muted">${esc(it.artist)}${it.year ? ` · ${esc(it.year)}` : ''}</div>
            <div class="muted small">${licenseLink(it.license, it.licenseName)} · <a href="${esc(it.page)}" target="_blank" rel="noopener">страница</a></div>
          </div>
          <button data-ia="${esc(it.id)}">Добавить</button>
        </div>`).join('') : '<p class="empty">Ничего не нашлось. Попробуйте другое слово, например по-английски.</p>';
    } catch (er) { results.innerHTML = `<p class="empty">${esc(er.message)}</p>`; }
  };
  results.onclick = (e) => {
    const b = e.target.closest('[data-ia]');
    if (b) add(b.dataset.ia, b);
  };
  $('#starter').onclick = async (e) => {
    const btn = e.target.closest('button');
    btn.disabled = true;
    const status = $('#starter-status');
    let total = 0;
    for (const [ru, q] of STARTER) {
      status.textContent = `Ищу ${ru}… (добавлено ${total})`;
      try {
        const { items } = await api(`/api/import/archive?q=${encodeURIComponent(q)}`);
        for (const it of items.slice(0, 3)) {
          const fake = document.createElement('button');
          const n = await add(it.id, fake, 3);
          if (n) { total += n; break; }
        }
      } catch { /* жанр не нашёлся — идём дальше */ }
    }
    status.innerHTML = total
      ? `Готово: добавлено ${total} треков. <a href="#/wave">Включить волну</a>`
      : 'Не получилось связаться с Internet Archive. Проверьте интернет и попробуйте ещё раз.';
    btn.disabled = false;
  };
}

async function renderJamendoPane(pane) {
  const { jamendo } = await api('/api/import/settings');
  if (!jamendo) {
    pane.innerHTML = `
      <div class="card">
        <p style="margin-top:0">Jamendo — большой каталог свободной музыки. Чтобы искать в нём, нужен бесплатный ключ:</p>
        <ol class="steps">
          <li>Зарегистрируйтесь на <a href="https://devportal.jamendo.com" target="_blank" rel="noopener">devportal.jamendo.com</a>.</li>
          <li>Создайте приложение (название любое, например NEYAMI).</li>
          <li>Скопируйте <b>Client ID</b> и вставьте сюда.</li>
        </ol>
        <form id="jam-key" class="row">
          <input type="text" name="key" placeholder="Client ID" autocomplete="off" required>
          <button class="primary">Сохранить</button>
        </form>
      </div>`;
    $('#jam-key').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/import/settings', { method: 'PUT', body: { jamendo_key: e.target.key.value } });
        renderJamendoPane(pane);
      } catch (er) { toast(er.message); }
    };
    return;
  }
  pane.innerHTML = `
    <form id="jam-search" class="row find">
      <input type="text" name="q" placeholder="Жанр, настроение или артист" required>
      <button class="primary">Найти</button>
    </form>
    <div id="jam-results" class="albums"></div>
    <p class="muted small"><a href="#" id="jam-reset">Сменить ключ Jamendo</a></p>`;
  $('#jam-reset').onclick = async (e) => {
    e.preventDefault();
    await api('/api/import/settings', { method: 'PUT', body: { jamendo_key: '' } });
    renderJamendoPane(pane);
  };
  const results = $('#jam-results');
  $('#jam-search').onsubmit = async (e) => {
    e.preventDefault();
    results.innerHTML = '<p class="muted">Ищу…</p>';
    try {
      const { tracks } = await api(`/api/import/jamendo?q=${encodeURIComponent(e.target.q.value)}`);
      results.innerHTML = tracks.length ? tracks.map((t) => `
        <div class="album">
          <img src="${esc(t.cover ?? '')}" alt="" loading="lazy">
          <div class="album-meta">
            <div class="title">${esc(t.title)}</div>
            <div class="muted">${esc(t.artist)}${t.album ? ` · ${esc(t.album)}` : ''}</div>
            <div class="muted small">${licenseLink(t.license, t.licenseName)}</div>
          </div>
          <button data-jam="${esc(t.id)}">Добавить</button>
        </div>`).join('') : '<p class="empty">Ничего не нашлось.</p>';
    } catch (er) { results.innerHTML = `<p class="empty">${esc(er.message)}</p>`; }
  };
  results.onclick = async (e) => {
    const b = e.target.closest('[data-jam]');
    if (!b) return;
    b.disabled = true;
    b.textContent = 'Добавляю…';
    try {
      const { tracks } = await api('/api/import/jamendo', { method: 'POST', body: { ids: [b.dataset.jam] } });
      b.textContent = 'Добавлено';
      queueAnalysis(tracks);
    } catch (er) { b.disabled = false; b.textContent = 'Добавить'; toast(er.message); }
  };
}

function renderFolderPane(pane) {
  pane.innerHTML = `
    <p class="muted">Выберите папку с музыкой или несколько файлов. Название, артиста, жанр и обложку NEYAMI возьмёт из самого файла.</p>
    <div class="row">
      <label class="pick"><input type="file" id="pick-folder" webkitdirectory multiple hidden>Выбрать папку</label>
      <label class="pick"><input type="file" id="pick-files" accept="audio/*,.flac,.opus,.m4a" multiple hidden>Выбрать файлы</label>
    </div>
    <div class="progress" style="margin-top:16px"><div id="folder-bar"></div></div>
    <div id="folder-status" class="muted" style="margin-top:8px"></div>
    <div id="folder-list" class="folder-list"></div>`;
  const onPick = (e) => importFiles([...e.target.files]);
  $('#pick-folder').onchange = onPick;
  $('#pick-files').onchange = onPick;
}

async function importFiles(all) {
  const files = all.filter((f) => AUDIO_EXT[f.name.split('.').pop().toLowerCase()]);
  const list = $('#folder-list');
  const status = $('#folder-status');
  if (!files.length) { status.textContent = 'В выбранном нет аудиофайлов.'; return; }
  let done = 0;
  let ok = 0;
  list.innerHTML = '';
  for (const file of files) {
    status.textContent = `Добавляю ${done + 1} из ${files.length}: ${file.name}`;
    const row = document.createElement('div');
    row.textContent = file.name;
    list.prepend(row);
    try {
      const tags = readId3(await file.slice(0, 4 * 1024 * 1024).arrayBuffer());
      const guess = guessFromFilename(file.name);
      const title = tags.title || guess.title;
      const artist = tags.artist || guess.artist || '';
      let info = { duration: null, peak: null, features: null };
      try { info = await analyzeAudio(file); } catch { /* не декодировалось — загрузим без анализа */ }
      const params = new URLSearchParams({ title, tags: tags.genre ?? '', source: 'folder' });
      if (artist) params.set('artist', artist);
      if (info.duration) params.set('duration', info.duration.toFixed(2));
      if (info.peak != null) params.set('peak', info.peak.toFixed(1));
      if (info.features) params.set('features', JSON.stringify(info.features));
      const type = file.type || AUDIO_EXT[file.name.split('.').pop().toLowerCase()];
      const res = await fetch(`/api/tracks?${params}`, { method: 'POST', headers: { 'Content-Type': type }, body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ошибка');
      if (tags.picture) {
        await fetch(`/api/tracks/${data.track.id}/cover`, { method: 'POST', headers: { 'Content-Type': tags.picture.mime }, body: tags.picture.data }).catch(() => {});
      }
      row.innerHTML = `${icon('heart', 12)} <b>${esc(title)}</b> <span class="muted">— ${esc(artist || state.me.username)}</span>`;
      ok++;
    } catch (e) {
      row.innerHTML = `<span class="muted">Не получилось: ${esc(file.name)} — ${esc(e.message)}</span>`;
    }
    done++;
    $('#folder-bar').style.width = `${(done / files.length) * 100}%`;
  }
  status.innerHTML = `Готово: добавлено ${ok} из ${files.length}. <a href="#/new">Посмотреть</a> или <a href="#/wave">включить волну</a>.`;
}

function renderSingleUpload(pane) {
  pane.innerHTML = `
    <p class="muted">Ваш собственный трек. Без премодерации и скрытых понижений в выдаче — удаляем только то, что нарушает закон или чужие права.</p>
    <form class="form card" id="up">
      <label>Аудиофайл (mp3, ogg, opus, wav, flac, m4a — до 100 МБ)<input type="file" name="file" accept="audio/*" required></label>
      <label>Название<input type="text" name="title" maxlength="200" required></label>
      <label>Теги — через запятую или пробел (жанр, настроение, темп)<input type="text" name="tags" placeholder="lofi, ночь, chill"></label>
      <label>Описание<textarea name="description" rows="3" maxlength="5000"></textarea></label>
      <label class="switch"><input type="checkbox" name="explicit"><span>Отметка 18+ — слушатели сами решают, скрывать ли такое</span></label>
      <div class="progress"><div id="up-bar"></div></div>
      <div class="muted" id="up-status"></div>
      <button class="primary">Опубликовать</button>
    </form>`;
  const form = $('#up');
  form.file.onchange = () => {
    const f = form.file.files[0];
    if (f && !form.title.value) form.title.value = f.name.replace(/\.[^.]+$/, '');
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const file = form.file.files[0];
    if (!file) return;
    const status = $('#up-status');
    status.textContent = 'Анализирую звук: темп, энергия, дроп…';
    let info = { duration: null, peak: null };
    try { info = await analyzeAudio(file); } catch { /* браузер не смог декодировать — не страшно */ }
    const params = new URLSearchParams({
      title: form.title.value, tags: form.tags.value, description: form.description.value,
      explicit: form.explicit.checked ? '1' : '0',
    });
    if (info.duration) params.set('duration', info.duration.toFixed(2));
    if (info.peak != null) params.set('peak', info.peak.toFixed(1));
    if (info.features) params.set('features', JSON.stringify(info.features));
    status.textContent = 'Загрузка…';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/tracks?${params}`);
    xhr.setRequestHeader('Content-Type', file.type || 'audio/mpeg');
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) $('#up-bar').style.width = `${(ev.loaded / ev.total) * 100}%`; };
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || '{}');
      if (xhr.status >= 300) { status.textContent = data.error || 'Ошибка загрузки'; return; }
      toast('Опубликовано');
      location.hash = `#/u/${encodeURIComponent(state.me.username)}`;
    };
    xhr.onerror = () => { status.textContent = 'Сеть недоступна'; };
    xhr.send(file);
  };
}

// ---------- Вход ----------
function renderLogin() {
  view.innerHTML = `
    <div class="auth">
    <h1>Добро пожаловать</h1>
    <p class="lead">Войдите или создайте аккаунт — это займёт секунду.</p>
    <form class="form card" id="auth">
      <label>Имя<input type="text" name="username" autocomplete="username" required></label>
      <label>Пароль<input type="password" name="password" autocomplete="current-password" required minlength="8"></label>
      <div class="row">
        <button class="primary" data-mode="login">Войти</button>
        <button data-mode="register">Создать аккаунт</button>
      </div>
      <div class="muted" id="auth-err"></div>
    </form>
    </div>`;
  $('#auth').onsubmit = async (e) => {
    e.preventDefault();
    const mode = e.submitter?.dataset.mode ?? 'login';
    try {
      const { user } = await api(`/api/${mode}`, {
        method: 'POST', body: { username: e.target.username.value, password: e.target.password.value },
      });
      state.me = user;
      state.settings = null;
      renderAccount();
      location.hash = '#/wave';
    } catch (err) { $('#auth-err').textContent = err.message; }
  };
}

function renderAccount() {
  const el = $('#account');
  if (!state.me) {
    el.innerHTML = '<a href="#/login"><button class="primary">Войти</button></a>';
    return;
  }
  el.innerHTML = `<a class="who" href="#/u/${encodeURIComponent(state.me.username)}" title="Мой профиль">
      <span class="avatar">${esc(state.me.username.slice(0, 1).toUpperCase())}</span><span>${esc(state.me.username)}</span></a>
    <button id="logout" class="icon-btn" title="Выйти">${icon('logout')}</button>`;
  $('#logout').onclick = async () => {
    leaveCurrent(); // сначала отправляем итог прослушивания, пока сессия ещё жива
    audio.pause();
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    Object.assign(state, { me: null, cur: null, queue: [], mode: null, settings: null, profile: null });
    renderPlayer();
    renderAccount();
    location.hash = '#/wave';
  };
}

$('#search').onsubmit = (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (!q) return;
  location.hash = q.startsWith('#') ? `#/tag/${encodeURIComponent(q.slice(1))}` : `#/search/${encodeURIComponent(q)}`;
};

// Отправить остаток данных, если вкладку закрывают
addEventListener('pagehide', () => {
  const c = state.cur;
  if (!c || !state.me) return;
  closeSegment();
  if (c.segments.length && audio.duration > 0) {
    navigator.sendBeacon(`/api/tracks/${c.track.id}/listen`,
      new Blob([JSON.stringify({ duration: audio.duration, segments: c.segments, seeks: c.seeks })], { type: 'application/json' }));
  }
});

window.addEventListener('hashchange', router);
// Офлайн-оболочка и установка как приложения (работает на https и на localhost)
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Запуск. Если сервер недоступен (компьютер выключен, другой Wi-Fi) — не делаем вид,
// что человек вышел из аккаунта, а честно говорим, что нет связи, и переподключаемся.
let booted = false;
let retryTimer = null;
async function boot() {
  clearTimeout(retryTimer);
  try {
    const { user } = await api('/api/me');
    state.me = user ?? null;
  } catch {
    $('#offline').classList.remove('hidden');
    if (!booted) view.innerHTML = '<p class="muted">Ждём сервер NEYAMI…</p>';
    retryTimer = setTimeout(boot, 5000);
    return;
  }
  $('#offline').classList.add('hidden');
  booted = true;
  renderAccount();
  router();
}
window.addEventListener('online', boot);
hydrateIcons();
boot();
