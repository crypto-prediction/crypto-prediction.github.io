// Builds the static online demo for GitHub Pages: npm run build:demo
// The same pages and components as the normal build. Only the entry scripts change, so that a browser layer
// (src/demo) answers the app's /api and /ws requests instead of the Signal Lab server.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const ENTRIES = { '/src/main.jsx': '/src/demo/main-demo.jsx', '/src/lab-main.jsx': '/src/demo/lab-demo.jsx' };

export default defineConfig({
  base: process.env.DEMO_BASE || '/signal-lab/',
  plugins: [
    react(),
    {
      name: 'signal-lab-demo-entries',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => Object.entries(ENTRIES).reduce((h, [from, to]) => h.replace(`src="${from}"`, `src="${to}"`), html),
      },
    },
  ],
  build: {
    outDir: 'dist-demo',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        lab: fileURLToPath(new URL('./lab.html', import.meta.url)),
      },
    },
  },
  server: { fs: { allow: ['..'] } },
});
