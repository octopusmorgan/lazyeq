import { defineConfig } from 'vite'
import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'

/**
 * lazyEQ Vite Configuration
 *
 * HTTPS Local Setup (optional, for remote mic on phones):
 *   1. Install mkcert:  brew install mkcert  (or apt-get install mkcert)
 *   2. Install root CA: mkcert -install
 *   3. Generate certs:  mkcert 192.168.x.x localhost 127.0.0.1
 *   4. Rename files:    mv 192.168.x.x+localhost+127.0.0.1.pem cert.pem
 *                     mv 192.168.x.x+localhost+127.0.0.1-key.pem cert-key.pem
 *   5. Start Vite:      npm run dev
 *
 * The dev server will auto-detect cert.pem/cert-key.pem and serve HTTPS.
 * The phone accesses https://192.168.x.x:5173/remote-mic.html
 */

function loadLocalCerts() {
  const certPath = resolve(__dirname, 'cert.pem')
  const keyPath = resolve(__dirname, 'cert-key.pem')
  if (existsSync(certPath) && existsSync(keyPath)) {
    return {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    }
  }
  return null
}

const https = loadLocalCerts()

export default defineConfig({
  server: {
    host: true,
    https: https || undefined,
    allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.loca.lt', '.trycloudflare.com'],
    proxy: {
      '/signaling': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: 'hidden',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        remoteMic: resolve(__dirname, 'remote-mic.html'),
      },
    },
  },
})
