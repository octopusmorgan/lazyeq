/**
 * Network Discovery — Detect the local IP address of the machine.
 *
 * Strategy:
 *   1. If window.location.hostname is already a local IP (192.168.x.x, 10.x.x.x,
 *      localhost), use it directly — no discovery needed.
 *   2. If accessing via a public tunnel (ngrok, etc.), use a WebRTC ICE trick:
 *      create a dummy RTCPeerConnection and read the host candidates to extract
 *      the local IPv4 address.
 *   3. If the WebRTC trick fails, return null so the UI falls back to manual input.
 */

/**
 * Check if a hostname is a local/private address.
 */
export function isPrivateOrLocalHostname(hostname) {
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return false;
}

/**
 * Discover local IPv4 address using WebRTC ICE candidates.
 * This is a well-known technique used by WebRTC leak tests.
 *
 * @returns {Promise<string|null>} — Local IP or null if not found.
 */
export async function discoverLocalIP() {
  // Some browsers block local IP exposure via mDNS or privacy settings.
  // This tries the standard approach; if it fails, we gracefully return null.
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const candidateIps = new Set();
    let resolved = false;

    pc.createDataChannel("");

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      // candidate format: candidate:... 1 udp ... 192.168.1.42 12345 typ host ...
      const match = /([0-9]{1,3}\.){3}[0-9]{1,3}/.exec(e.candidate.candidate);
      if (match) {
        const ip = match[0];
        // Filter out loopback and zero addresses
        if (!ip.startsWith("127.") && !ip.startsWith("0.")) {
          candidateIps.add(ip);
        }
      }
    };

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        finish();
      }
    };

    function finish() {
      if (resolved) return;
      resolved = true;
      pc.close();
      // Prefer 192.168.x.x (most common home Wi-Fi), then 10.x.x.x
      const ips = Array.from(candidateIps);
      const preferred = ips.find((ip) => ip.startsWith("192.168."))
        || ips.find((ip) => ip.startsWith("10."))
        || ips[0]
        || null;
      resolve(preferred);
    }

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => {
        pc.close();
        resolve(null);
      });

    // Safety timeout
    setTimeout(() => {
      if (!resolved) finish();
    }, 3000);
  });
}

/**
 * Determine the best signaling server URL.
 * Returns the URL string, or null if we need manual input.
 */
export async function resolveSignalingUrl(hostname = window.location.hostname) {
  if (isPrivateOrLocalHostname(hostname)) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${hostname}:3001`;
  }

  // Public tunnel (ngrok, etc.) — try WebRTC discovery
  const localIP = await discoverLocalIP();
  if (localIP) {
    return `ws://${localIP}:3001`;
  }

  return null;
}
