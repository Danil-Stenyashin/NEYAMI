// Точка запуска NEYAMI: `npm start`, а на Windows — двойной щелчок по NEYAMI.cmd.
//   --open   открыть NEYAMI в окне приложения (на Windows — Edge в режиме приложения)
//   PORT, DATA_DIR — порт и папка с данными
import os from 'node:os';
import { spawn } from 'node:child_process';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Для NEYAMI нужен Node.js 22.13 или новее (сейчас ${process.versions.node}). Скачайте LTS: https://nodejs.org`);
  process.exit(1);
}
const { createApp } = await import('./server.js'); // после проверки: node:sqlite есть не везде

const port = Number(process.env.PORT) || 3000;
const local = `http://localhost:${port}`;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
  }
  return out;
}

function openApp(url) {
  const opts = { detached: true, stdio: 'ignore' };
  try {
    if (process.platform === 'win32') {
      // Edge есть в любой Windows 10/11; --app открывает отдельное окно без адресной строки
      const cmd = process.env.NEYAMI_BROWSER === 'default' ? `start "" "${url}"` : `start "" msedge --app=${url}`;
      spawn('cmd', ['/c', cmd], { ...opts, windowsVerbatimArguments: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], opts).unref();
    } else {
      spawn('xdg-open', [url], opts).on('error', () => {}).unref();
    }
  } catch {
    console.log(`Откройте в браузере: ${url}`);
  }
}

const server = createApp({ dataDir: process.env.DATA_DIR });
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Порт ${port} уже занят — похоже, NEYAMI уже запущен. Открываю его.`);
    if (process.argv.includes('--open')) openApp(`${local}/#/wave`);
    process.exit(0);
  }
  throw err;
});
server.listen(port, () => {
  console.log('\n  NEYAMI запущен 🎧\n');
  console.log(`  На этом компьютере:          ${local}`);
  for (const ip of lanAddresses()) console.log(`  С телефона (та же Wi-Fi сеть): http://${ip}:${port}`);
  console.log('\n  Не закрывайте это окно, пока слушаете музыку. Остановить: Ctrl+C\n');
  if (process.argv.includes('--open')) openApp(`${local}/#/wave`);
});
