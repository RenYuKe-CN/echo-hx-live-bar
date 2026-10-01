import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Baota may create a protected dist/.user.ini. Keep it while replacing
    // the generated frontend files so Vite can build without EPERM.
    emptyOutDir: false
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://localhost:3001'
    }
  }
});
