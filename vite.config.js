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
      '/gauges':      'http://localhost:8788',
      '/exposure':    'http://localhost:8788',
      '/capex-history': 'http://localhost:8788',
      '/candidates':  'http://localhost:8788',
      '/musk-capex':  'http://localhost:8788',
      '/musk-intel':  'http://localhost:8788',
      '/robotics-capex': 'http://localhost:8788',
      '/robotics-intel': 'http://localhost:8788',
      '/composite':   'http://localhost:8788',
      '/scoreboard':  'http://localhost:8788',
    },
  },
})
