'use strict';

// Mock of the iPhone app's HTTP API (RemoteCamera/WebAPI.swift) for testing the web remote
// without a phone. Serves the real Web/ folder plus an MJPEG stream of a synthetic Moon.
//
//   node tests/web/mock-server.js          → http://localhost:8090
//
// Test-only endpoints:
//   GET  /__log      every settings/capture request received so far
//   POST /__reset    back to the initial state (optionally merged with a JSON body)
//   POST /__state    merge a JSON body into the current camera state
//   POST /__offline  {"offline": true} makes /api/* fail like an unreachable phone

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8090;
const ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(ROOT, 'Web');
const FRAMES = [0, 1, 2, 3].map((i) => fs.readFileSync(path.join(__dirname, 'fixtures', `moon-${i}.jpg`)));

const EXT = { heif: 'heic', jpeg: 'jpg', raw: 'dng', proraw: 'dng' };

function initialState() {
  return {
    running: true,
    lenses: [
      { id: 'tele', name: 'Telephoto', factor: 5 },
      { id: 'wide', name: 'Wide', factor: 1 },
      { id: 'ultra', name: 'Ultra Wide', factor: 0.5 },
    ],
    lens: 'wide',
    resolution: '8064×6048',
    zoom: 1, minZoom: 1, maxZoom: 20,
    exposureMode: 'auto',
    iso: 320, minISO: 32, maxISO: 3072,
    shutter: 1 / 60, minShutter: 1 / 40000, maxShutter: 1,
    bias: 0, minBias: -8, maxBias: 8,
    exposureOffset: 0.3,
    focusMode: 'auto', lensPosition: 0.6, manualFocusSupported: true,
    wbMode: 'auto', temperature: 5200, tint: 3, manualWBSupported: true,
    loupe: 1,
    formats: ['heif', 'jpeg', 'raw', 'proraw'],
    capture: { busy: false, total: 0, done: 0, countdown: 0 },
    photoCount: 0,
    battery: 0.83, charging: false, thermal: 'nominal',
  };
}

let state;
let photos;
let log;
let offline;
let series;

function reset(overrides = {}) {
  series?.cancel();
  state = { ...initialState(), ...overrides };
  photos = [];
  log = [];
  offline = false;
  series = null;
}
reset();

// Same semantics as CameraController.apply(_:)
function applySettings(u) {
  if (u.lens && state.lenses.some((l) => l.id === u.lens)) { state.lens = u.lens; state.zoom = 1; }
  if (u.zoom != null) state.zoom = clamp(u.zoom, state.minZoom, state.maxZoom);
  if (u.exposureMode) state.exposureMode = u.exposureMode;
  if (u.iso != null) { state.iso = clamp(u.iso, state.minISO, state.maxISO); state.exposureMode = 'manual'; }
  if (u.shutter != null) { state.shutter = clamp(u.shutter, state.minShutter, state.maxShutter); state.exposureMode = 'manual'; }
  if (u.bias != null) state.bias = clamp(u.bias, state.minBias, state.maxBias);
  if (u.focusMode) state.focusMode = u.focusMode;
  if (u.lensPosition != null) { state.lensPosition = clamp(u.lensPosition, 0, 1); state.focusMode = 'manual'; }
  if (u.wbMode) state.wbMode = u.wbMode;
  if (u.temperature != null) { state.temperature = u.temperature; state.wbMode = 'manual'; }
  if (u.tint != null) { state.tint = u.tint; state.wbMode = 'manual'; }
  if (u.loupe != null) state.loupe = clamp(u.loupe, 1, 16);
}

function startSeries(r) {
  const req = { format: 'heif', count: 1, interval: 0, delay: 0, saveToPhotos: false, resolution: 'max', ...r };
  state.capture = { busy: true, total: req.count, done: 0, countdown: Math.ceil(req.delay) };
  let cancelled = false;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
  const finish = () => { state.capture.busy = false; state.capture.countdown = 0; };
  const shoot = () => {
    if (cancelled) return;
    const ext = EXT[req.format] || 'heic';
    photos.unshift({ name: `IMG_${Date.now()}_${state.capture.done}.${ext}`, size: ext === 'dng' ? 25e6 : 4e6, date: Date.now() / 1000 });
    state.photoCount = photos.length;
    state.capture.done += 1;
    if (state.capture.done < req.count) later(shoot, Math.max(100, req.interval * 1000));
    else finish();
  };
  const countdown = () => {
    if (cancelled) return;
    if (state.capture.countdown > 0) { state.capture.countdown -= 1; later(countdown, 1000); return; }
    shoot();
  };
  later(countdown, state.capture.countdown ? 1000 : 50);
  series = { cancel: () => { cancelled = true; timers.forEach(clearTimeout); finish(); } };
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function parse(body) {
  try { return JSON.parse(body || '{}'); } catch { return null; }
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // --- test control ---
    if (p === '/__log') return json(res, log);
    if (p === '/__reset') { reset(parse(body) || {}); return json(res, { ok: true }); }
    if (p === '/__state') { Object.assign(state, parse(body) || {}); return json(res, { ok: true }); }
    if (p === '/__offline') { offline = Boolean((parse(body) || {}).offline); return json(res, { ok: true }); }

    if (STATIC[p]) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(WEB, file)));
    }

    if (offline && (p.startsWith('/api/') || p === '/stream')) {
      req.socket.destroy();
      return;
    }

    if (p === '/stream') {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store' });
      let i = 0;
      const timer = setInterval(() => {
        const f = FRAMES[i++ % FRAMES.length];
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`);
        res.write(f);
        res.write('\r\n');
      }, 100);
      res.on('close', () => clearInterval(timer));
      return;
    }

    if (p === '/api/state' && req.method === 'GET') return json(res, state);

    if (p === '/api/settings' && req.method === 'POST') {
      const u = parse(body);
      if (!u) return json(res, { error: 'Invalid JSON' }, 400);
      log.push({ settings: u });
      applySettings(u);
      return json(res, { ok: true });
    }

    if (p === '/api/capture' && req.method === 'POST') {
      if (state.capture.busy) return json(res, { error: 'A capture is already in progress' }, 409);
      const r = parse(body) || {};
      log.push({ capture: r });
      startSeries(r);
      return json(res, { ok: true });
    }

    if (p === '/api/cancel' && req.method === 'POST') {
      log.push({ cancel: true });
      series?.cancel();
      return json(res, { ok: true });
    }

    if (p === '/api/photos' && req.method === 'GET') return json(res, photos);

    if (p === '/api/photos/delete' && req.method === 'POST') {
      const name = (parse(body) || {}).name;
      const i = photos.findIndex((x) => x.name === name);
      if (i < 0) return json(res, { error: 'File not found' }, 404);
      photos.splice(i, 1);
      state.photoCount = photos.length;
      log.push({ delete: name });
      return json(res, { ok: true });
    }

    if (p.startsWith('/photos/')) {
      const name = decodeURIComponent(p.slice('/photos/'.length));
      if (!photos.some((x) => x.name === name)) return json(res, { error: 'File not found' }, 404);
      const headers = { 'Content-Type': 'image/jpeg' };
      if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="${name}"`;
      res.writeHead(200, headers);
      return res.end(FRAMES[0]);
    }

    json(res, { error: 'Not found' }, 404);
  });
});

server.listen(PORT, () => console.log(`Mock iPhone API on http://localhost:${PORT}`));
