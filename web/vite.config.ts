import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 매 빌드마다 version.json 생성 (build_id = timestamp)
function buildVersionPlugin() {
  const buildId = String(Date.now())
  return {
    name: 'build-version',
    config() {
      // build_id를 import.meta.env로도 노출
      return { define: { __BUILD_ID__: JSON.stringify(buildId) } }
    },
    closeBundle() {
      const out = resolve(__dirname, 'dist/version.json')
      try { writeFileSync(out, JSON.stringify({ build_id: buildId, built_at: new Date().toISOString() })) } catch {}
    },
  }
}

export default defineConfig({
  plugins: [react(), buildVersionPlugin()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8008',
    },
  },
  build: {
    // Hashed filenames — ensures browsers fetch fresh code on every deploy.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
