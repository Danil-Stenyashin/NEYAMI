import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readId3, guessFromFilename } from '../public/id3.js';

const syncsafe = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
function frame23(id, payload) {
  const len = payload.length;
  return Buffer.concat([Buffer.from(id), Buffer.from([len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255, 0, 0]), payload]);
}
function frame24(id, payload) {
  return Buffer.concat([Buffer.from(id), Buffer.from([...syncsafe(payload.length), 0, 0]), payload]);
}
function tag(ver, frames) {
  const body = Buffer.concat([...frames, Buffer.alloc(64)]); // с заполнением нулями
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, ver, 0, 0, ...syncsafe(body.length)]), body, Buffer.from('mp3 audio data')]);
}
const utf8 = (s) => Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]);
const utf16 = (s) => Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(s, 'utf16le')]);

test('ID3v2.4: UTF-8, жанр и обложка', () => {
  const pic = Buffer.concat([Buffer.from([3]), Buffer.from('image/png\0'), Buffer.from([3]), Buffer.from('cover\0'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2])]);
  const t = readId3(tag(4, [frame24('TIT2', utf8('Дождь')), frame24('TPE1', utf8('Луна')), frame24('TCON', utf8('Lo-Fi')), frame24('APIC', pic)]));
  assert.equal(t.title, 'Дождь');
  assert.equal(t.artist, 'Луна');
  assert.equal(t.genre, 'Lo-Fi');
  assert.equal(t.picture.mime, 'image/png');
  assert.deepEqual([...t.picture.data], [0x89, 0x50, 0x4e, 0x47, 1, 2]);
});

test('ID3v2.3: UTF-16 и числовой жанр', () => {
  const t = readId3(tag(3, [frame23('TIT2', utf16('Ночь')), frame23('TCON', Buffer.from('\0(8)'))]));
  assert.equal(t.title, 'Ночь');
  assert.equal(t.genre, 'Jazz');
});

test('нет тегов — пусто; имя файла разбирается', () => {
  assert.deepEqual(readId3(Buffer.from('not an mp3')), {});
  assert.deepEqual(guessFromFilename('03 - Луна - Дождь на стекле.mp3'), { artist: 'Луна', title: 'Дождь на стекле' });
  assert.deepEqual(guessFromFilename('track_01.flac'), { title: 'track 01' });
});
