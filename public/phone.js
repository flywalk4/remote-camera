'use strict';

// Сторона iPhone: захватывает камеру, отдаёт видео по WebRTC и выполняет
// команды пульта (переключение камеры, зум, вспышка, фото, запись видео).

const RESOLUTIONS = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
};

const $ = (id) => document.getElementById(id);
const preview = $('preview');
const statusEl = $('status');
const startBtn = $('start');
const audioToggle = $('audio');

const state = {
  facing: 'environment',
  resolution: '1080p',
  videoTrack: null,
  audioTrack: null,
  pc: null,
  sender: null,
  dc: null,
  pendingIce: [],
  recorder: null,
  recordStart: 0,
  outbox: [], // файлы, ожидающие отправки на Mac
  sending: false,
  wakeLock: null,
};

let peerPresent = false;

const signaling = new Signaling('phone', {
  onState: (ok) => setStatus(ok ? 'Сервер подключён' : 'Нет связи с сервером…'),
  onPeer: (present) => {
    peerPresent = present;
    if (present && state.videoTrack) createPeer();
    if (!present) {
      closePeer();
      setStatus('Ожидание пульта на Mac…');
    }
  },
  onSignal: async (msg) => {
    const pc = state.pc;
    if (!pc) return;
    if (msg.kind === 'answer') {
      await pc.setRemoteDescription(msg.sdp);
      for (const c of state.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } else if (msg.kind === 'ice' && msg.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate).catch(() => {});
      else state.pendingIce.push(msg.candidate);
    }
  },
});

function setStatus(text) {
  statusEl.textContent = text;
}

// --- Камера -------------------------------------------------------------------

async function acquireVideo() {
  const res = RESOLUTIONS[state.resolution];
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: state.facing },
      width: { ideal: res.width },
      height: { ideal: res.height },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
  return stream.getVideoTracks()[0];
}

async function startCamera() {
  startBtn.disabled = true;
  try {
    state.videoTrack = await acquireVideo();
    if (audioToggle.checked) {
      try {
        const a = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        state.audioTrack = a.getAudioTracks()[0];
      } catch {
        audioToggle.checked = false; // микрофон запрещён — пишем видео без звука
      }
    }
    showPreview();
    document.body.classList.add('running');
    await requestWakeLock();
    setStatus(peerPresent ? 'Подключение к пульту…' : 'Ожидание пульта на Mac…');
    if (peerPresent) createPeer();
  } catch (err) {
    setStatus(`Нет доступа к камере: ${err.message}`);
    startBtn.disabled = false;
  }
}

function showPreview() {
  preview.srcObject = new MediaStream([state.videoTrack]);
  preview.classList.toggle('mirror', state.facing === 'user');
  preview.play().catch(() => {});
}

// Замена видеодорожки без пересоздания WebRTC-соединения.
async function replaceVideo() {
  if (state.recorder) throw new Error('Нельзя менять камеру во время записи');
  // iOS не даёт открыть две камеры одновременно — сначала останавливаем старую.
  state.videoTrack?.stop();
  state.videoTrack = await acquireVideo();
  showPreview();
  if (state.sender) await state.sender.replaceTrack(state.videoTrack);
  sendState();
}

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // не критично: пользователь может сам отключить автоблокировку
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.videoTrack) requestWakeLock();
});

// --- WebRTC ------------------------------------------------------------------

function closePeer() {
  state.dc?.close();
  state.pc?.close();
  state.pc = null;
  state.sender = null;
  state.dc = null;
  state.pendingIce = [];
}

async function createPeer() {
  closePeer();
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.pc = pc;

  const sender = pc.addTrack(state.videoTrack, new MediaStream([state.videoTrack]));
  state.sender = sender;
  pc.onicecandidate = (e) => e.candidate && signaling.signal({ kind: 'ice', candidate: e.candidate });
  pc.onconnectionstatechange = () => {
    if (pc !== state.pc) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      setStatus('Подключено к Mac ✓');
      tuneSender(sender);
    } else if (s === 'failed') {
      setStatus('Соединение потеряно, переподключение…');
      if (peerPresent) createPeer();
    } else if (s === 'connecting') {
      setStatus('Подключение к пульту…');
    }
  };

  const dc = pc.createDataChannel('ctrl', { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 256 * 1024;
  state.dc = dc;
  dc.onopen = () => {
    sendState();
    flushOutbox();
  };
  dc.onmessage = (e) => handleCommand(JSON.parse(e.data));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signaling.signal({ kind: 'offer', sdp: pc.localDescription });
}

// По умолчанию браузер сильно ограничивает битрейт — поднимаем для локальной сети.
async function tuneSender(sender) {
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 12_000_000;
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  } catch {
    // не все версии Safari позволяют менять параметры — работаем с дефолтными
  }
}

