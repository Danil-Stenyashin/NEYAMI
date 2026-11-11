// Демо-каталог для разработки: npm run seed   (данные — в ./data или в $DATA_DIR)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemo } from '../src/demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = seedDemo({ dataDir: process.env.DATA_DIR ?? path.join(ROOT, 'data') });
if (result.skipped) {
  console.log('В базе уже есть треки — сид пропущен. Удалите папку data/, чтобы пересоздать.');
} else {
  console.log(`Готово: ${result.artists} артистов, ${result.tracks} треков, ${result.listeners} слушателей.`);
  console.log('Войти можно как demo / demo1234 (чистый вкус) или night_owl / demo1234 (с историей).');
}
