/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--ui-border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--ui-accent))',
          foreground: 'hsl(var(--ui-accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        pp: {
          ink: 'var(--ink)',
          'ink-dim': 'var(--ink-dim)',
          'ink-faint': 'var(--ink-faint)',
          bg: 'var(--bg)',
          surface: 'var(--surface)',
          'surface-2': 'var(--surface-2)',
          accent: 'var(--accent)',
          'accent-ink': 'var(--accent-ink)',
          'accent-soft': 'var(--accent-soft)',
          hi: 'var(--hi)',
          danger: 'var(--danger)',
          'danger-soft': 'var(--danger-soft)',
          ok: 'var(--ok)',
          'ok-ink': 'var(--ok-ink)',
          'ok-soft': 'var(--ok-soft)',
          'ok-deep': 'var(--ok-deep)',
          warn: 'var(--warn)',
          'warn-soft': 'var(--warn-soft)',
        },
      },
      borderRadius: {
        xl: 'calc(var(--ui-radius) + 4px)',
        lg: 'var(--ui-radius)',
        md: 'calc(var(--ui-radius) - 2px)',
        sm: 'calc(var(--ui-radius) - 4px)',
      },
      fontFamily: {
        display: ['"Darker Grotesque"', 'sans-serif'],
        body: ['Figtree', 'Inter', 'system-ui', 'sans-serif'],
        courier: ['"Courier Prime"', 'monospace'],
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
