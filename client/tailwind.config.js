/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#050608', 900: '#0a0c10', 850: '#0e1116', 800: '#13171e', 700: '#1c222c', 600: '#2a3240' },
        mute: '#7d8798',
        cyan: { neon: '#22e1ff' },
        violet: { neon: '#a98bff' },
        lime: { neon: '#3cf2a0' },
        rose: { neon: '#ff5d7a' },
        amber: { neon: '#ffc15e' },
      },
      fontFamily: {
        display: ['Sora', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'Menlo', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(34,225,255,.25), 0 0 24px -6px rgba(34,225,255,.35)',
      },
    },
  },
  plugins: [],
};
