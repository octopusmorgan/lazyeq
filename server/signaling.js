/**
 * Simple WebSocket Signaling Server for lazyEQ Remote Mic
 *
 * Supports both WS (HTTP) and WSS (HTTPS) depending on whether
 * local certificates are present (cert.pem / cert-key.pem).
 *
 * HTTPS Setup:
 *   1. Install mkcert:  brew install mkcert
 *   2. Install root CA: mkcert -install
 *   3. Generate certs:  mkcert 192.168.x.x localhost 127.0.0.1
 *   4. Rename files:    mv 192.168.x.x+localhost+127.0.0.1.pem cert.pem
 *                     mv 192.168.x.x+localhost+127.0.0.1-key.pem cert-key.pem
 *   5. Start server:    node server/signaling.js
 *
 * Usage:
 *   node server/signaling.js              # HTTP  (ws://)
 *   CERT=1 node server/signaling.js       # HTTPS (wss://) — requires cert.pem + cert-key.pem
 */

import http from "http";
import https from "https";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { WebSocketServer } from "ws";

const PORT = process.env.SIGNALING_PORT || 3001;
const USE_TLS = process.env.CERT === "1" || process.env.WSS === "1";
const ROOM_CODE_LENGTH = 4;

function loadCerts() {
  const certPath = resolve(process.cwd(), "cert.pem");
  const keyPath = resolve(process.cwd(), "cert-key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    return {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    };
  }
  return null;
}

const certs = loadCerts();
const isSecure = USE_TLS && certs;

const handler = (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "lazyeq-signaling", version: "1.0.0", secure: isSecure }));
};

const server = isSecure
  ? https.createServer(certs, handler)
  : http.createServer(handler);

const wss = new WebSocketServer({ server });

// roomCode → { host: ws, client: ws }
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += Math.floor(Math.random() * 10);
    }
  } while (rooms.has(code));
  return code;
}

function send(ws, type, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

wss.on("connection", (ws) => {
  let role = null; // 'host' | 'client'
  let roomCode = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, "error", { message: "Invalid JSON" });
    }

    console.log(`[SIGNaling] Received from ${role || "unknown"}: ${msg.type}`, msg.payload ? JSON.stringify(msg.payload).substring(0, 100) : "");

    switch (msg.type) {
      case "create": {
        // Host creates a room
        if (roomCode) {
          return send(ws, "error", { message: "Already in a room" });
        }
        roomCode = generateRoomCode();
        role = "host";
        rooms.set(roomCode, { host: ws, client: null });
        send(ws, "created", { roomCode });
        console.log(`[SIGNaling] Room ${roomCode} created by host`);
        break;
      }

      case "join": {
        // Client joins a room by code
        const code = msg.payload?.roomCode;
        if (!code || !rooms.has(code)) {
          return send(ws, "error", { message: "Room not found" });
        }
        const room = rooms.get(code);
        if (room.client) {
          return send(ws, "error", { message: "Room already has a client" });
        }
        room.client = ws;
        roomCode = code;
        role = "client";
        send(ws, "joined", { roomCode: code });
        // Notify host that client is ready
        send(room.host, "client-ready", {});
        console.log(`[SIGNaling] Client joined room ${code}`);
        break;
      }

      case "offer":
      case "answer":
      case "ice": {
        // Relay signaling messages to the other peer
        if (!roomCode || !rooms.has(roomCode)) {
          return send(ws, "error", { message: "Not in a room" });
        }
        const room = rooms.get(roomCode);
        const target = role === "host" ? room.client : room.host;
        if (target) {
          send(target, msg.type, msg.payload);
          console.log(`[SIGNaling] ${msg.type} relayed from ${role} to ${role === "host" ? "client" : "host"} in room ${roomCode}`);
        } else {
          console.log(`[SIGNaling] ${msg.type} DROPPED - no target in room ${roomCode} (role=${role})`);
        }
        break;
      }

      default:
        send(ws, "error", { message: "Unknown message type: " + msg.type });
    }
  });

  ws.on("close", () => {
    if (roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      if (role === "host") {
        // Host left — destroy room
        if (room.client) send(room.client, "host-disconnected", {});
        rooms.delete(roomCode);
        console.log(`[SIGNaling] Room ${roomCode} destroyed (host left)`);
      } else if (role === "client") {
        // Client left — notify host
        room.client = null;
        if (room.host) send(room.host, "client-disconnected", {});
        console.log(`[SIGNaling] Client left room ${roomCode}`);
      }
    }
  });
});

server.listen(PORT, () => {
  const protocol = isSecure ? "wss" : "ws";
  console.log(`lazyEQ Signaling Server running on ${protocol}://0.0.0.0:${PORT}`);
  console.log(`LAN peers can connect to ${protocol}://<this-ip>:${PORT}`);
  if (!isSecure) {
    console.log(`\nTo enable WSS (for HTTPS pages), run:`);
    console.log(`  mkcert 192.168.x.x localhost 127.0.0.1`);
    console.log(`  mv 192.168.x.x+localhost+127.0.0.1.pem cert.pem`);
    console.log(`  mv 192.168.x.x+localhost+127.0.0.1-key.pem cert-key.pem`);
    console.log(`  CERT=1 node server/signaling.js`);
  }
});
