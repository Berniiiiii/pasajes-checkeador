// Monitors Aerolineas Argentinas flex-dates calendar for COR-FTE price drops (Dec 1-5, 2026).
// Loads the public page in headless Chrome every 5 minutes, reads rendered prices,
// and shows a Windows notification when any day gets cheaper than its lowest seen price.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const puppeteer = require('puppeteer-core');

const IS_WINDOWS = process.platform === 'win32';
const CHROME =
  process.env.CHROME_PATH ||
  (IS_WINDOWS ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome');
const STATE_FILE = path.join(__dirname, 'precios.json');
const LOG_FILE = path.join(__dirname, 'monitor.log');
const INTERVAL_MS = 5 * 60 * 1000;
const DAYS = [1, 2, 3, 4, 5];
const TELEGRAM_FILE = path.join(__dirname, 'telegram.json');

function log(msg) {
  const line = `[${new Date().toLocaleString('es-AR')}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function notify(title, body) {
  pushPhone(title, body);
  if (!IS_WINDOWS) return;
  const esc = (s) => s.replace(/'/g, "''");
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode('${esc(title)}')) | Out-Null
$x.Item(1).AppendChild($t.CreateTextNode('${esc(body)}')) | Out-Null
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($t))
[console]::beep(880,400); [console]::beep(1100,400)
`;
  execFile('powershell.exe', ['-NoProfile', '-Command', ps], (err) => {
    if (err) log(`Error notificando: ${err.message}`);
  });
}

// Sends a Telegram message. Credentials come from TELEGRAM_TOKEN / TELEGRAM_CHAT_ID env vars
// (GitHub Actions secrets) or from telegram.json ({ "token": ..., "chatId": ... }) locally.
function telegramConfig() {
  if (process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return { token: process.env.TELEGRAM_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID };
  }
  if (fs.existsSync(TELEGRAM_FILE)) return JSON.parse(fs.readFileSync(TELEGRAM_FILE, 'utf8'));
  return null;
}

async function pushPhone(title, message) {
  const config = telegramConfig();
  if (!config) return;
  try {
    const { token, chatId } = config;
    const url = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).url;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `✈️ ${title}\n${message}\n\n${url}` }),
    });
    if (!res.ok) log(`Error Telegram: HTTP ${res.status}`);
  } catch (err) {
    log(`Error Telegram: ${err.message}`);
  }
}

const fmt = (n) => n.toLocaleString('es-AR');

// Calendar text looks like: "...\n1\n508419\n\nARS\n\n2\n865237\n\nARS..." (day, price, ARS).
function parsePrices(text) {
  const start = text.indexOf('SÁB');
  const lines = text.slice(start).split('\n').map((l) => l.trim()).filter(Boolean);
  const prices = {};
  for (let i = 0; i < lines.length - 2; i++) {
    const day = Number(lines[i]);
    if (/^\d{1,2}$/.test(lines[i]) && /^\d{4,}$/.test(lines[i + 1]) && lines[i + 2] === 'ARS') {
      if (!(day in prices)) prices[day] = Number(lines[i + 1]);
    }
  }
  return prices;
}

async function fetchPrices(url) {
  const args = ['--lang=es-AR'];
  if (!IS_WINDOWS) args.push('--no-sandbox');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => /\d{4,}\s*ARS/.test(document.body.innerText), { timeout: 45000 });
    return parsePrices(await page.evaluate(() => document.body.innerText));
  } finally {
    await browser.close();
  }
}

// Lowest prices are shared through a pinned message in the Telegram chat, so the local monitor
// and the cloud routine (which has no persistent disk) never alert twice for the same drop.
const PIN_HEADER = '📌 Mínimos COR-FTE (no borrar este mensaje)';

async function tg(method, body) {
  const { token } = telegramConfig();
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

async function loadPinnedMinimos() {
  const { chatId } = telegramConfig();
  const chat = await tg('getChat', { chat_id: chatId });
  const pinned = chat.pinned_message;
  if (!pinned || !pinned.text || !pinned.text.startsWith(PIN_HEADER)) return null;
  return { messageId: pinned.message_id, minimos: JSON.parse(pinned.text.slice(PIN_HEADER.length).trim()) };
}

async function savePinnedMinimos(minimos, messageId) {
  const { chatId } = telegramConfig();
  const text = `${PIN_HEADER}\n${JSON.stringify(minimos)}`;
  if (messageId) {
    await tg('editMessageText', { chat_id: chatId, message_id: messageId, text });
    return;
  }
  const msg = await tg('sendMessage', { chat_id: chatId, text, disable_notification: true });
  await tg('pinChatMessage', { chat_id: chatId, message_id: msg.message_id, disable_notification: true });
}

async function check() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  let pinned = null;
  if (telegramConfig()) {
    try {
      pinned = await loadPinnedMinimos();
      if (pinned) state.minimos = pinned.minimos;
    } catch (err) {
      log(`Error leyendo mínimos de Telegram: ${err.message}`);
    }
  }
  const before = JSON.stringify(state.minimos);
  let prices;
  try {
    prices = await fetchPrices(state.url);
  } catch (err) {
    log(`Error leyendo precios: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const found = DAYS.filter((d) => prices[d]);
  if (found.length === 0) {
    log('No se encontraron precios para 1-5 dic (sin disponibilidad o la página cambió).');
    process.exitCode = 1;
    return;
  }

  const drops = [];
  const snapshot = {};
  for (const d of DAYS) {
    const key = `2026-12-${String(d).padStart(2, '0')}`;
    const price = prices[d];
    snapshot[String(d).padStart(2, '0')] = price ?? null;
    if (!price) continue;
    const min = state.minimos[key];
    if (min === undefined || price < min) {
      if (min !== undefined) drops.push(`${d}/12: ARS ${fmt(price)} (antes ${fmt(min)})`);
      state.minimos[key] = price;
    }
  }

  // --no-save keeps the cloud checkout clean; there the pinned Telegram message is the only state.
  if (!process.argv.includes('--no-save')) {
    state.historial.push({ hora: new Date().toLocaleString('es-AR'), precios: snapshot });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
  if (telegramConfig() && (!pinned || JSON.stringify(state.minimos) !== before)) {
    try {
      await savePinnedMinimos(state.minimos, pinned?.messageId);
    } catch (err) {
      log(`Error guardando mínimos en Telegram: ${err.message}`);
    }
  }

  const summary = DAYS.map((d) => `${d}/12 ${prices[d] ? fmt(prices[d]) : '-'}`).join(' | ');
  const source = pinned ? 'telegram' : telegramConfig() ? 'archivo (telegram falló)' : 'archivo (sin telegram)';
  log(`${summary} [mínimos: ${source}]` + (drops.length ? `  >>> BAJÓ: ${drops.join('; ')}` : ''));
  if (drops.length) notify('BAJÓ precio COR-FTE', drops.join(' · '));
}

if (process.argv.includes('--test-notify')) {
  notify('Prueba monitor COR-FTE', 'Si ves esto, las notificaciones funcionan');
  return;
}

const once = process.argv.includes('--once');
check().finally(() => {
  if (!once) setInterval(check, INTERVAL_MS);
});
