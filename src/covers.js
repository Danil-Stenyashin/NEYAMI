// Сгенерированные обложки: спокойная абстракция в тёплой палитре, одинаковая для одного и того же трека.

const PALETTES = [
  ['#f3e4dc', '#c96442', '#1f1e1d'],
  ['#ece7dc', '#8f9c74', '#2f3a2a'],
  ['#e6e0d6', '#5f7a8a', '#1e2a33'],
  ['#efe3e8', '#b98da0', '#3a2a33'],
  ['#f1e8d6', '#d9a273', '#3b2a1a'],
  ['#e9e6e0', '#2f2e2b', '#c96442'],
  ['#dfe6e3', '#6f9488', '#1f2e2a'],
  ['#f2ece2', '#a7896b', '#2c241c'],
];

function hash(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function coverSvg(id, title = '', artist = '') {
  let seed = hash(`${id}|${title}|${artist}`);
  const rnd = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0) % 10000) / 10000;
  const [bg, main, ink] = PALETTES[seed % PALETTES.length];
  const style = Math.floor(rnd() * 3);
  let art = '';
  if (style === 0) {
    // большой круг и тонкие кольца
    const cx = 120 + rnd() * 160;
    const cy = 120 + rnd() * 160;
    art = `<circle cx="${cx}" cy="${cy}" r="${110 + rnd() * 50}" fill="${main}"/>`
      + [1, 2, 3].map((k) => `<circle cx="${cx}" cy="${cy}" r="${150 + k * 34}" fill="none" stroke="${ink}" stroke-opacity=".18" stroke-width="2"/>`).join('');
  } else if (style === 1) {
    // волна из полосок
    const n = 9 + Math.floor(rnd() * 6);
    const w = 400 / n;
    for (let i = 0; i < n; i++) {
      const h = 60 + Math.abs(Math.sin(i * (0.6 + rnd() * 0.4))) * 220;
      art += `<rect x="${i * w + w * 0.3}" y="${200 - h / 2}" width="${w * 0.4}" height="${h}" rx="${w * 0.2}" fill="${i % 3 === 0 ? ink : main}" fill-opacity="${i % 3 === 0 ? 0.7 : 1}"/>`;
    }
  } else {
    // мягкие перекрывающиеся формы
    art = `<circle cx="${100 + rnd() * 80}" cy="${140 + rnd() * 80}" r="${120 + rnd() * 40}" fill="${main}"/>`
      + `<circle cx="${230 + rnd() * 80}" cy="${180 + rnd() * 80}" r="${90 + rnd() * 40}" fill="${ink}" fill-opacity=".85"/>`
      + `<circle cx="${180 + rnd() * 60}" cy="${120 + rnd() * 60}" r="${18 + rnd() * 12}" fill="${bg}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="${bg}"/>${art}</svg>`;
}
