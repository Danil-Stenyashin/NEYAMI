/**
 * Волна NEYAMI — прозрачный рекомендательный движок.
 *
 * Принципы:
 *  1. Учится на поведении, а не только на лайках: дослушал — плюс,
 *     пропустил в первые секунды — сильный минус, пропустил ближе к концу — почти ничего.
 *  2. Реагирует мгновенно: каждый новый сигнал сразу меняет следующую выдачу.
 *  3. Управляемый: слушатель сам двигает ползунки «знакомое ↔ новое» и
 *     «популярное ↔ андеграунд». Никаких скрытых «продвигаемых» треков.
 *  4. Честный к маленьким артистам: у треков с малым числом прослушиваний есть
 *     бонус исследования, иначе новые авторы никогда не попадут в рекомендации.
 *  5. Объяснимый: у каждого трека есть список причин, почему он в волне.
 *  6. Слышит звук: помнит, как звучит то, что вам нравится (темп, энергия, ударность),
 *     и находит похожее даже без тегов.
 *  7. Чувствует контекст: утром, ночью и в выходные вкус разный — волна это учитывает.
 *
 * Модуль чистый (без БД и I/O) — его легко тестировать и потом вынести в отдельный сервис.
 */

import { soundSimilarity, centroid, lerpSound, describeSound } from './sound.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HALF_LIFE = 21 * DAY; // вкусы меняются: старые сигналы постепенно теряют вес

export const EVENT_WEIGHTS = {
  play: 0.15,
  complete: 1.0,
  skip_early: -1.5,
  skip_late: -0.25,
  // «Быстрый поиск»: 15 секунд с дропа. Сигналы слабее, чем от полного прослушивания.
  preview_complete: 0.5,
  preview_skip: -0.5,
};
export const LIKE_WEIGHT = 3;
export const DISLIKE_WEIGHT = -4;

export function classifyEvent(e) {
  if (e.type !== 'skip') return e.type;
  const pos = Number(e.position) || 0;
  const dur = Number(e.duration) || 0;
  const earlyThreshold = dur > 0 ? Math.min(30, dur * 0.35) : 30;
  return pos < earlyThreshold ? 'skip_early' : 'skip_late';
}

export const decay = (ts, now) => Math.pow(0.5, Math.max(0, now - ts) / HALF_LIFE);

/** Сводит события и реакции пользователя в одну оценку на трек. */
export function buildUserSignals({ events = [], reactions = [], now = Date.now(), weightAt = null }) {
  const signal = new Map();
  const k = (ts) => (weightAt ? weightAt(ts) : 1);
  const heard = new Map(); // trackId -> время последнего прослушивания
  const add = (id, w) => signal.set(id, (signal.get(id) ?? 0) + w);

  for (const e of events) {
    const w = EVENT_WEIGHTS[classifyEvent(e)];
    if (w === undefined) continue;
    add(e.track_id, w * decay(e.created_at, now) * k(e.created_at));
    heard.set(e.track_id, Math.max(heard.get(e.track_id) ?? 0, e.created_at));
  }
  for (const r of reactions) {
    // явные оценки «липкие»: затухают максимум вдвое
    const w = r.value > 0 ? LIKE_WEIGHT : r.value < 0 ? DISLIKE_WEIGHT : 0;
    if (w) add(r.track_id, w * Math.max(0.5, decay(r.created_at, now)) * k(r.created_at));
  }
  return { signal, heard };
}

// ---------- Контекст: время суток и выходные ----------

/** Местные час и признак выходного. tzOffset — как Date#getTimezoneOffset() (минуты, UTC − местное). */
export function localTime(ts, tzOffset = 0) {
  const local = ts - tzOffset * 60_000;
  const hour = (((local / HOUR) % 24) + 24) % 24;
  const weekday = (Math.floor(local / DAY) + 4) % 7; // 1970-01-01 — четверг; 0 — воскресенье
  return { hour, weekend: weekday === 0 || weekday === 6 };
}

