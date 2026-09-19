/** @type {import('tailwindcss').Config} */

// The palette is driven by CSS variables (defined per theme in index.css under
// `[data-theme=…]`) rather than literal hex, so switching the OS theme restyles
// every existing `surface-*` / `accent` utility without touching components.
// Each variable holds space-separated RGB channels, and the `<alpha-value>`
// placeholder lets Tailwind's opacity modifiers (e.g. `bg-surface-900/80`) keep
// working.
const withChannels = (variable) => `rgb(var(${variable}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          900: withChannels('--surface-900'),
          800: withChannels('--surface-800'),
          700: withChannels('--surface-700'),
          600: withChannels('--surface-600'),
          500: withChannels('--surface-500'),
        },
        accent: {
          DEFAULT: withChannels('--accent'),
          hover: withChannels('--accent-hover'),
          muted: withChannels('--accent-muted'),
        },
      },
      fontFamily: {
        // The UI font follows the active theme (Segoe UI on Windows, the San
        // Francisco stack on macOS, Cantarell/Inter on GNOME). The variable is
        // set per theme in index.css.
        sans: ['var(--font-ui)', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        // The floating-window radius, so window chrome can use `rounded-window`.
        window: 'var(--window-radius)',
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
