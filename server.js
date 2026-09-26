'use strict';

// HTTPS-сервер + WebSocket-сигналинг для WebRTC.
// iPhone открывает /phone.html (источник видео), Mac — / (пульт управления).

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');
const qrcode = require('qrcode-terminal');

const PORT = Number(process.env.PORT) || 8443;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, '.cert');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function lanAddresses() {
  const result = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) result.push(addr.address);
    }
  }
  return result;
}

// Самоподписанный сертификат кэшируется в .cert/, чтобы iPhone не спрашивал
// подтверждение при каждом запуске. Перевыпускается, если сменился IP.
async function loadOrCreateCert(ips) {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const metaPath = path.join(CERT_DIR, 'meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const fresh = Date.now() < meta.expires - 7 * 24 * 3600 * 1000;
    if (fresh && ips.every((ip) => meta.ips.includes(ip))) {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    }
  } catch {
    // сертификата ещё нет — создадим
  }

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 1);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'remote-camera.local' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 2, value: `${os.hostname()}` },
          { type: 7, ip: '127.0.0.1' },
          ...ips.map((ip) => ({ type: 7, ip })),
        ],
      },
    ],
  });

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(metaPath, JSON.stringify({ ips, expires: notAfterDate.getTime() }));
  return { key: pems.private, cert: pems.cert };
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'https://localhost');
  if (url.pathname === '/info') {
    const host = lanAddresses()[0] || 'localhost';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ phoneUrl: `https://${host}:${PORT}/phone` }));
    return;
  }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/viewer.html';
  if (pathname === '/phone') pathname = '/phone.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// --- Сигналинг: одна «комната», один телефон и один пульт ---------------------

const peers = { phone: null, viewer: null };
const other = (role) => (role === 'phone' ? 'viewer' : 'phone');

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function attachSignaling(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let role = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'hello' && (msg.role === 'phone' || msg.role === 'viewer')) {
        role = msg.role;
        // Новое подключение вытесняет старое (например, после перезагрузки вкладки).
        if (peers[role] && peers[role] !== ws) peers[role].close(4000, 'replaced');
        peers[role] = ws;
        log(`${role} подключился`);
        const peer = peers[other(role)];
        send(ws, { type: 'peer', present: Boolean(peer) });
        send(peer, { type: 'peer', present: true });
        return;
      }

      // Всё остальное (offer / answer / ice) просто пересылаем второй стороне.
      if (role && msg.type === 'signal') send(peers[other(role)], msg);
    });

    ws.on('close', () => {
      if (role && peers[role] === ws) {
        peers[role] = null;
        log(`${role} отключился`);
        send(peers[other(role)], { type: 'peer', present: false });
      }
    });
  });

  // Пинг, чтобы соединения не рвались по таймауту на роутере / при сне экрана.
  setInterval(() => {
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.ping();
  }, 20000).unref();
}

function log(text) {
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}] ${text}`);
}

async function main() {
  const ips = lanAddresses();
  const credentials = await loadOrCreateCert(ips);
  const server = https.createServer(credentials, serveStatic);
  attachSignaling(server);

  server.listen(PORT, () => {
    const host = ips[0] || 'localhost';
    const phoneUrl = `https://${host}:${PORT}/phone`;
    console.log('\n📷  Remote Camera запущен\n');
    console.log(`  Пульт на Mac:   https://localhost:${PORT}/`);
    console.log(`  Камера iPhone:  ${phoneUrl}`);
    if (ips.length > 1) {
      console.log(`  Другие адреса:  ${ips.slice(1).map((ip) => `https://${ip}:${PORT}/phone`).join(', ')}`);
    }
    console.log('\nОтсканируйте QR-код камерой iPhone (телефон и Mac в одной Wi-Fi сети):\n');
    qrcode.generate(phoneUrl, { small: true });
    console.log('Сертификат самоподписанный: в Safari нажмите «Подробнее» → «Перейти на веб-сайт».\n');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