export function slotName(hour) {
  if (hour < 5 || hour >= 23) return 'ночью';
  if (hour < 12) return 'утром';
  if (hour < 18) return 'днём';
  return 'вечером';
}

/**
 * Насколько момент ts похож на целевой контекст: гауссово ядро по кругу часов (σ = 2.5 ч)
 * и множитель 0.6, если не совпадает тип дня (будни/выходные).
 */
export function contextKernel(target, tzOffset = 0) {
  return (ts) => {
    const t = localTime(ts, tzOffset);
    let dh = Math.abs(t.hour - target.hour);
    dh = Math.min(dh, 24 - dh);
    return Math.exp(-(dh * dh) / (2 * 2.5 * 2.5)) * (t.weekend === target.weekend ? 1 : 0.6);
  };
}

/** Сигналы, взвешенные по похожести контекста. confidence — сколько «похожих моментов» набралось. */
export function buildContextSignals({ events = [], reactions = [], now, target, tzOffset }) {
  const kernel = contextKernel(target, tzOffset);
  const { signal } = buildUserSignals({ events, reactions, now, weightAt: kernel });
  let mass = 0;
  for (const e of events) mass += kernel(e.created_at);
  for (const r of reactions) mass += kernel(r.created_at);
  return { signal, confidence: Math.min(1, mass / 8) };
}

/** Звуковой профиль: центр «нравится» и центр «не нравится». */
export function buildSoundProfile(signal, trackById) {
  const pos = [];
  const neg = [];
  for (const [id, w] of signal) {
    const f = trackById.get(id)?.features;
    if (!f) continue;
    if (w > 0) pos.push([f, w]);
    else if (w < 0) neg.push([f, -w]);
  }
  return { like: centroid(pos), dislike: centroid(neg) };
}

function soundScore(f, profile) {
  if (!f || !profile.like) return 0;
  let s = soundSimilarity(f, profile.like);
  if (profile.dislike) s -= 0.5 * Math.max(0, soundSimilarity(f, profile.dislike));
  return Math.max(-1, Math.min(1, s));
}

function normalizeMap(map) {
  let max = 0;
  for (const v of map.values()) max = Math.max(max, Math.abs(v));
  if (!max) return new Map();
  return new Map([...map].map(([k, v]) => [k, v / max]));
}

/** Профиль вкуса: какие теги и артисты нравятся (значения от -1 до 1). */
export function buildProfiles(signal, trackById) {
  const tags = new Map();
  const artists = new Map();
  for (const [id, w] of signal) {
    const t = trackById.get(id);
    if (!t) continue;
    const share = w / Math.sqrt(t.tags.length || 1);
    for (const tag of t.tags) tags.set(tag, (tags.get(tag) ?? 0) + share);
    artists.set(t.user_id, (artists.get(t.user_id) ?? 0) + w);
  }
  return { tags: normalizeMap(tags), artists: normalizeMap(artists) };
}

