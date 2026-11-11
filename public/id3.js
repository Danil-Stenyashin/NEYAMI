// Чтение тегов mp3 (ID3v2.2–2.4): название, артист, альбом, жанр и обложка. Без библиотек.
// Работает и в браузере, и в Node (на вход — ArrayBuffer или Uint8Array начала файла).

const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska',
  'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion',
  'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alternative Rock',
  'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
  'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult',
  'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle'];

const FRAMES = {
  TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album', TCON: 'genre', TCO: 'genre',
};

function decodeText(bytes, enc) {
  const strip = (s) => s.replace(/\u0000+$/g, '').split('\u0000')[0].trim();
  try {
    if (enc === 0) return strip(new TextDecoder('latin1').decode(bytes));
    if (enc === 1) return strip(new TextDecoder('utf-16').decode(bytes)); // с BOM
    if (enc === 2) return strip(new TextDecoder('utf-16be').decode(bytes));
    return strip(new TextDecoder('utf-8').decode(bytes));
  } catch { return ''; }
}

// конец строки с учётом кодировки (в UTF-16 — два нулевых байта)
function terminator(bytes, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    return bytes.length;
  }
  const i = bytes.indexOf(0, start);
  return i < 0 ? bytes.length : i;
}

const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

function genreName(raw) {
  const m = /^\((\d+)\)(.*)$/.exec(raw);
  if (m) return m[2] || GENRES[Number(m[1])] || '';
  if (/^\d+$/.test(raw)) return GENRES[Number(raw)] || '';
  return raw;
}

export function readId3(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const out = {};
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return out; // "ID3"
  const ver = b[3];
  if (ver < 2 || ver > 4) return out;
  const size = Math.min(b.length, 10 + syncsafe(b, 6));
  let pos = 10;
  if (b[5] & 0x40 && ver >= 3) pos += ver === 4 ? syncsafe(b, 10) : ((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]) + 4;
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  while (pos + hdrLen <= size) {
    const id = String.fromCharCode(...b.subarray(pos, pos + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break; // началось заполнение нулями
    let len;
    if (ver === 2) len = (b[pos + 3] << 16) | (b[pos + 4] << 8) | b[pos + 5];
    else if (ver === 4) len = syncsafe(b, pos + 4);
    else len = ((b[pos + 4] << 24) | (b[pos + 5] << 16) | (b[pos + 6] << 8) | b[pos + 7]) >>> 0;
    const start = pos + hdrLen;
    const end = Math.min(start + len, size);
    if (len <= 0 || start >= size) break;
    const frame = b.subarray(start, end);
    const key = FRAMES[id];
    if (key && frame.length > 1) {
      const val = decodeText(frame.subarray(1), frame[0]);
      if (val) out[key] = key === 'genre' ? genreName(val) : val;
    } else if ((id === 'APIC' || id === 'PIC') && !out.picture && frame.length > 4) {
      const enc = frame[0];
      let p = 1;
      let mime;
      if (id === 'PIC') {
        const fmt = String.fromCharCode(...frame.subarray(1, 4)).toLowerCase();
        mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
        p = 4;
      } else {
        const z = frame.indexOf(0, 1);
        mime = new TextDecoder('latin1').decode(frame.subarray(1, z)).toLowerCase() || 'image/jpeg';
        if (!mime.includes('/')) mime = `image/${mime === 'jpg' ? 'jpeg' : mime}`;
        p = z + 1;
      }
      p += 1; // тип картинки (обложка, задник…)
      const descEnd = terminator(frame, p, enc);
      p = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
      if (p < frame.length) out.picture = { mime, data: frame.slice(p) };
    }
    pos = end;
  }
  return out;
}

/** Если тегов нет — пробуем «Артист - Название.mp3». */
export function guessFromFilename(name) {
  const base = String(name).replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '').replace(/_/g, ' ').trim();
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(base);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { title: base };
}
