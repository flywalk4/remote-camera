'use strict';

// Общий код для телефона и пульта: WebSocket-сигналинг с автопереподключением
// и константы протокола канала данных.

const CHUNK_SIZE = 16 * 1024; // безопасный размер сообщения DataChannel для Safari
const BUFFER_HIGH = 1024 * 1024; // порог backpressure при передаче файлов

const RTC_CONFIG = {
  // В одной локальной сети STUN не обязателен, но помогает при сложных роутерах.
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

class Signaling {
  constructor(role, handlers) {
    this.role = role;
    this.handlers = handlers; // { onPeer(present), onSignal(msg), onState(connected) }
    this.ws = null;
    this.retry = 0;
    this.connect();
  }

  connect() {
    const ws = new WebSocket(`wss://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ type: 'hello', role: this.role }));
      this.handlers.onState?.(true);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'peer') this.handlers.onPeer?.(msg.present);
      else if (msg.type === 'signal') this.handlers.onSignal?.(msg);
    };
    ws.onclose = (e) => {
      this.handlers.onState?.(false);
      if (e.code === 4000) return; // вытеснены новой вкладкой — не переподключаемся
      const delay = Math.min(1000 * 2 ** this.retry++, 10000);
      setTimeout(() => this.connect(), delay);
    };
  }

  signal(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'signal', ...payload }));
    }
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

function timestamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
