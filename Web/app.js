'use strict';

// Web remote: runs in a browser on the Mac and talks to the iPhone app over HTTP.

const $ = (id) => document.getElementById(id);
const preview = $('preview');

let state = null;
let online = false;
let lastPhotoCount = -1;
let lastCaptureError = null;
const touched = {}; // control id → time of the user's last change

// ---------- Utilities ----------

const LOG_STEPS = 1000;
const toLog = (v, min, max) => min * Math.pow(max / min, v / LOG_STEPS);
const fromLog = (x, min, max) => (LOG_STEPS * Math.log(x / min)) / Math.log(max / min);

function fmtShutter(s) {
  if (!s) return '—';
  if (s >= 0.95) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `1/${Math.round(1 / s)}`;
}

function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function isTouched(id) {
  return Date.now() - (touched[id] || 0) < 1500;
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Settings changes are batched and sent at most every 80 ms (while dragging sliders).
let pending = null;
let flushTimer = null;
function setCamera(patch) {
  pending = { ...(pending || {}), ...patch };
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    const body = pending;
    pending = null;
    flushTimer = null;
    try {
      await api('/api/settings', body);
    } catch (e) {
      toast(`Error: ${e.message}`);
    }
  }, 80);
}

// ---------- State polling ----------

async function poll() {
  try {
    state = await api('/api/state');
    setOnline(true);
    render();
  } catch {
    setOnline(false);
  }
  setTimeout(poll, 500);
}

function setOnline(value) {
  if (value === online) return;
  online = value;
  $('conn').textContent = value ? 'iPhone connected' : 'iPhone not reachable';
  $('conn').classList.toggle('ok', value);
  $('shootBtn').disabled = !value;
  if (value) startStream();
}

function startStream() {
  preview.src = `/stream?t=${Date.now()}`;
}
preview.addEventListener('load', () => ($('placeholder').hidden = true));
preview.addEventListener('error', () => {
  $('placeholder').hidden = false;
  setTimeout(() => online && startStream(), 2000);
});

// ---------- Rendering state ----------

function render() {
  const s = state;
  if (s.error) $('placeholder').textContent = s.error;

  renderLenses(s);

  const zoom = $('zoom');
  if (!isTouched('zoom') && s.maxZoom > s.minZoom) zoom.value = fromLog(s.zoom, s.minZoom, s.maxZoom);
  $('zoomOut').textContent = `${s.zoom.toFixed(1)}×`;

  // Exposure
  if (!isTouched('expMode')) {
    setSegment('expMode', s.exposureMode);
    document.body.dataset.exp = s.exposureMode;
  }
  if (!isTouched('iso')) $('iso').value = fromLog(s.iso, s.minISO, s.maxISO);
  if (!isTouched('shutter')) $('shutter').value = fromLog(s.shutter, s.minShutter, s.maxShutter);
  if (!isTouched('iso')) $('isoOut').textContent = Math.round(s.iso);
  if (!isTouched('shutter')) $('shutterOut').textContent = fmtShutter(s.shutter);
  renderChips('isoChips', [25, 32, 50, 64, 100, 200, 400, 800, 1600, 3200, 6400], s.minISO, s.maxISO,
    (v) => String(v), (v) => setManual('iso', v));
  renderChips('shutterChips', [1 / 8000, 1 / 4000, 1 / 2000, 1 / 1000, 1 / 500, 1 / 250, 1 / 125, 1 / 60, 1 / 30, 1 / 15, 1 / 4, 1],
    s.minShutter, s.maxShutter, fmtShutter, (v) => setManual('shutter', v));
  $('bias').min = s.minBias;
  $('bias').max = s.maxBias;
  if (!isTouched('bias')) $('bias').value = s.bias;
  $('biasOut').textContent = `${s.bias > 0 ? '+' : ''}${s.bias.toFixed(1)} EV`;
  const offset = Math.max(-3, Math.min(3, s.exposureOffset));
  $('meterNeedle').style.left = `${((offset + 3) / 6) * 100}%`;
  $('meterOut').textContent = `${s.exposureOffset > 0 ? '+' : ''}${s.exposureOffset.toFixed(1)}`;

  // Focus
  setSegment('focusMode', s.focusMode);
  $('focusMode').querySelector('[data-v=manual]').disabled = !s.manualFocusSupported;
  if (!isTouched('focus')) $('focus').value = s.lensPosition;
  $('focusOut').textContent = s.lensPosition.toFixed(3);
  if (!isTouched('loupe')) {
    loupe = s.loupe;
    setSegment('loupe', String(s.loupe));
  }
  $('loupeBadge').hidden = s.loupe <= 1;
  $('loupeBadge').textContent = `Loupe ${s.loupe}×`;

  // White balance
  setSegment('wbMode', s.wbMode);
  $('wbMode').querySelector('[data-v=manual]').disabled = !s.manualWBSupported;
  if (!isTouched('temp')) $('temp').value = s.temperature;
  if (!isTouched('tint')) $('tint').value = s.tint;
  $('tempOut').textContent = `${Math.round(s.temperature)} K`;
  $('tintOut').textContent = Math.round(s.tint);

  renderFormats(s.formats);
  // Bayer RAW is always captured at the sensor's standard size, and on 12 MP cameras
  // (most iPhones before the 14 Pro) there is nothing to choose.
  const [w, h] = (s.resolution || '').split('×').map(Number);
  const highRes = w * h > 13_000_000;
  $('resolutionField').hidden = $('format').value === 'raw' || !highRes;
  if (s.resolution) $('resolution').options[0].textContent = `Maximum (${s.resolution})`;
  renderCapture(s.capture);

  const lens = s.lenses.find((l) => l.id === s.lens);
  $('readout').textContent = [
    lens ? `${lens.name} ${lens.factor}×` : '',
    `ISO ${Math.round(s.iso)}`,
    fmtShutter(s.shutter),
    `focus ${s.lensPosition.toFixed(3)}`,
    `${Math.round(s.temperature)} K`,
  ].filter(Boolean).join(' · ');

  const battery = s.battery < 0 ? '' : `🔋 ${Math.round(s.battery * 100)}%${s.charging ? ' ⚡' : ''}`;
  const thermal = { nominal: '', fair: '🌡 warm', serious: '🌡 overheating!', critical: '🌡 critical overheating!' }[s.thermal];
  $('device').textContent = [battery, thermal, s.resolution && `max ${s.resolution}`].filter(Boolean).join(' · ');

  if (s.photoCount !== lastPhotoCount) {
    lastPhotoCount = s.photoCount;
    loadGallery();
  }
}

