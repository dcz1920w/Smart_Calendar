import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    watch: {
      ignored: [
        '**/backend/committed_schedule.json',
        '**/backend/tasks.json',
        '**/backend/user_model.json',
        '**/backend/__pycache__/**',
      ],
    },
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
