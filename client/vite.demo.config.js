// Builds the static online demo for GitHub Pages: npm run build:demo
// The same pages and components as the normal build. Only the entry scripts change, so that a browser layer
// (src/demo) answers the app's /api and /ws requests instead of the Signal Lab server.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const ENTRIES = { '/src/main.jsx': '/src/demo/main-demo.jsx', '/src/lab-main.jsx': '/src/demo/lab-demo.jsx' };

// The name the public site shows in search results and browser tabs. The local app keeps "Signal Lab".
const SITE_NAME = 'Crypto Prediction';
const PAGES = {
  '<title>Signal Lab</title>': {
    title: `${SITE_NAME} · Live crypto forecasts, charts and paper trading`,
    description: 'Free crypto research dashboard with live Binance prices for Bitcoin, Ethereum, Solana and 7 more coins: statistical price forecasts, technical indicators, backtesting and $10,000 paper trading. Not financial advice.',
  },
  '<title>Intelligence Lab · Signal Lab</title>': {
    title: `Intelligence Lab · ${SITE_NAME}`,
    description: 'Crypto forecasts for 5 time horizons, a market heatmap, futures data, a backtest lab and a risk simulator, all from live Binance data. Not financial advice.',
  },
};
const escape = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const withSiteName = (html) => {
  for (const [from, { title, description }] of Object.entries(PAGES)) {
    if (!html.includes(from)) continue;
    const tags = [
      `<title>${escape(title)}</title>`,
      `<meta name="description" content="${escape(description)}" />`,
      `<meta property="og:site_name" content="${SITE_NAME}" />`,
      `<meta property="og:title" content="${escape(title)}" />`,
      `<meta property="og:description" content="${escape(description)}" />`,
    ].join('\n    ');
    return html.replace(from, tags);
  }
  return html;
};

export default defineConfig({
  base: process.env.DEMO_BASE || '/crypto-prediction/',
  plugins: [
    react(),
    {
      name: 'signal-lab-demo-entries',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => withSiteName(Object.entries(ENTRIES).reduce((h, [from, to]) => h.replace(`src="${from}"`, `src="${to}"`), html)),
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
