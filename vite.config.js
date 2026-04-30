import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.loca.lt', '.trycloudflare.com'],
    host: true,
  },
})