// NEYAMI — настольное приложение (Windows, а также macOS и Linux).
// Внутри — тот же сервер NEYAMI, окно приложения и значок в трее. Node.js ставить не нужно.
const { app, BrowserWindow, Tray, Menu, shell, clipboard, nativeImage, nativeTheme, Notification } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'public', 'icons', 'icon-512.png');
const IS_WIN = process.platform === 'win32';

let win = null;
let tray = null;
let server = null;
let port = 3000;
let quitting = false;

if (IS_WIN) app.setAppUserModelId('ru.neyami.app'); // уведомления и группировка на панели задач Windows

// Только один экземпляр: повторный запуск просто показывает окно
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start).catch(fatal);
}

// ---------- настройки самого приложения (не волны) ----------
const prefsFile = () => path.join(app.getPath('userData'), 'desktop.json');
function readPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')); } catch { return {}; }
}
function writePrefs(patch) {
  try { fs.writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...patch })); } catch { /* не критично */ }
}

// ---------- сервер ----------
function portIsFree(p) {
  return new Promise((resolve) => {
    const probe = net.createServer().once('error', () => resolve(false));
    probe.listen(p, () => probe.close(() => resolve(true)));
  });
}
async function findPort() {
  // 3000 — чтобы адрес для iPhone не менялся; если занят (например, запущен NEYAMI.cmd) — соседний
  for (const p of [3000, 3001, 3002, 3003, 3004]) if (await portIsFree(p)) return p;
  return 0;
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
  }
  return null;
}
const phoneUrl = () => {
  const ip = lanAddress();
  return ip ? `http://${ip}:${port}` : null;
};

async function start() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  // При первом запуске — демо-каталог, чтобы было что послушать сразу
  const { seedDemo } = await import(pathToFileURL(path.join(ROOT, 'src', 'demo.js')).href);
  seedDemo({ dataDir });

  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'src', 'server.js')).href);
  port = await findPort();
  server = createApp({ dataDir });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => { port = server.address().port; resolve(); });
  });
  console.log(`NEYAMI: http://localhost:${port}`);

  createTray();
  // При автозапуске вместе с Windows стартуем в трей, без окна
  if (!process.argv.includes('--hidden')) createWindow();
}

function fatal(err) {
  console.error(err);
  const { dialog } = require('electron');
  dialog.showErrorBox('NEYAMI не запустился', String(err?.stack || err));
  app.exit(1);
}

// ---------- окно ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    title: 'NEYAMI',
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // музыка не должна запинаться в свёрнутом окне
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.removeMenu();
  const base = `http://localhost:${port}`;
  win.loadURL(`${base}/#/wave`);
  win.once('ready-to-show', () => win.show());

  // Самопроверка (используется при сборке): снимок окна в файл и выход
  if (process.env.NEYAMI_SMOKE) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const out = process.env.NEYAMI_SMOKE;
      const image = await win.webContents.capturePage();
      fs.writeFileSync(out, image.toPNG());
      // отчёт: интерфейс отрисован, сервер отдаёт каталог, звук декодируется
      const report = await win.webContents.executeJavaScript(`(async () => {
        const tags = await (await fetch('/api/tags')).json();
        const tracks = await (await fetch('/api/tracks?limit=100')).json();
        const a = new Audio('/api/tracks/' + tracks.tracks[0].id + '/stream');
        a.muted = true;
        let audio = 'ok';
        try { await a.play(); await new Promise((r) => setTimeout(r, 1500)); audio = 'играет, t=' + a.currentTime.toFixed(1); a.pause(); }
        catch (e) { audio = 'ошибка: ' + e.message; }
        return { brand: document.querySelector('.brand')?.textContent.trim(), tags: tags.tags.length, tracks: tracks.tracks.length,
                 duration: a.duration, audio };
      })()`).catch((e) => ({ error: String(e) }));
      fs.writeFileSync(`${out}.json`, JSON.stringify({ port, platform: process.platform, electron: process.versions.electron, ...report }, null, 2));
      console.log('NEYAMI smoke:', JSON.stringify(report));
      quitting = true;
      app.quit();
    }, 2500));
  }

  // Внешние ссылки — в обычном браузере, а не внутри приложения
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(base)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(base)) { e.preventDefault(); shell.openExternal(url); }
  });

  // Крестик прячет окно в трей: музыка и доступ с iPhone продолжают работать
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!readPrefs().trayHintShown) {
      writePrefs({ trayHintShown: true });
      notify('NEYAMI работает в фоне', 'Музыка и доступ с iPhone не прерываются. Выйти — правой кнопкой по значку у часов.');
    }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function clickInPage(selector) {
  win?.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click()`).catch(() => {});
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

// ---------- трей ----------
function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: IS_WIN ? 16 : 18, height: IS_WIN ? 16 : 18 });
  tray = new Tray(img);
  tray.setToolTip('NEYAMI');
  tray.on('click', showWindow);
  tray.on('right-click', () => updateTrayMenu()); // адрес в сети мог поменяться
  updateTrayMenu();
}

function updateTrayMenu() {
  const phone = phoneUrl();
  const atLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть NEYAMI', click: showWindow },
    { label: 'Играть / пауза', click: () => clickInPage('#p-toggle') },
    { label: 'Следующий трек', click: () => clickInPage('#p-next') },
    { type: 'separator' },
    phone
      ? {
        label: `Для iPhone: ${phone}  (скопировать)`,
        click: () => {
          clipboard.writeText(phone);
          notify('Адрес скопирован', `Откройте ${phone} в Safari на iPhone в той же Wi-Fi сети.`);
        },
      }
      : { label: 'Нет сети для iPhone', enabled: false },
    {
      label: IS_WIN ? 'Запускать вместе с Windows' : 'Запускать при входе в систему',
      type: 'checkbox',
      checked: atLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
}

app.on('before-quit', () => {
  quitting = true;
  server?.close();
});
app.on('activate', showWindow); // macOS: клик по значку в доке
app.on('window-all-closed', () => { /* остаёмся в трее */ });
