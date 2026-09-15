/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // A single dark palette. A light theme is not implemented; the desktop
        // metaphor and the terminal app both read better on a dark surface, and
        // shipping a half-finished light theme would be worse than none.
        surface: {
          900: '#0b1020',
          800: '#111834',
          700: '#18203f',
          600: '#212a4d',
          500: '#2c3760',
        },
        accent: {
          DEFAULT: '#4f8cff',
          hover: '#6ea3ff',
          muted: '#2b4a86',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
      },
    },
  },
  plugins: [],
};
