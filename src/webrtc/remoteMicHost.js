/**
 * RemoteMicHost — PC side of lazyEq dual-device measurement.
 * Creates a WebRTC room, displays a room code, and receives the remote mic stream.
 */

import { DEFAULT_SIGNALING_URL, ICE_SERVERS, SimpleSignalingChannel } from "./signalingChannel.js";

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
