'use strict';

// Пульт на Mac: показывает видео с iPhone и отправляет команды по DataChannel.

const $ = (id) => document.getElementById(id);
const video = $('remote');
const ui = {
  placeholder: $('placeholder'),
  connState: $('connState'),
  videoInfo: $('videoInfo'),
  recTimer: $('recTimer'),
  photoBtn: $('photoBtn'),
  recordBtn: $('recordBtn'),
  switchBtn: $('switchBtn'),
  zoomSection: $('zoomSection'),
  zoom: $('zoom'),
  zoomValue: $('zoomValue'),
  torchSection: $('torchSection'),
  torch: $('torch'),
  resolution: $('resolution'),
  timer: $('timer'),
  grid: $('grid'),
  gridOverlay: $('gridOverlay'),
  mirror: $('mirror'),
  autosave: $('autosave'),
  countdown: $('countdown'),
  transfer: $('transfer'),
  transferName: $('transferName'),
  transferProgress: $('transferProgress'),
  gallery: $('gallery'),
  toast: $('toast'),
};

let pc = null;
let dc = null;
let phoneState = null;
let incoming = null; // { id, name, mime, size, received, chunks }
let recTimerId = null;
let countdownId = null;

fetch('/info')
  .then((r) => r.json())
  .then((info) => ($('phoneUrl').textContent = info.phoneUrl))
  .catch(() => {});

const signaling = new Signaling('viewer', {
  onState: (ok) => !ok && setConn('нет связи с сервером', false),
  onPeer: (present) => {
    if (!present) {
      closePeer();
      setConn('iPhone не подключён', false);
    } else if (!pc) {
      setConn('iPhone найден, соединение…', false);
    }
  },
  onSignal: async (msg) => {
    if (msg.kind === 'offer') {
      await acceptOffer(msg.sdp);
    } else if (msg.kind === 'ice' && msg.candidate && pc) {
      await pc.addIceCandidate(msg.candidate).catch(() => {});
    }
  },
});

// --- WebRTC ---------------------------------------------------------------------

function closePeer() {
  pc?.close();
  pc = null;
  dc = null;
  phoneState = null;
  incoming = null;
  video.srcObject = null;
  ui.placeholder.hidden = false;
  ui.transfer.hidden = true;
  setControlsEnabled(false);
  updateRecordingUI();
}

async function acceptOffer(sdp) {
  closePeer();
  const conn = new RTCPeerConnection(RTC_CONFIG);
  pc = conn;

  conn.ontrack = (e) => {
    video.srcObject = e.streams[0] || new MediaStream([e.track]);
    video.play().catch(() => {});
    ui.placeholder.hidden = true;
  };
  conn.onicecandidate = (e) => e.candidate && signaling.signal({ kind: 'ice', candidate: e.candidate });
  conn.onconnectionstatechange = () => {
    if (conn !== pc) return;
    const s = conn.connectionState;
    if (s === 'connected') setConn('iPhone подключён', true);
    else if (s === 'connecting') setConn('соединение…', false);
    else if (s === 'failed' || s === 'disconnected') setConn('связь с iPhone потеряна', false);
  };
  conn.ondatachannel = (e) => {
    dc = e.channel;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => setControlsEnabled(true);
    dc.onclose = () => setControlsEnabled(false);
    dc.onmessage = onChannelMessage;
  };

  await conn.setRemoteDescription(sdp);
  const answer = await conn.createAnswer();
  await conn.setLocalDescription(answer);
  signaling.signal({ kind: 'answer', sdp: conn.localDescription });
}

function send(cmd, value) {
  if (dc?.readyState === 'open') dc.send(JSON.stringify({ cmd, value }));
}

// --- Сообщения от iPhone ----------------------------------------------------------

function onChannelMessage(e) {
  if (typeof e.data !== 'string') {
    receiveChunk(e.data);
    return;
  }
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case 'state':
      phoneState = msg;
      applyPhoneState();
      break;
    case 'error':
      toast(`iPhone: ${msg.message}`);
      break;
    case 'file-start':
      incoming = { ...msg, received: 0, chunks: [] };
      ui.transfer.hidden = false;
      ui.transferName.textContent = `Приём ${msg.name} (${formatBytes(msg.size)})`;
      ui.transferProgress.value = 0;
      break;
    case 'file-end':
      if (incoming?.id === msg.id) finishFile();
      break;
  }
}

function receiveChunk(buf) {
  if (!incoming) return;
  incoming.chunks.push(buf);
  incoming.received += buf.byteLength;
  ui.transferProgress.value = incoming.size ? incoming.received / incoming.size : 1;
}

