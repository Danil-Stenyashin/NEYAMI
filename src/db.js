import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash   TEXT NOT NULL,
  bio         TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

-- tags хранятся как ",tag1,tag2," — так их удобно искать через LIKE '%,tag,%'
CREATE TABLE IF NOT EXISTS tracks (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT ',',
  explicit    INTEGER NOT NULL DEFAULT 0,
  file        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  duration    REAL,
  energy_peak REAL,             -- секунда энергетического пика (анализ звука при загрузке)
  features    TEXT,             -- JSON: bpm, energy, brightness, dynamics, percussive
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tracks_user ON tracks(user_id);
CREATE INDEX IF NOT EXISTS tracks_created ON tracks(created_at);

-- Неявные сигналы: play / complete / skip (с позицией, на которой пропустили)
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  position    REAL,
  duration    REAL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_user ON events(user_id, created_at);
CREATE INDEX IF NOT EXISTS events_track ON events(track_id);

-- Явные сигналы: 1 = лайк, -1 = «не то»
CREATE TABLE IF NOT EXISTS reactions (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  value       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS reactions_track ON reactions(track_id);

CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, artist_id)
);

-- Жалобы только на незаконный контент / нарушение прав, не на «неудобное мнение»
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wave_settings (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  discovery     REAL NOT NULL DEFAULT 0.5,
  underground   REAL NOT NULL DEFAULT 0.5,
  hide_explicit INTEGER NOT NULL DEFAULT 0,
  private_mode  INTEGER NOT NULL DEFAULT 0,  -- «не запоминать»: прослушивания не влияют на вкус
  context       INTEGER NOT NULL DEFAULT 1   -- учитывать время суток и выходные
);

-- Тепловая карта прослушиваний: трек делится на 100 бинов.
-- heard — сколько раз бин реально прозвучал, seeks — сколько раз туда перемотали.
CREATE TABLE IF NOT EXISTS track_heat (
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  bin         INTEGER NOT NULL,
  heard       INTEGER NOT NULL DEFAULT 0,
  seeks       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (track_id, bin)
);

-- Ручные правки вкуса: forget / boost / block
CREATE TABLE IF NOT EXISTS taste_tags (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  action      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, tag)
);
`;

// Колонки, добавленные после первой версии: досоздаём их в уже существующих базах
const MIGRATIONS = [
  ['tracks', 'features', 'TEXT'],
  ['wave_settings', 'context', 'INTEGER NOT NULL DEFAULT 1'],
];

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  for (const [table, column, type] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  return db;
}

export function parseTags(input) {
  if (Array.isArray(input)) input = input.join(',');
  const seen = new Set();
  for (const raw of String(input ?? '').split(/[,#\s]+/)) {
    const tag = raw.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 32);
    if (tag) seen.add(tag);
    if (seen.size >= 10) break;
  }
  return [...seen];
}

export const encodeTags = (tags) => `,${tags.join(',')},`;
export const decodeTags = (s) => String(s ?? '').split(',').filter(Boolean);