function renderLenses(s) {
  const box = $('lenses');
  const key = s.lenses.map((l) => l.id).join();
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = '';
    for (const lens of [...s.lenses].sort((a, b) => a.factor - b.factor)) {
      const b = document.createElement('button');
      b.dataset.v = lens.id;
      b.textContent = `${lens.factor}×`;
      b.title = lens.name;
      b.onclick = () => setCamera({ lens: lens.id });
      box.appendChild(b);
    }
  }
  setSegment('lenses', s.lens);
}

function setSegment(id, value) {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === value);
}

function renderChips(id, values, min, max, label, onPick) {
  const box = $(id);
  const key = `${min}-${max}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  for (const v of values.filter((x) => x >= min * 0.999 && x <= max * 1.001)) {
    const b = document.createElement('button');
    b.textContent = label(v);
    b.onclick = () => onPick(v);
    box.appendChild(b);
  }
}

const FORMAT_NAMES = { heif: 'HEIF', jpeg: 'JPEG', raw: 'RAW (DNG)', proraw: 'Apple ProRAW (DNG)' };
function renderFormats(formats) {
  const select = $('format');
  const key = formats.join();
  if (select.dataset.key === key) return;
  select.dataset.key = key;
  const current = select.value || localStorage.getItem('format') || 'raw';
  select.innerHTML = formats.map((f) => `<option value="${f}">${FORMAT_NAMES[f] || f}</option>`).join('');
  select.value = formats.includes(current) ? current : formats[0];
}

function renderCapture(c) {
  $('cancelBtn').hidden = !c.busy;
  $('shootBtn').classList.toggle('busy', c.busy);
  const badge = $('seriesBadge');
  badge.hidden = !c.busy;
  badge.textContent = c.total > 1 ? `● Series ${c.done}/${c.total}` : '● Capturing';
  $('countdown').textContent = c.countdown || '';
  $('countdown').hidden = !c.countdown;
  if (c.lastError && c.lastError !== lastCaptureError) toast(c.lastError);
  lastCaptureError = c.lastError;
}

// ---------- Controls ----------

function bindSlider(id, handler) {
  $(id).addEventListener('input', () => {
    touched[id] = Date.now();
    handler(Number($(id).value));
  });
}

function setManual(key, value) {
  touched[key] = Date.now();
  touched.expMode = Date.now();
  setSegment('expMode', 'manual');
  document.body.dataset.exp = 'manual';
  if (key === 'iso') {
    $('iso').value = fromLog(value, state.minISO, state.maxISO);
    $('isoOut').textContent = Math.round(value);
  } else {
    $('shutter').value = fromLog(value, state.minShutter, state.maxShutter);
    $('shutterOut').textContent = fmtShutter(value);
  }
  setCamera({ [key]: value });
}

bindSlider('zoom', (v) => {
  const z = toLog(v, state.minZoom, state.maxZoom);
  $('zoomOut').textContent = `${z.toFixed(1)}×`;
  setCamera({ zoom: z });
});
bindSlider('iso', (v) => setManual('iso', toLog(v, state.minISO, state.maxISO)));
bindSlider('shutter', (v) => setManual('shutter', toLog(v, state.minShutter, state.maxShutter)));
bindSlider('bias', (v) => setCamera({ bias: v }));
bindSlider('focus', (v) => {
  $('focusOut').textContent = v.toFixed(3);
  setCamera({ lensPosition: v });
});
bindSlider('temp', (v) => {
  $('tempOut').textContent = `${v} K`;
  setCamera({ temperature: v, tint: Number($('tint').value) });
});
bindSlider('tint', (v) => {
  $('tintOut').textContent = v;
  setCamera({ temperature: Number($('temp').value), tint: v });
});

for (const [id, key] of [['expMode', 'exposureMode'], ['focusMode', 'focusMode'], ['wbMode', 'wbMode']]) {
  $(id).addEventListener('click', (e) => {
    const v = e.target.dataset?.v;
    if (!v) return;
    setSegment(id, v);
    if (id === 'expMode') document.body.dataset.exp = v;
    setCamera({ [key]: v });
  });
}

let loupe = 1;
function setLoupe(v) {
  loupe = v;
  touched.loupe = Date.now();
  setSegment('loupe', String(v));
  setCamera({ loupe: v });
}
$('loupe').addEventListener('click', (e) => e.target.dataset?.v && setLoupe(Number(e.target.dataset.v)));

function nudgeFocus(delta) {
  if (!state) return;
  touched.focus = Date.now();
  const v = Math.max(0, Math.min(1, Number($('focus').value) + delta));
  $('focus').value = v;
  $('focusOut').textContent = v.toFixed(3);
  setCamera({ lensPosition: v });
}
$('focusNudgeDown').onclick = () => nudgeFocus(-0.005);
$('focusNudgeUp').onclick = () => nudgeFocus(0.005);
$('focusInf').onclick = () => nudgeFocus(1);

// Click on the preview sets the focus/metering point (accounting for the loupe).
preview.addEventListener('click', (e) => {
  if (!state) return;
  const r = preview.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const l = loupe;
  setCamera({ point: { x: 0.5 + (x - 0.5) / l, y: 0.5 + (y - 0.5) / l } });
  const mark = document.createElement('div');
  mark.className = 'focus-mark';
  mark.style.left = `${x * 100}%`;
  mark.style.top = `${y * 100}%`;
  $('frame').appendChild(mark);
  setTimeout(() => mark.remove(), 1200);
});

async function shoot() {
  if (!online || state?.capture.busy) return;
  const format = $('format').value;
  const resolution = $('resolution').value;
  try {
    localStorage.setItem('format', format);
    localStorage.setItem('resolution', resolution);
  } catch {}
  try {
    await api('/api/capture', {
      format,
      count: Math.max(1, Number($('count').value) || 1),
      interval: Math.max(0, Number($('interval').value) || 0),
      delay: Number($('delay').value),
      saveToPhotos: $('saveToPhotos').checked,
      resolution,
    });
    $('frame').classList.add('flash');
    setTimeout(() => $('frame').classList.remove('flash'), 150);
  } catch (e) {
    toast(e.message);
  }
}
$('shootBtn').onclick = shoot;
$('cancelBtn').onclick = () => api('/api/cancel', {}).catch(() => {});

// Moon preset: longest lens, low ISO, short shutter.
// The Moon is lit by the Sun, so it needs a "daylight" exposure (Looney 11 rule).
$('moonPreset').onclick = () => {
  if (!state) return;
  const tele = [...state.lenses].sort((a, b) => b.factor - a.factor)[0];
  setCamera({
    lens: tele?.id,
    exposureMode: 'manual',
    iso: Math.max(state.minISO, 50),
    shutter: 1 / 250,
    wbMode: 'manual',
    temperature: 4800,
    tint: 0,
  });
  if (state.formats.includes('raw')) $('format').value = 'raw';
  $('delay').value = '2';
  toast('Aim at the Moon, turn on the 4× loupe and fine-tune focus and shutter using the histogram');
};

$('grid').onchange = () => $('gridOverlay').classList.toggle('show', $('grid').checked);
$('night').onchange = () => document.body.classList.toggle('night', $('night').checked);

// ---------- Histogram ----------

const histCanvas = $('histogram');
const histCtx = histCanvas.getContext('2d');
const sample = document.createElement('canvas');
sample.width = 160;
sample.height = 120;
const sampleCtx = sample.getContext('2d', { willReadFrequently: true });

function drawHistogram() {
  if (!preview.naturalWidth || histCanvas.hidden) return;
  try {
    sampleCtx.drawImage(preview, 0, 0, sample.width, sample.height);
  } catch {
    return;
  }
  const px = sampleCtx.getImageData(0, 0, sample.width, sample.height).data;
  const bins = new Array(64).fill(0);
  let clipped = 0;
  for (let i = 0; i < px.length; i += 4) {
    const luma = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    bins[Math.min(63, luma >> 2)]++;
    if (px[i] >= 250 || px[i + 1] >= 250 || px[i + 2] >= 250) clipped++;
  }
  // The first bin (black sky) is huge — scale by the rest, otherwise the graph is flat.
  const peak = Math.max(...bins.slice(1), 1);
  const w = histCanvas.width;
  const h = histCanvas.height;
  histCtx.clearRect(0, 0, w, h);
  histCtx.fillStyle = 'rgba(255,255,255,.75)';
  bins.forEach((v, i) => {
    const bh = Math.min(h, (v / peak) * h);
    histCtx.fillRect(i * (w / 64), h - bh, w / 64 - 1, bh);
  });
  const pct = (clipped / (px.length / 4)) * 100;
  histCtx.fillStyle = pct > 0.05 ? '#ff453a' : 'rgba(255,255,255,.5)';
  histCtx.font = '11px -apple-system, sans-serif';
  histCtx.fillText(pct > 0.05 ? `clipped ${pct.toFixed(2)}%` : 'no clipping', 6, 13);
}
setInterval(drawHistogram, 250);

// ---------- Gallery ----------

let photos = [];
async function loadGallery() {
  try {
    photos = await api('/api/photos');
  } catch {
    return;
  }
  $('photoCount').textContent = photos.length ? `(${photos.length})` : '';
  const box = $('gallery');
  box.innerHTML = '';
  photos.slice(0, 200).forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'photo';
    const ext = p.name.split('.').pop().toLowerCase();
    const thumb = ext === 'dng' || i >= 12
      ? `<span class="thumb tag">${ext.toUpperCase()}</span>`
      : `<img class="thumb" loading="lazy" src="/photos/${encodeURIComponent(p.name)}" alt="">`;
    row.innerHTML = `${thumb}
      <a class="name" href="/photos/${encodeURIComponent(p.name)}" target="_blank">${p.name}</a>
      <span class="muted">${fmtBytes(p.size)}</span>
      <a class="icon" title="Download" href="/photos/${encodeURIComponent(p.name)}?download=1" download="${p.name}">⬇︎</a>
      <button class="icon" title="Delete from iPhone">✕</button>`;
    row.querySelector('button').onclick = async () => {
      if (!confirm(`Delete ${p.name} from the iPhone?`)) return;
      await api('/api/photos/delete', { name: p.name }).catch((e) => toast(e.message));
      loadGallery();
    };
    box.appendChild(row);
  });
}

$('downloadAll').onclick = async () => {
  for (const p of photos) {
    const a = document.createElement('a');
    a.href = `/photos/${encodeURIComponent(p.name)}?download=1`;
    a.download = p.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 400));
  }
};

// ---------- Keyboard ----------

// Blur the field after a value is picked so keyboard shortcuts work again.
for (const el of document.querySelectorAll('select, input[type=number]')) {
  el.addEventListener('change', () => el.blur());
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=number], select') || e.metaKey || e.ctrlKey || e.altKey) return;
  const step = e.shiftKey ? 0.01 : 0.002;
  switch (e.code) {
    case 'Space': e.preventDefault(); shoot(); break;
    case 'Escape': api('/api/cancel', {}).catch(() => {}); break;
    case 'KeyL': {
      const order = [1, 2, 4, 8];
      setLoupe(order[(order.indexOf(loupe) + 1) % order.length]);
      break;
    }
    case 'KeyG': $('grid').click(); break;
    case 'KeyN': $('night').click(); break;
    case 'KeyH': histCanvas.hidden = !histCanvas.hidden; break;
    case 'BracketLeft': nudgeFocus(-step); break;
    case 'BracketRight': nudgeFocus(step); break;
  }
});

try {
  const saved = localStorage.getItem('resolution');
  if (saved) $('resolution').value = saved;
} catch {}

poll();