/** Коллаборативная фильтрация item-item: «кто лайкнул X, лайкнул и Y». */
export function buildCoLikes(likes) {
  const byUser = new Map();
  const likeCount = new Map();
  for (const { user_id, track_id } of likes) {
    if (!byUser.has(user_id)) byUser.set(user_id, []);
    byUser.get(user_id).push(track_id);
    likeCount.set(track_id, (likeCount.get(track_id) ?? 0) + 1);
  }
  const co = new Map();
  for (const list of byUser.values()) {
    const items = list.slice(-300); // защита от квадратичного взрыва на «лайкающих всё»
    for (const a of items) {
      let row = co.get(a);
      if (!row) co.set(a, (row = new Map()));
      for (const b of items) if (a !== b) row.set(b, (row.get(b) ?? 0) + 1);
    }
  }
  return { co, likeCount };
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Применяет ручные правки вкуса: forget — тег не учитывается, boost — «хочу больше»,
 * block — треки с тегом не предлагаются вовсе.
 */
export function applyTagOverrides(tagProfile, overrides = new Map()) {
  const out = new Map(tagProfile);
  for (const [tag, action] of overrides) {
    if (action === 'forget' || action === 'block') out.delete(tag);
    if (action === 'boost') out.set(tag, Math.max(out.get(tag) ?? 0, 0.8));
  }
  return out;
}

/** Собирает всё, что нужно для оценки кандидатов. */
export function buildContext({
  userId, tracks, events = [], reactions = [], allLikes = [], stats = new Map(),
  follows = new Set(), settings = {}, tagOverrides = new Map(), exclude = new Set(), now = Date.now(),
  tzOffset = 0,
}) {
  const trackById = new Map(tracks.map((t) => [t.id, t]));
  const { signal, heard } = buildUserSignals({ events, reactions, now });
  const profile = buildProfiles(signal, trackById);
  profile.tags = applyTagOverrides(profile.tags, tagOverrides);
  const sound = buildSoundProfile(signal, trackById);

  // Контекстный профиль: что вы слушаете именно в такое время
  const target = localTime(now, tzOffset);
  let context = { confidence: 0, target, tags: new Map(), sound: { like: null, dislike: null } };
  if (settings.context !== 0 && settings.context !== false) {
    const cs = buildContextSignals({ events, reactions, now, target, tzOffset });
    const cp = buildProfiles(cs.signal, trackById);
    context = {
      confidence: cs.confidence,
      target,
      tags: applyTagOverrides(cp.tags, tagOverrides),
      sound: buildSoundProfile(cs.signal, trackById),
    };
  }
  const { co, likeCount } = buildCoLikes(allLikes.filter((l) => l.user_id !== userId));

  let maxPos = 0;
  for (const w of signal.values()) maxPos = Math.max(maxPos, w);
  const seeds = [...signal].filter(([, w]) => w > 0).map(([id, w]) => [id, w / maxPos]);

  let maxPop = 0;
  const popRaw = new Map();
  for (const t of tracks) {
    const s = stats.get(t.id) ?? {};
    const v = Math.log1p((s.likes ?? 0) * 3 + (s.completes ?? 0) + (s.plays ?? 0) * 0.2);
    popRaw.set(t.id, v);
    maxPop = Math.max(maxPop, v);
  }

  return {
    userId, tracks, trackById, signal, heard, profile, sound, context, co, likeCount, seeds, popRaw, maxPop, stats, follows,
    exclude, now, tagOverrides,
    disliked: new Set(reactions.filter((r) => r.value < 0).map((r) => r.track_id)),
    blockedTags: new Set([...tagOverrides].filter(([, a]) => a === 'block').map(([t]) => t)),
    boostedTags: new Set([...tagOverrides].filter(([, a]) => a === 'boost').map(([t]) => t)),
    // насколько мы уже знаем пользователя: 0 — новичок, 1 — достаточно сигналов
    confidence: Math.min(1, (signal.size + [...tagOverrides.values()].filter((a) => a === 'boost').length * 2) / 6),
    discovery: clamp(Number(settings.discovery ?? 0.5), 0, 1),
    underground: clamp(Number(settings.underground ?? 0.5), 0, 1),
    hideExplicit: Boolean(settings.hide_explicit),
  };
}

/** Оценивает один трек. Возвращает null, если трек нельзя предлагать. */
export function scoreTrack(t, ctx, rng = Math.random) {
  if (t.user_id === ctx.userId || ctx.exclude.has(t.id) || ctx.disliked.has(t.id)) return null;
  if (ctx.hideExplicit && t.explicit) return null;
  if (t.tags.some((tag) => ctx.blockedTags.has(tag))) return null;

  const { discovery, underground, profile, now } = ctx;
  const s = ctx.stats.get(t.id) ?? {};
  const parts = {};

  // 1. Совпадение по тегам — общее и «в этом контексте» (время суток, выходные)
  const tagMatch = (map) => {
    let sum = 0;
    for (const tag of t.tags) sum += map.get(tag) ?? 0;
    return t.tags.length ? clamp(sum / Math.sqrt(t.tags.length), -1, 1) : 0;
  };
  const cw = 0.5 * ctx.context.confidence; // доля контекста растёт по мере накопления данных
  parts.tagsGeneral = tagMatch(profile.tags);
  parts.tagsContext = cw ? tagMatch(ctx.context.tags) : 0;
  parts.tags = (1 - cw) * parts.tagsGeneral + cw * parts.tagsContext;

  // 1б. Звучание: похоже ли на то, что нравится (работает и для треков без тегов)
  parts.soundGeneral = soundScore(t.features, ctx.sound);
  parts.soundContext = cw ? soundScore(t.features, ctx.context.sound) : 0;
  parts.sound = (1 - cw) * parts.soundGeneral + cw * parts.soundContext;

  // 2. Коллаборативный сигнал
  let collab = 0;
  let collabVia = null;
  let collabBest = 0;
  const row = ctx.co.get(t.id);
  if (row) {
    for (const [seedId, w] of ctx.seeds) {
      const n = row.get(seedId);
      if (!n) continue;
      const sim = n / Math.sqrt((ctx.likeCount.get(t.id) ?? 1) * (ctx.likeCount.get(seedId) ?? 1));
      collab += w * sim;
      if (w * sim > collabBest) [collabBest, collabVia] = [w * sim, seedId];
    }
  }
  parts.collab = Math.tanh(collab / 1.5);

  // 3. Артист
  parts.artist = profile.artists.get(t.user_id) ?? 0;
  parts.follow = ctx.follows.has(t.user_id) ? 0.35 : 0;

  let score = ctx.confidence * (1.0 * parts.tags + 0.7 * parts.sound + 0.9 * parts.collab + 0.5 * parts.artist) + parts.follow;

  // 4. Качество (байесовская «дослушиваемость») и популярность
  const quality =
    ((s.completes ?? 0) + 2 * (s.likes ?? 0) + 1) /
    ((s.completes ?? 0) + (s.skips ?? 0) + 2 * (s.likes ?? 0) + 2);
  const pop = ctx.maxPop ? ctx.popRaw.get(t.id) / ctx.maxPop : 0;
  score += 0.35 * (quality - 0.5);
  score += 0.4 * (1 - 2 * underground) * pop;

  // 5. Исследование: свежие и малоизвестные треки получают шанс
  const plays = s.plays ?? 0;
  const explore = 1 / Math.sqrt(1 + plays);
  const fresh = Math.pow(0.5, Math.max(0, now - t.created_at) / (7 * DAY));
  score += discovery * (0.3 * explore + 0.15 * fresh);

  // 6. Знакомое vs новое
  const lastHeard = ctx.heard.get(t.id);
  const own = ctx.signal.get(t.id) ?? 0;
  if (lastHeard) {
    const ago = now - lastHeard;
    if (ago < 2 * HOUR) score -= 1; // только что звучал
    else if (ago < DAY) score -= 0.3; // звучал сегодня — не надоедаем
    else score += own > 0 ? (1 - discovery) * 0.5 : -0.3; // любимое, по которому успели соскучиться
  } else {
    score += discovery * 0.3;
  }

  // 7. Немного случайности, чтобы волна не застывала
  score += (rng() - 0.5) * (0.1 + 0.3 * discovery);

  return { track: t, score, parts, collabVia, plays, lastHeard, own, pop };
}

/** Жадный отбор с разнообразием: не ставим одного артиста подряд и штрафуем повторы. */
function diversify(scored, count) {
  const picked = [];
  const perArtist = new Map();
  const pool = scored.sort((a, b) => b.score - a.score).slice(0, Math.max(count * 8, 50));
  while (picked.length < count && pool.length) {
    const prevArtist = picked.at(-1)?.track.user_id;
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let adj = c.score - 0.35 * (perArtist.get(c.track.user_id) ?? 0);
      if (c.track.user_id === prevArtist) adj -= 1;
      if (adj > bestScore) [bestScore, bestIdx] = [adj, i];
    }
    const [c] = pool.splice(bestIdx, 1);
    perArtist.set(c.track.user_id, (perArtist.get(c.track.user_id) ?? 0) + 1);
    picked.push(c);
  }
  return picked;
}