function finishFile() {
  const { name, mime, chunks } = incoming;
  incoming = null;
  ui.transfer.hidden = true;
  const blob = new Blob(chunks, { type: mime });
  const url = URL.createObjectURL(blob);
  addToGallery(name, mime, url, blob.size);
  if (ui.autosave.checked) download(url, name);
  toast(`Сохранено: ${name}`);
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function addToGallery(name, mime, url, size) {
  const item = document.createElement('a');
  item.className = 'gallery-item';
  item.href = url;
  item.download = name;
  item.title = `${name} — ${formatBytes(size)}`;
  if (mime.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    item.appendChild(img);
  } else {
    const v = document.createElement('video');
    v.src = url;
    v.muted = true;
    v.preload = 'metadata';
    item.appendChild(v);
    item.classList.add('is-video');
  }
  ui.gallery.prepend(item);
}

function applyPhoneState() {
  const s = phoneState;
  const { width, height, frameRate } = s.settings;
  ui.videoInfo.textContent = `${s.facing === 'user' ? 'фронтальная' : 'основная'} · ${width}×${height} · ${Math.round(frameRate || 0)} fps`;
  ui.resolution.value = s.resolution;
  ui.mirror.checked = s.facing === 'user';
  applyMirror();

  ui.zoomSection.hidden = !s.caps.zoom;
  if (s.caps.zoom) {
    ui.zoom.min = s.caps.zoom.min;
    ui.zoom.max = Math.min(s.caps.zoom.max, 10); // цифровой зум дальше бесполезен
    ui.zoom.step = s.caps.zoom.step;
    if (document.activeElement !== ui.zoom) ui.zoom.value = s.settings.zoom ?? s.caps.zoom.min;
    ui.zoomValue.textContent = `${Number(ui.zoom.value).toFixed(1)}×`;
  }
  ui.torchSection.hidden = !s.caps.torch;
  ui.torch.checked = Boolean(s.settings.torch);
  updateRecordingUI();
}

// --- Элементы управления ------------------------------------------------------------

function setConn(text, ok) {
  ui.connState.textContent = text;
  ui.connState.classList.toggle('ok', ok);
}

function setControlsEnabled(on) {
  for (const el of [ui.photoBtn, ui.recordBtn, ui.switchBtn, ui.resolution]) el.disabled = !on;
  if (on) send('get-state');
}

function updateRecordingUI() {
  const recording = Boolean(phoneState?.recording);
  ui.recordBtn.classList.toggle('active', recording);
  ui.switchBtn.disabled = recording || !dc;
  ui.resolution.disabled = recording || !dc;
  ui.recTimer.hidden = !recording;
  clearInterval(recTimerId);
  if (recording) {
    // Телефон присылает прошедшее время, а не метку — часы устройств могут расходиться.
    const started = Date.now() - (phoneState.recordElapsed || 0);
    const tick = () => {
      const sec = Math.floor((Date.now() - started) / 1000);
      ui.recTimer.textContent = `● ${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    };
    tick();
    recTimerId = setInterval(tick, 500);
  }
}

function takePhoto() {
  if (!dc || countdownId) return;
  let left = Number(ui.timer.value);
  if (!left) {
    send('photo');
    shutterEffect();
    return;
  }
  ui.countdown.textContent = left;
  ui.countdown.classList.add('show');
  countdownId = setInterval(() => {
    left -= 1;
    if (left > 0) {
      ui.countdown.textContent = left;
      return;
    }
    clearInterval(countdownId);
    countdownId = null;
    ui.countdown.classList.remove('show');
    send('photo');
    shutterEffect();
  }, 1000);
}

function shutterEffect() {
  $('stage').classList.add('flash');
  setTimeout(() => $('stage').classList.remove('flash'), 150);
}

function toggleRecording() {
  if (!dc) return;
  send(phoneState?.recording ? 'record-stop' : 'record-start');
}

function applyMirror() {
  video.classList.toggle('mirror', ui.mirror.checked);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('stage').requestFullscreen?.();
}

let toastTimer = null;
function toast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2500);
}

ui.photoBtn.addEventListener('click', takePhoto);
ui.recordBtn.addEventListener('click', toggleRecording);
ui.switchBtn.addEventListener('click', () => send('switch'));
ui.resolution.addEventListener('change', () => send('resolution', ui.resolution.value));
ui.torch.addEventListener('change', () => send('torch', ui.torch.checked));
ui.zoom.addEventListener('input', () => {
  ui.zoomValue.textContent = `${Number(ui.zoom.value).toFixed(1)}×`;
  send('zoom', ui.zoom.value);
});
ui.grid.addEventListener('change', () => ui.gridOverlay.classList.toggle('show', ui.grid.checked));
ui.mirror.addEventListener('change', applyMirror);
$('fullscreenBtn').addEventListener('click', toggleFullscreen);

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // e.code не зависит от раскладки (работает и на русской).
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      takePhoto();
      break;
    case 'KeyR':
      toggleRecording();
      break;
    case 'KeyC':
      if (!ui.switchBtn.disabled) send('switch');
      break;
    case 'KeyF':
      toggleFullscreen();
      break;
    case 'KeyG':
      ui.grid.checked = !ui.grid.checked;
      ui.grid.dispatchEvent(new Event('change'));
      break;
  }
});
