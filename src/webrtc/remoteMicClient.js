/**
 * RemoteMicClient — Phone side of lazyEq dual-device measurement.
 * Joins a room by code, captures the local microphone, and transmits it via WebRTC.
 */

import { DEFAULT_SIGNALING_URL, ICE_SERVERS, SimpleSignalingChannel } from "./signalingChannel.js";

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