export function describeProfile(ctx) {
  const entries = [...ctx.profile.tags];
  const ctxTags = [...ctx.context.tags].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    confidence: ctx.confidence,
    sound: ctx.sound.like ? { ...ctx.sound.like, text: describeSound(ctx.sound.like) } : null,
    context: {
      slot: slotName(ctx.context.target.hour),
      weekend: ctx.context.target.weekend,
      confidence: Math.round(ctx.context.confidence * 100) / 100,
      topTags: ctxTags,
      sound: ctx.context.sound.like ? describeSound(ctx.context.sound.like) : null,
    },
    topTags: entries.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 12),
    avoidTags: entries.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, 8),
    // треки, сильнее всего повлиявшие на вкус — их можно «забыть»
    influences: [...ctx.signal]
      .filter(([id]) => ctx.trackById.has(id))
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 12)
      .map(([id, w]) => ({ track_id: id, weight: Math.round(w * 100) / 100 })),
  };
}

/** Персональная волна. Параметры — см. buildContext, плюс count и rng. */
export function recommend(params) {
  const { count = 10, rng = Math.random } = params;
  const ctx = buildContext(params);
  const scored = [];
  for (const t of params.tracks) {
    const c = scoreTrack(t, ctx, rng);
    if (c) scored.push(c);
  }
  return {
    items: diversify(scored, count).map((c) => ({
      track: c.track,
      score: Math.round(c.score * 1000) / 1000,
      reasons: explain(c, ctx),
    })),
    profile: describeProfile(ctx),
  };
}

