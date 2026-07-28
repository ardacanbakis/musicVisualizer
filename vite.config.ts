import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves this project from https://<user>.github.io/musicVisualizer/,
// so every asset URL needs that prefix. `npm run dev` overrides base to '/'.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/musicVisualizer/' : '/',
  plugins: [react()],
  build: {
    target: 'es2020',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}))
