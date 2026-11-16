import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts: ['kavixo-web-production.up.railway.app'],
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: ['kavixo-web-production.up.railway.app'],
  },
});
