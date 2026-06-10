import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/prices':      'http://localhost:8788',
      '/scanner':     'http://localhost:8788',
      '/scanner-ranked': 'http://localhost:8788',
      '/shortlist':   'http://localhost:8788',
      '/capex':       'http://localhost:8788',
      '/capex-intel': 'http://localhost:8788',
      '/news':        'http://localhost:8788',
      '/market-news': 'http://localhost:8788',
      '/quote':       'http://localhost:8788',
      '/presence':    'http://localhost:8788',
      '/cnn-fear-greed': 'http://localhost:8788',
      '/stress':      'http://localhost:8788',
    },
  },
})