/** Сходство тегов по совместной встречаемости в каталоге (косинус). */
export function tagSimilarity(tracks) {
  const count = new Map();
  const pair = new Map();
  for (const t of tracks) {
    for (const a of t.tags) {
      count.set(a, (count.get(a) ?? 0) + 1);
      for (const b of t.tags) if (a < b) pair.set(`${a}|${b}`, (pair.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  return (a, b) => {
    if (a === b) return 1;
    const n = pair.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0;
    return n ? (n / Math.sqrt(count.get(a) * count.get(b))) ** 1.5 : 0; // степень — меньше «размытых» связей
  };
}

/**
 * Волна-мост: плавный переход от тега `from` к тегу `to` за `length` треков.
 * На шаге i целевая точка смещается от from к to; трек выбирается по близости к ней
 * плюс (в меньшей степени) по личному вкусу.
 */
export function bridge(params) {
  const { from, to, length = 8, rng = Math.random } = params;
  const ctx = buildContext(params);
  const sim = tagSimilarity(params.tracks);
  const affinity = (t, tag) => t.tags.reduce((m, x) => Math.max(m, sim(x, tag)), 0);

  // «Как звучит» каждый конец моста — средние признаки треков с этим тегом
  const soundOf = (tag) => centroid(params.tracks.filter((t) => t.features && t.tags.includes(tag)).map((t) => [t.features, 1]));
  const soundFrom = soundOf(from);
  const soundTo = soundOf(to);
  const hasSound = Boolean(soundFrom && soundTo);

  const candidates = [];
  for (const t of params.tracks) {
    const c = scoreTrack(t, ctx, rng);
    if (!c) continue;
    c.aFrom = affinity(t, from);
    c.aTo = affinity(t, to);
    const tagLinked = Math.max(c.aFrom, c.aTo) >= 0.5;
    // трек без нужных тегов, но звучащий как один из концов, тоже может попасть на мост
    // (сравниваем с точками на всём пути — «середина» не похожа ни на один из концов)
    let soundLinked = false;
    if (hasSound && t.features) {
      for (let a = 0; a <= 1.001 && !soundLinked; a += 0.25) {
        soundLinked = soundSimilarity(t.features, lerpSound(soundFrom, soundTo, a)) >= 0.6;
      }
    }
    if (tagLinked || soundLinked) candidates.push({ ...c, tagLinked });
  }

  const steps = Math.max(2, Math.min(30, length));
  const used = new Set();
  const items = [];
  let prevArtist = null;
  for (let i = 0; i < steps; i++) {
    const alpha = i / (steps - 1);
    const target = hasSound ? lerpSound(soundFrom, soundTo, alpha) : null;
    let best = null;
    let bestFit = -Infinity;
    for (const c of candidates) {
      if (used.has(c.track.id)) continue;
      const soundFit = target && c.track.features ? soundSimilarity(c.track.features, target) : 0;
      if (!c.tagLinked && soundFit < 0.6) continue; // без тегов — только если точно звучит «по пути»
      // хотим, чтобы «доля from» и «доля to» трека совпадали с нужной точкой пути,
      // звучание было близко к промежуточной точке, а связь с маршрутом — сильной
      const fit = 1.5 - Math.abs(c.aFrom - (1 - alpha)) - Math.abs(c.aTo - alpha)
        + 0.5 * (c.aFrom + c.aTo) + 0.8 * soundFit + 0.25 * c.score
        - (c.track.user_id === prevArtist ? 0.5 : 0);
      if (fit > bestFit) [bestFit, best] = [fit, c];
    }
    if (!best) break;
    used.add(best.track.id);
    prevArtist = best.track.user_id;
    const pct = Math.round(alpha * 100);
    const step = `Плавный переход от #${from} к #${to}: ${i + 1} из ${steps}`;
    items.push({
      track: best.track,
      score: Math.round(bestFit * 1000) / 1000,
      reasons: [step, ...explain(best, ctx).slice(0, 1)],
    });
  }
  return { items, profile: describeProfile(ctx), path: hasSound ? { from: describeSound(soundFrom), to: describeSound(soundTo) } : null };
}

function explain(c, ctx) {
  const reasons = [];
  const { track: t, parts } = c;
  const { profile, trackById, follows, boostedTags } = ctx;
  const boosted = t.tags.filter((tag) => boostedTags.has(tag));
  if (boosted.length) reasons.push(`Вы просили больше ${boosted.map((x) => '#' + x).join(' ')}`);
  if (parts.tags > 0.2) {
    const liked = t.tags.filter((tag) => !boostedTags.has(tag) && (profile.tags.get(tag) ?? 0) > 0.15).slice(0, 3);
    if (liked.length) reasons.push(`Похоже на то, что вам нравится: ${liked.map((x) => '#' + x).join(' ')}`);
  }
  // «в это время вы слушаете такое»: контекстных данных достаточно и трек в них явно попадает
  if (ctx.context.confidence >= 0.3 && parts.tagsContext > 0.5 && parts.tagsContext >= parts.tagsGeneral - 0.05) {
    const when = `${slotName(ctx.context.target.hour)}${ctx.context.target.weekend ? ' в выходные' : ''}`;
    reasons.push(`Вы часто слушаете такое ${when}`);
  }
  if (parts.sound > 0.45 && t.features) {
    reasons.push(`Звучит в вашем духе — ${describeSound(t.features)}`);
  }
  if (parts.collab > 0.15 && c.collabVia != null) {
    const via = trackById.get(c.collabVia);
    if (via) reasons.push(`Те, кому понравился «${via.title}», лайкают и это`);
  }
  if (follows.has(t.user_id)) reasons.push(`Вы подписаны на ${t.artist}`);
  else if (parts.artist > 0.3) reasons.push(`Вам нравится ${t.artist}`);
  if (c.lastHeard && c.own > 0 && ctx.now - c.lastHeard >= DAY) reasons.push('Вы его любили, а он давно не звучал');
  if (!c.lastHeard && c.plays < 5) reasons.push('Свежая находка — его ещё почти никто не слышал');
  if (!reasons.length && c.pop > 0.6) reasons.push('Популярно у слушателей NEYAMI');
  if (!reasons.length) reasons.push('Пробую что-то новое — подскажите, нравится ли');
  return reasons.slice(0, 3); // три главные причины — дальше читать уже никто не будет
}
