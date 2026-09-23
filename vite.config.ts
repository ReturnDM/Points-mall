import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// base: './' 使 dist 可被任意静态服务器（或 file:// 之外的任意路径前缀）托管
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
})