function sendJSON(msg) {
  if (state.dc?.readyState === 'open') state.dc.send(JSON.stringify(msg));
}

function sendState() {
  const track = state.videoTrack;
  if (!track) return;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const settings = track.getSettings();
  sendJSON({
    type: 'state',
    facing: state.facing,
    resolution: state.resolution,
    recording: Boolean(state.recorder),
    recordElapsed: state.recorder ? Date.now() - state.recordStart : 0,
    audio: Boolean(state.audioTrack),
    caps: {
      zoom: caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 } : null,
      torch: Boolean(caps.torch),
    },
    settings: {
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate,
      zoom: settings.zoom,
      torch: settings.torch,
    },
  });
}

// --- Команды пульта -------------------------------------------------------------

async function handleCommand(msg) {
  try {
    switch (msg.cmd) {
      case 'switch':
        state.facing = state.facing === 'environment' ? 'user' : 'environment';
        await replaceVideo();
        break;
      case 'resolution':
        if (!RESOLUTIONS[msg.value]) return;
        state.resolution = msg.value;
        await replaceVideo();
        break;
      case 'zoom':
        await state.videoTrack.applyConstraints({ advanced: [{ zoom: Number(msg.value) }] });
        sendState();
        break;
      case 'torch':
        await state.videoTrack.applyConstraints({ advanced: [{ torch: Boolean(msg.value) }] });
        sendState();
        break;
      case 'photo':
        await takePhoto();
        break;
      case 'record-start':
        startRecording();
        break;
      case 'record-stop':
        stopRecording();
        break;
      case 'get-state':
        sendState();
        break;
    }
  } catch (err) {
    sendJSON({ type: 'error', message: err.message || String(err) });
    sendState();
  }
}

async function takePhoto() {
  const w = preview.videoWidth;
  const h = preview.videoHeight;
  if (!w || !h) throw new Error('Видео ещё не готово');
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(preview, 0, 0, w, h);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
  flash();
  enqueueFile(`IMG_${timestamp()}.jpg`, blob);
}

function flash() {
  document.body.classList.add('flash');
  setTimeout(() => document.body.classList.remove('flash'), 150);
}

function pickMimeType() {
  const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return candidates.find((t) => window.MediaRecorder?.isTypeSupported(t)) || '';
}

function startRecording() {
  if (state.recorder) return;
  if (!window.MediaRecorder) throw new Error('MediaRecorder не поддерживается (нужен iOS 14.3+)');
  const tracks = [state.videoTrack];
  if (state.audioTrack) tracks.push(state.audioTrack);
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(new MediaStream(tracks), {
    mimeType,
    videoBitsPerSecond: 16_000_000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const type = recorder.mimeType || mimeType || 'video/mp4';
    const ext = type.includes('webm') ? 'webm' : 'mp4';
    enqueueFile(`VID_${timestamp()}.${ext}`, new Blob(chunks, { type }));
  };
  recorder.start(1000);
  state.recorder = recorder;
  state.recordStart = Date.now();
  document.body.classList.add('recording');
  sendState();
}

function stopRecording() {
  if (!state.recorder) return;
  state.recorder.stop();
  state.recorder = null;
  state.recordStart = 0;
  document.body.classList.remove('recording');
  sendState();
}

// --- Передача файлов на Mac --------------------------------------------------------

function enqueueFile(name, blob) {
  state.outbox.push({ id: crypto.randomUUID(), name, blob });
  flushOutbox();
}

function waitForDrain(dc) {
  return new Promise((resolve, reject) => {
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done);
      dc.removeEventListener('close', fail);
      resolve();
    };
    const fail = () => {
      dc.removeEventListener('bufferedamountlow', done);
      reject(new Error('channel closed'));
    };
    dc.addEventListener('bufferedamountlow', done);
    dc.addEventListener('close', fail, { once: true });
  });
}

async function flushOutbox() {
  if (state.sending) return;
  state.sending = true;
  try {
    while (state.outbox.length && state.dc?.readyState === 'open') {
      const file = state.outbox[0];
      await sendFile(state.dc, file);
      state.outbox.shift(); // удаляем только после успешной отправки
    }
  } catch {
    // канал закрылся — файл остаётся в очереди и уйдёт при следующем подключении
  } finally {
    state.sending = false;
  }
}

async function sendFile(dc, { id, name, blob }) {
  dc.send(JSON.stringify({ type: 'file-start', id, name, mime: blob.type, size: blob.size }));
  const buffer = await blob.arrayBuffer();
  for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
    if (dc.readyState !== 'open') throw new Error('channel closed');
    if (dc.bufferedAmount > BUFFER_HIGH) await waitForDrain(dc);
    dc.send(buffer.slice(offset, offset + CHUNK_SIZE));
  }
  dc.send(JSON.stringify({ type: 'file-end', id }));
}

startBtn.addEventListener('click', startCamera);
