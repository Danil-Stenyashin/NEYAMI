// Тонкие линейные иконки NEYAMI (24×24, цвет берётся из текста).
const P = {
  wave: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  zap: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.4 3 5.2"/>',
  heart: '<path d="M12 19.5s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 6.6a4.2 4.2 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/>',
  heartFill: '<path fill="currentColor" d="M12 19.5s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 6.6a4.2 4.2 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="m15.2 8.8-1.9 4.5-4.5 1.9 1.9-4.5 4.5-1.9z"/>',
  upload: '<path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9M5 19.5h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  play: '<path fill="currentColor" stroke="none" d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2A.8.8 0 0 0 8 5.8z"/>',
  pause: '<rect fill="currentColor" stroke="none" x="6.5" y="5" width="4" height="14" rx="1.2"/><rect fill="currentColor" stroke="none" x="13.5" y="5" width="4" height="14" rx="1.2"/>',
  next: '<path fill="currentColor" stroke="none" d="M6 6.3v11.4a.8.8 0 0 0 1.2.7l8.4-5.7a.8.8 0 0 0 0-1.4L7.2 5.6A.8.8 0 0 0 6 6.3z"/><path d="M18.5 5.5v13"/>',
  dislike: '<path d="M16.5 4.5H8a2 2 0 0 0-2 1.6l-1.3 6.5A2 2 0 0 0 6.7 15H10l-.8 3.6a1.6 1.6 0 0 0 2.9 1.2l4.4-5.8V4.5zM16.5 4.5h3v9.5h-3"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".6" fill="currentColor"/>',
  flag: '<path d="M5.5 20.5v-16M5.5 4.5h11l-2 4 2 4h-11"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  logout: '<path d="M14 4.5h4.5v15H14M10 16l4-4-4-4M14 12H4.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  rotate: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.7h3.7"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
  headphones: '<path d="M4.5 16v-4a7.5 7.5 0 0 1 15 0v4"/><rect x="4.5" y="14" width="3.5" height="6" rx="1.2"/><rect x="16" y="14" width="3.5" height="6" rx="1.2"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>',
};

export function icon(name, size = 18) {
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
}

/** Заполняет все элементы с data-icon в разметке. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 18);
  }
}
