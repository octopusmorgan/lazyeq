/**
 * RemoteMic - WebRTC-based remote microphone for lazyEQ dual-device measurement.
 *
 * RemoteMicHost    — Runs on the PC (master). Creates a room, receives audio.
 * RemoteMicClient  — Runs on the phone. Joins a room, transmits microphone audio.
 *
 * Requires a signaling server (server/signaling.js) running on the LAN.
 */

const DEFAULT_SIGNALING_URL = (() => {
  // Auto-detect: same host as the page, port 3001
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:3001`;
})();

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * SimpleSignalingChannel — WebSocket wrapper for the signaling relay.
 */
class SimpleSignalingChannel {
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

/**
 * RemoteMicHost — PC side.
 * Creates a WebRTC room, displays a room code, and receives the remote mic stream.
 */
export class RemoteMicHost {
  constructor({ signalingUrl = DEFAULT_SIGNALING_URL } = {}) {
    this.signaling = new SimpleSignalingChannel(signalingUrl);
    this.pc = null;
    this.remoteStream = null;
    this.roomCode = null;

    // Callbacks
    this.onRoomCreated = null;       // (roomCode)
    this.onRemoteStream = null;      // (MediaStream)
    this.onClientConnected = null;   // ()
    this.onClientDisconnected = null;// ()
    this.onError = null;             // (msg)
    this.onStatus = null;            // (msg)
  }

  async start() {
    this._status("Connecting to signaling server...");
    await this.signaling.connect();

    this.signaling.onmessage = (msg) => this._handleSignaling(msg);
    this.signaling.onclose = () => this._handleDisconnect();

    this._status("Creating room...");
    this.signaling.send("create");

    // Timeout: if server doesn't respond with "created" within 8s, bail out
    this._createTimeout = setTimeout(() => {
      this._error("Signaling server did not respond. Is it running on the correct port?");
      this.disconnect();
    }, 8000);
  }

  _handleSignaling(msg) {
    this._status(`[Host] Received: ${msg.type}`);
    if (import.meta.env.DEV) console.log("[RemoteMicHost] Received signaling message:", msg.type, msg.payload ? JSON.stringify(msg.payload).substring(0, 100) : "");
    switch (msg.type) {
      case "created": {
        if (this._createTimeout) {
          clearTimeout(this._createTimeout);
          this._createTimeout = null;
        }
        this.roomCode = msg.payload.roomCode;
        this._status(`Room ${this.roomCode} created. Waiting for remote mic...`);
        this.onRoomCreated?.(this.roomCode);
        break;
      }
      case "client-ready": {
        this._status("Remote mic found — starting WebRTC handshake...");
        this._createPeerConnection();
        this._createOffer();
        break;
      }
      case "answer": {
        this._status("Received answer, setting remote description...");
        try {
          this.pc.setRemoteDescription(new RTCSessionDescription(msg.payload))
            .then(() => this._status("Remote description set, ICE gathering started"))
            .catch((e) => this._error("Failed to set remote description: " + e.message));
        } catch (e) {
          this._error("setRemoteDescription threw: " + e.message);
        }
        break;
      }
      case "ice": {
        this._status(`Received ICE candidate from client`);
        this.pc.addIceCandidate(new RTCIceCandidate(msg.payload)).catch((e) => {
          this._status(`ICE candidate error: ${e.message}`);
          if (import.meta.env.DEV) console.warn("ICE candidate error:", e);
        });
        break;
      }
      case "client-disconnected": {
        this._status("Remote mic disconnected.");
        this.onClientDisconnected?.();
        this._cleanup();
        break;
      }
      case "error": {
        this._error("Signaling error: " + msg.payload.message);
        break;
      }
      default: {
        this._status(`[Host] Unknown message type: ${msg.type}`);
      }
    }
  }

  _createPeerConnection() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Add a recvonly audio transceiver so the offer has an m=audio section.
    // Without this, Chromium creates an empty SDP with no ICE transport,
    // and iceGatheringState stays "new" forever (no candidates generated).
    this.pc.addTransceiver('audio', { direction: 'recvonly' });

    this._status(`[Host] PeerConnection created. ICE servers: ${JSON.stringify(ICE_SERVERS)}`);

    this.pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        this._status(`[Host] ICE candidate: ${evt.candidate.type} - ${evt.candidate.candidate.substring(0, 40)}...`);
        this.signaling.send("ice", evt.candidate);
      } else {
        this._status(`[Host] ICE gathering complete. State: ${this.pc.iceGatheringState}`);
      }
    };

    this.pc.onicegatheringstatechange = () => {
      this._status(`[Host] ICE gathering state changed: ${this.pc.iceGatheringState}`);
    };

    this.pc.ontrack = (evt) => {
      this.remoteStream = evt.streams[0];
      this._status("Remote microphone stream active!");
      this.onRemoteStream?.(this.remoteStream);
      this.onClientConnected?.();
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      this._status(`[Host] WebRTC state: ${state}`);
      if (import.meta.env.DEV) console.log("Host PC connection state:", state);
      if (state === "failed" || state === "closed") {
        this._error("WebRTC connection failed.");
        this._cleanup();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      this._status(`[Host] ICE state: ${this.pc.iceConnectionState}`);
    };
  }

  async _createOffer() {
    try {
      const offer = await this.pc.createOffer();
      this._status("[Host] Offer created, setting local description...");
      await this.pc.setLocalDescription(offer);
      this._status(`[Host] Local description set. ICE gathering state: ${this.pc.iceGatheringState}`);
      this.signaling.send("offer", offer);
    } catch (e) {
      this._error(`[Host] createOffer failed: ${e.message}`);
    }
  }

  _handleDisconnect() {
    this._status("Signaling server disconnected.");
    this._cleanup();
  }

  _cleanup() {
    if (this._createTimeout) {
      clearTimeout(this._createTimeout);
      this._createTimeout = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.remoteStream = null;
    this.signaling.close();
  }

  disconnect() {
    this._cleanup();
  }

  _status(msg) {
    if (import.meta.env.DEV) console.log("[RemoteMicHost]", msg);
    this.onStatus?.(msg);
  }

  _error(msg) {
    console.error("[RemoteMicHost]", msg);
    this.onError?.(msg);
  }
}

/**
 * RemoteMicClient — Phone side.
 * Joins a room by code, captures the local microphone, and transmits it via WebRTC.
 */
export class RemoteMicClient {
  constructor({ signalingUrl = DEFAULT_SIGNALING_URL } = {}) {
    this.signaling = new SimpleSignalingChannel(signalingUrl);
    this.pc = null;
    this.localStream = null;
    this.roomCode = null;

    // Callbacks
    this.onConnected = null;      // ()
    this.onDisconnected = null;   // ()
    this.onError = null;          // (msg)
    this.onStatus = null;         // (msg)
  }

  async connect(roomCode) {
    this.roomCode = roomCode;
    this._status("Connecting to signaling server...");
    await this.signaling.connect();

    this.signaling.onmessage = (msg) => this._handleSignaling(msg);
    this.signaling.onclose = () => this._handleDisconnect();

    // Request microphone permission NOW (inside user gesture context).
    // Firefox/Chrome block getUserMedia when called from WebSocket onmessage handlers.
    // By requesting here (triggered by the user's "Connect" button click), we stay
    // within the allowed gesture context.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("getUserMedia not supported in this browser. Please use Firefox.");
    }

    this._status("Requesting microphone access...");
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this._status("Microphone access granted. Joining room...");

    this._status("Joining room...");
    this.signaling.send("join", { roomCode });
  }

  _handleSignaling(msg) {
    switch (msg.type) {
      case "joined": {
        this._status(`Joined room ${this.roomCode}. Waiting for host...`);
        break;
      }
      case "offer": {
        this._handleOffer(msg.payload);
        break;
      }
      case "ice": {
        if (this.pc) {
          this.pc.addIceCandidate(new RTCIceCandidate(msg.payload)).catch((e) => {
            if (import.meta.env.DEV) console.warn("ICE candidate error:", e);
          });
        }
        break;
      }
      case "host-disconnected": {
        this._status("Host disconnected.");
        this.onDisconnected?.();
        this._cleanup();
        break;
      }
      case "error": {
        this._error("Signaling error: " + msg.payload.message);
        break;
      }
    }
  }

  async _handleOffer(offer) {
    try {
      // Microphone was already acquired in connect() (user gesture context).
      // If for some reason it's not available, try again but it may be blocked.
      if (!this.localStream) {
        this._status("Microphone not acquired. Requesting access...");
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("getUserMedia not supported in this browser.");
        }
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      }

      this._status("Setting up audio...");

      this._status("Creating peer connection...");
      this._createPeerConnection();
      
      this._status("Setting remote description...");
      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));

      this._status("Adding audio tracks...");
      this.localStream.getAudioTracks().forEach((track) => {
        this.pc.addTrack(track, this.localStream);
      });

      // Ensure the transceiver direction is sendonly so the answer is correct
      const audioTransceiver = this.pc.getTransceivers().find(t => t.kind === 'audio');
      if (audioTransceiver) {
        audioTransceiver.direction = 'sendonly';
        this._status("[Client] Transceiver set to sendonly");
      }

      this._status("Creating answer...");
      const answer = await this.pc.createAnswer();
      
      this._status("Setting local description...");
      await this.pc.setLocalDescription(answer);
      
      this._status("Sending answer to host...");
      this.signaling.send("answer", answer);

      this._status("Waiting for connection...");
      
      // Timeout: if not connected within 15s, show error
      setTimeout(() => {
        if (this.pc && this.pc.connectionState !== 'connected') {
          this._error("Connection timed out. Check that both devices are on the same network.");
        }
      }, 15000);
    } catch (err) {
      this._error("Failed to start mic: " + err.name + " - " + err.message);
    }
  }

  _createPeerConnection() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this._status(`[Client] PeerConnection created. ICE servers: ${JSON.stringify(ICE_SERVERS)}`);

    this.pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        this._status(`[Client] ICE candidate: ${evt.candidate.type} - ${evt.candidate.candidate.substring(0, 40)}...`);
        this.signaling.send("ice", evt.candidate);
      } else {
        this._status(`[Client] ICE gathering complete. State: ${this.pc.iceGatheringState}`);
      }
    };

    this.pc.onicegatheringstatechange = () => {
      this._status(`[Client] ICE gathering state changed: ${this.pc.iceGatheringState}`);
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      this._status("[Client] WebRTC state: " + state);
      if (import.meta.env.DEV) console.log("Client PC connection state:", state);
      if (state === "connected") {
        this._status("Audio channel established! Transmitting...");
        this.onConnected?.();
      }
      if (state === "failed" || state === "closed") {
        this._error("WebRTC connection failed.");
        this.onDisconnected?.();
        this._cleanup();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      this._status(`[Client] ICE state: ${this.pc.iceConnectionState}`);
    };
  }

  _handleDisconnect() {
    this._status("Signaling server disconnected.");
    this.onDisconnected?.();
    this._cleanup();
  }

  _cleanup() {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    this.signaling.close();
  }

  disconnect() {
    this._cleanup();
  }

  _status(msg) {
    if (import.meta.env.DEV) console.log("[RemoteMicClient]", msg);
    this.onStatus?.(msg);
  }

  _error(msg) {
    console.error("[RemoteMicClient]", msg);
    this.onError?.(msg);
  }
}
