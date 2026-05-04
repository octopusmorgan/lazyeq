/**
 * Shared WebRTC signaling infrastructure for lazyEq remote mic.
 * Used by both RemoteMicHost (PC) and RemoteMicClient (phone).
 */

export const DEFAULT_SIGNALING_URL = (() => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:3001`;
})();

export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * SimpleSignalingChannel — WebSocket wrapper for the signaling relay.
 */
export class SimpleSignalingChannel {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.ready = false;
    this._queue = [];
    this.onmessage = null;
    this.onopen = null;
    this.onerror = null;
    this.onclose = null;
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.ws?.close();
          reject(new Error(`Connection to signaling server timed out (${timeoutMs}ms). Is the server running?`));
        }
      }, timeoutMs);

      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        clearTimeout(timer);
        return reject(err);
      }

      this.ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = true;
        this._flushQueue();
        this.onopen?.();
        resolve();
      };

      this.ws.onmessage = (evt) => {
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        if (import.meta.env.DEV) console.log("[SignalingChannel] Received:", msg.type, msg.payload ? JSON.stringify(msg.payload).substring(0, 80) : "");
        this.onmessage?.(msg);
      };

      this.ws.onerror = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.onerror?.(err);
        reject(new Error(`Cannot connect to signaling server at ${this.url}`));
      };

      this.ws.onclose = () => {
        this.ready = false;
        this.onclose?.();
      };
    });
  }

  _flushQueue() {
    while (this._queue.length > 0) {
      const msg = this._queue.shift();
      this.ws.send(JSON.stringify(msg));
    }
  }

  send(type, payload = {}) {
    const msg = { type, payload };
    if (this.ready && this.ws) {
      this.ws.send(JSON.stringify(msg));
      if (import.meta.env.DEV) console.log("[SignalingChannel] Sent:", type, payload ? JSON.stringify(payload).substring(0, 80) : "");
    } else {
      this._queue.push(msg);
      if (import.meta.env.DEV) console.log("[SignalingChannel] Queued:", type, "(not ready)");
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
