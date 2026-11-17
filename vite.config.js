import { defineConfig } from 'vite';

const allowedHosts = [
  'kavixo-web-production.up.railway.app',
  'kavixo-app-production.up.railway.app',
];

export default defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts,
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts,
  },
});
