// NEYAMI — клиент. Без фреймворков: hash-роутинг, один <audio>, состояние в модуле.

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
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
  if (c.lastT - c.segStart >= 0.5) c.segments.push([c.segStart, c.lastT]);
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
  const { track, reasons = [] } = item;
  state.cur = {
    track, reasons, preview,
    segments: [], seeks: [], segStart: null, lastT: startAt,
    outcomeSent: false, programmaticSeek: startAt > 0,
  };
  audio.src = `/api/tracks/${track.id}/stream`;
  const begin = () => {
    if (startAt > 0) {
      state.cur.programmaticSeek = true;
      audio.currentTime = startAt;
    }
    audio.play().catch(() => {});
  };
  audio.addEventListener('loadedmetadata', begin, { once: true });
  audio.load();
  if (!preview) sendEvent('play');
  renderPlayer();
  loadHeat(track);
}

audio.addEventListener('playing', () => {
  const c = state.cur;
  if (c && c.segStart == null) c.segStart = c.lastT = audio.currentTime;
  $('#p-toggle').textContent = '⏸';
  $('.wave-btn')?.classList.add('playing');
});
audio.addEventListener('pause', () => {
  closeSegment();
  $('#p-toggle').textContent = '▶';
  $('.wave-btn')?.classList.remove('playing');
});
audio.addEventListener('timeupdate', () => {
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
  c.programmaticSeek = false;
  c.segStart = audio.paused ? null : audio.currentTime;
  c.lastT = audio.currentTime;
});
audio.addEventListener('ended', () => {
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
    toast(state.mode === 'bridge' ? 'Мост пройден 🌉' : 'Очередь закончилась');
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
    const data = await api(`/api/wave?count=10&exclude=${exclude}`);
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
function renderPlayer() {
  const c = state.cur;
  $('#player').classList.toggle('hidden', !c);
  if (!c) return;
  const t = c.track;
  $('#p-title').innerHTML = `${esc(t.title)} ${t.explicit ? '<span class="badge">18+</span>' : ''}`;
  $('#p-artist').innerHTML = `<a href="#/u/${encodeURIComponent(t.artist.username)}">${esc(t.artist.username)}</a>`;
  $('#p-like').textContent = t.my_reaction > 0 ? '♥' : '♡';
  $('#p-like').classList.toggle('active', t.my_reaction > 0);
  $('#p-reasons').textContent = c.reasons.length ? 'Почему этот трек: ' + c.reasons.join(' · ') : '';
  $('#p-drop').title = `К лучшему моменту (${fmt(t.moment.start)})`;
}

function updateProgress() {
  const d = audio.duration;
  $('#p-time').textContent = fmt(audio.currentTime);
  $('#p-dur').textContent = fmt(d);
  if (d > 0 && !seekDragging) $('#p-seek').value = Math.round((audio.currentTime / d) * 1000);
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
  const max = Math.max(1, ...heat.heard);
  const bw = w / heat.heard.length;
  heat.heard.forEach((v, i) => {
    const bh = Math.max(1, (v / max) * h);
    ctx.fillStyle = 'rgba(255,154,60,.45)';
    ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh);
  });
  if (duration > 0) {
    // лучший момент: лёгкая подсветка + яркая метка начала
    const x0 = (moment.start / duration) * w;
    const x1 = (moment.end / duration) * w;
    ctx.fillStyle = 'rgba(255,90,54,.15)';
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.fillStyle = '#ff5a36';
    ctx.fillRect(x0, 0, 2 * devicePixelRatio, h);
  }
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
  return `
  <div class="track ${now ? 'now' : ''}" data-idx="${idx}">
    <button class="play" data-act="play" title="Играть">▶</button>
    <div class="meta">
      <div class="title">${esc(t.title)} ${t.explicit ? '<span class="badge">18+</span>' : ''}</div>
      <div class="sub">
        <a href="#/u/${encodeURIComponent(t.artist.username)}">${esc(t.artist.username)}</a>
        <span>${fmt(t.duration)}</span>
        <span>♥ ${t.likes}</span><span>▶ ${t.plays}</span>
        ${t.tags.map((g) => `<a class="chip tag" href="#/tag/${encodeURIComponent(g)}">#${esc(g)}</a>`).join('')}
      </div>
      ${item.reasons?.length ? `<div class="why">${item.reasons.map(esc).join(' · ')}</div>` : ''}
    </div>
    <div class="actions">
      <button data-act="drop" class="opt" title="Слушать с лучшего момента (${fmt(t.moment.start)})">⤓ дроп</button>
      <button data-act="like" class="${t.my_reaction > 0 ? 'active' : ''}" title="Нравится">${t.my_reaction > 0 ? '♥' : '♡'}</button>
      ${isMine ? '<button data-act="delete" class="opt" title="Удалить">🗑</button>' : '<button data-act="report" class="opt" title="Пожаловаться на нарушение закона">⚑</button>'}
    </div>
  </div>`;
}

function renderTrackList(container, items, { mode = 'list' } = {}) {
  if (!items.length) {
    container.innerHTML = '<p class="muted">Пока пусто.</p>';
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
  following: () => requireLogin() && renderList('Новое от подписок', '/api/tracks?feed=following'),
  likes: () => requireLogin() && renderList('Мне нравится', '/api/likes'),
  tag: (tag) => renderList(`#${tag}`, `/api/tracks?tag=${encodeURIComponent(tag)}`),
  search: (q) => renderList(`Поиск: ${q}`, `/api/tracks?q=${encodeURIComponent(q)}`),
  u: renderProfile,
  upload: renderUpload,
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

async function renderList(title, url) {
  const { tracks } = await api(url);
  view.innerHTML = `<h1>${esc(title)}</h1><div id="list"></div>`;
  renderTrackList($('#list'), tracks.map((track) => ({ track })));
}

// ---------- Волна ----------
async function renderWave() {
  if (!state.me) {
    view.innerHTML = `
      <div class="card">
        <h1>Волна, которая слушает вас</h1>
        <p>NEYAMI учится на том, что вы дослушиваете и пропускаете, объясняет каждую рекомендацию
        и даёт вам ручки управления. Никаких скрытых «продвигаемых» треков.</p>
        <p><a href="#/login"><button class="primary">Войти или зарегистрироваться</button></a></p>
      </div>`;
    return;
  }
  if (!state.settings) state.settings = (await api('/api/wave/settings')).settings;
  const s = state.settings;
  const { tags } = await api('/api/tags');
  view.innerHTML = `
    <div class="wave-hero">
      <button class="wave-btn ${!audio.paused && state.mode === 'wave' ? 'playing' : ''}" id="wave-start">
        ${state.mode === 'wave' ? 'Волна ↻' : 'Моя волна'}
      </button>
      <div>
        <div class="slider">
          <div class="labels"><span>Любимое</span><b>Настрой волны</b><span>Новое</span></div>
          <input type="range" id="discovery" min="0" max="100" value="${Math.round(s.discovery * 100)}">
        </div>
        <div class="slider">
          <div class="labels"><span>Популярное</span><span></span><span>Андеграунд</span></div>
          <input type="range" id="underground" min="0" max="100" value="${Math.round(s.underground * 100)}">
        </div>
        <div class="row-opts">
          <label><input type="checkbox" id="hide-explicit" ${s.hide_explicit ? 'checked' : ''}> Скрывать 18+</label>
          <label title="Прослушивания не будут влиять на волну — удобно, если включает гость или ребёнок">
            <input type="checkbox" id="private-mode" ${s.private_mode ? 'checked' : ''}> 🕶 Не запоминать
          </label>
          <a href="#/quick"><button>⚡ Быстрый поиск</button></a>
        </div>
        <div style="margin-top:12px"><span class="muted">Ваш вкус: </span><span id="profile-chips" class="chips"></span>
          <a href="#/taste" class="muted"> — настроить</a></div>
      </div>
    </div>

    <h2>🌉 Волна-мост</h2>
    <div class="card bridge">
      <p class="muted" style="margin-top:0">Плавный переход от одного настроения к другому — для тренировки, вечеринки или засыпания.</p>
      <div class="row">
        <input type="text" id="b-from" list="tags" placeholder="откуда, напр. lofi" value="${esc(state.bridge?.from ?? '')}">
        <span>→</span>
        <input type="text" id="b-to" list="tags" placeholder="куда, напр. dnb" value="${esc(state.bridge?.to ?? '')}">
        <select id="b-len">${[5, 8, 12, 20].map((n) => `<option ${n === (state.bridge?.length ?? 8) ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <button id="b-go" class="primary">Построить</button>
      </div>
      <datalist id="tags">${tags.map((t) => `<option value="${esc(t.tag)}">${t.count}</option>`).join('')}</datalist>
    </div>

    <h2 id="queue-title">Дальше в волне</h2>
    <div id="queue"></div>`;

  $('#wave-start').onclick = startWave;
  let saveTimer;
  const save = (patch) => {
    Object.assign(state.settings, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await api('/api/wave/settings', { method: 'PUT', body: patch }).catch((e) => toast(e.message));
      if (state.mode === 'wave') { state.queue = []; refillWave(); }
    }, 350);
  };
  $('#discovery').oninput = (e) => save({ discovery: e.target.value / 100 });
  $('#underground').oninput = (e) => save({ underground: e.target.value / 100 });
  $('#hide-explicit').onchange = (e) => save({ hide_explicit: e.target.checked });
  $('#private-mode').onchange = (e) => {
    save({ private_mode: e.target.checked });
    toast(e.target.checked ? 'Режим «не запоминать» включён 🕶' : 'Волна снова учится на ваших прослушиваниях');
  };
  $('#b-go').onclick = startBridge;
  renderQueue();
  if (!state.profile) {
    api('/api/wave?count=1').then((d) => { state.profile = d.profile; renderProfileChips(); }).catch(() => {});
  } else renderProfileChips();
}

function renderProfileChips() {
  const el = $('#profile-chips');
  if (!el || !state.profile) return;
  const p = state.profile;
  el.innerHTML = p.topTags.length
    ? p.topTags.slice(0, 6).map(([t]) => `<span class="chip pos">#${esc(t)}</span>`).join('')
    : '<span class="muted">пока не знаю — включите волну и оценивайте треки</span>';
}

function renderQueue() {
  const el = $('#queue');
  if (!el) return;
  $('#queue-title').textContent = state.mode === 'bridge'
    ? `Мост #${state.bridge.from} → #${state.bridge.to}` : 'Дальше в волне';
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
    const data = await api(`/api/wave/bridge?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&length=${length}`);
    if (!data.items.length) return toast('Не нашёл треков с такими тегами');
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
    <h1>⚡ Быстрый поиск</h1>
    <p class="muted">Каждый трек звучит ${PREVIEW_SEC} секунд с самого сильного момента — его NEYAMI определяет сама по тому,
    что люди слушают и куда перематывают. Оценивайте — волна учится в разы быстрее.</p>
    <div class="card quick" id="quick"><p class="muted">Подбираю…</p></div>
    <p class="muted keys">← не моё · → нравится · пробел — пауза · ↓ слушать целиком</p>`;
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
    const data = await api(`/api/wave?count=10&exclude=${exclude}`).catch((e) => (toast(e.message), { items: [] }));
    data.items.forEach((i) => state.seen.add(i.track.id));
    preview.items = data.items;
  }
  const item = (preview.item = preview.items.shift());
  const box = $('#quick');
  if (!box) return;
  if (!item) {
    box.innerHTML = '<p>Вы прослушали всё, что есть 🎉 Загляните позже или <a href="#/upload">загрузите своё</a>.</p>';
    return;
  }
  state.mode = 'preview';
  const t = item.track;
  box.innerHTML = `
    <div class="q-title">${esc(t.title)} ${t.explicit ? '<span class="badge">18+</span>' : ''}</div>
    <div class="q-artist"><a href="#/u/${encodeURIComponent(t.artist.username)}">${esc(t.artist.username)}</a></div>
    <div class="chips" style="justify-content:center;margin:10px 0">${t.tags.map((g) => `<span class="chip">#${esc(g)}</span>`).join('')}</div>
    <div class="why">${item.reasons.map(esc).join(' · ')}</div>
    <div class="muted q-moment">с ${fmt(t.moment.start)} · ${{ listeners: 'дроп определён слушателями', audio: 'дроп по анализу звука', default: 'пока мало данных' }[t.moment.source]}</div>
    <div class="progress"><div id="q-bar"></div></div>
    <div class="q-actions">
      <button data-q="no" title="Не моё (←)">👎 Не моё</button>
      <button data-q="full" title="Слушать целиком (↓)">🎧 Целиком</button>
      <button data-q="yes" class="primary" title="Нравится (→)">♥ Нравится</button>
    </div>`;
  box.onclick = (e) => {
    const b = e.target.closest('button[data-q]');
    if (b) previewAction(b.dataset.q);
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
    toast('♥ Добавлено в «Мне нравится»');
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
  const { profile, overrides, settings } = await api('/api/taste');
  const actLabel = { forget: 'забыт', boost: 'больше', block: 'скрыт' };
  const pct = Math.round(profile.confidence * 100);
  view.innerHTML = `
    <h1>Мой вкус</h1>
    <p class="muted">Это всё, что волна знает о вас. Никаких скрытых данных — и всё можно поправить.</p>

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div>Насколько волна вас знает: <b>${pct}%</b></div>
        <label><input type="checkbox" id="t-private" ${settings.private_mode ? 'checked' : ''}> 🕶 Не запоминать прослушивания</label>
      </div>
      <div class="progress" style="margin-top:8px"><div style="width:${pct}%"></div></div>
    </div>

    <h2>Что вам нравится</h2>
    <div class="taste-tags">${profile.topTags.map(([t, v]) => tasteTag(t, v)).join('') || '<p class="muted">Пока пусто.</p>'}</div>

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
          <a href="#" data-undo="${esc(o.tag)}" title="Отменить">✕</a></span>`).join('') || '<span class="muted">Нет правок.</span>'}
      </div>
    </div>

    <h2>Что сильнее всего повлияло на волну</h2>
    <p class="muted">Включили что-то случайно? «Забыть» — и волна перестанет на это опираться.</p>
    <div class="tracks">
      ${profile.influences.map((i) => `
        <div class="track">
          <span class="chip ${i.weight > 0 ? 'pos' : 'neg'}">${i.weight > 0 ? '+' : ''}${i.weight}</span>
          <div class="meta"><div class="title">${esc(i.track.title)}</div><div class="sub">${esc(i.track.artist.username)}</div></div>
          <div class="actions"><button data-forget="${i.track_id}">Забыть</button></div>
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
      toast('Забыто');
      state.profile = null;
      renderTaste();
    }
  };
  $('#t-private').onchange = async (e) => {
    await api('/api/wave/settings', { method: 'PUT', body: { private_mode: e.target.checked } });
    if (state.settings) state.settings.private_mode = e.target.checked ? 1 : 0;
    toast(e.target.checked ? 'Режим «не запоминать» включён 🕶' : 'Волна снова учится');
  };
}

function tasteTag(tag, v) {
  return `
    <div class="taste-tag">
      <a href="#/tag/${encodeURIComponent(tag)}">#${esc(tag)}</a>
      <div class="meter"><div class="${v >= 0 ? 'pos' : 'neg'}" style="width:${Math.round(Math.abs(v) * 100)}%"></div></div>
      <span class="ops">
        <button data-tag="${esc(tag)}" data-tag-act="boost" title="Хочу больше">＋</button>
        <button data-tag="${esc(tag)}" data-tag-act="forget" title="Забыть — не учитывать в волне">↺</button>
        <button data-tag="${esc(tag)}" data-tag-act="block" title="Не предлагать вообще">⊘</button>
      </span>
    </div>`;
}

// ---------- Профиль артиста ----------
async function renderProfile(name) {
  const { user, tracks } = await api(`/api/users/${encodeURIComponent(name)}`);
  const isMe = state.me?.id === user.id;
  view.innerHTML = `
    <h1>${esc(user.username)}</h1>
    <p class="muted">${user.followers} подписчиков · ${tracks.length} треков</p>
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
  return { duration: buf.duration, peak: rms.length > 2 * W ? best / 2 : null };
}

function renderUpload() {
  if (!requireLogin()) return;
  view.innerHTML = `
    <h1>Загрузить трек</h1>
    <p class="muted">Без премодерации и скрытых понижений в выдаче. Удаляем только то, что нарушает закон или чужие права.</p>
    <form class="form card" id="up">
      <label>Аудиофайл (mp3, ogg, opus, wav, flac, m4a — до 100 МБ)<input type="file" name="file" accept="audio/*" required></label>
      <label>Название<input type="text" name="title" maxlength="200" required></label>
      <label>Теги — через запятую или пробел (жанр, настроение, темп)<input type="text" name="tags" placeholder="lofi, ночь, chill"></label>
      <label>Описание<textarea name="description" rows="3" maxlength="5000"></textarea></label>
      <label class="row"><input type="checkbox" name="explicit"> Отметка 18+ (слушатели сами решают, скрывать ли такое)</label>
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
    status.textContent = 'Анализирую звук, ищу дроп…';
    let info = { duration: null, peak: null };
    try { info = await analyzeAudio(file); } catch { /* браузер не смог декодировать — не страшно */ }
    const params = new URLSearchParams({
      title: form.title.value, tags: form.tags.value, description: form.description.value,
      explicit: form.explicit.checked ? '1' : '0',
    });
    if (info.duration) params.set('duration', info.duration.toFixed(2));
    if (info.peak != null) params.set('peak', info.peak.toFixed(1));
    status.textContent = 'Загрузка…';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/tracks?${params}`);
    xhr.setRequestHeader('Content-Type', file.type || 'audio/mpeg');
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) $('#up-bar').style.width = `${(ev.loaded / ev.total) * 100}%`; };
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || '{}');
      if (xhr.status >= 300) { status.textContent = data.error || 'Ошибка загрузки'; return; }
      toast('Опубликовано 🎉');
      location.hash = `#/u/${encodeURIComponent(state.me.username)}`;
    };
    xhr.onerror = () => { status.textContent = 'Сеть недоступна'; };
    xhr.send(file);
  };
}

// ---------- Вход ----------
function renderLogin() {
  view.innerHTML = `
    <h1>Вход</h1>
    <form class="form card" id="auth">
      <label>Имя<input type="text" name="username" autocomplete="username" required></label>
      <label>Пароль<input type="password" name="password" autocomplete="current-password" required minlength="8"></label>
      <div class="row">
        <button class="primary" data-mode="login">Войти</button>
        <button data-mode="register">Создать аккаунт</button>
      </div>
      <div class="muted" id="auth-err"></div>
    </form>`;
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
    el.innerHTML = '<a href="#/login"><button>Войти</button></a>';
    return;
  }
  el.innerHTML = `<a href="#/taste" title="Мой вкус">🧭</a>
    <a href="#/u/${encodeURIComponent(state.me.username)}">${esc(state.me.username)}</a>
    <button id="logout">Выйти</button>`;
  $('#logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    leaveCurrent();
    audio.pause();
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
(async () => {
  state.me = (await api('/api/me').catch(() => ({}))).user ?? null;
  renderAccount();
  router();
})();
