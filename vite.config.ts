import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// The production build is served from https://<user>.github.io/MAX_Tennis_Game/,
// so assets need that prefix. On localhost the dev server serves from the root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/MAX_Tennis_Game/' : '/',
  plugins: [react()],
}))
