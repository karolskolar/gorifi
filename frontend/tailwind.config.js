/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}',
  ],
  // ⚠ `h-screen` is the friends theme's DISPLAY-HEADING class, not a height
  // utility (`friends-theme.css`: `:where(.app,.modal-layer) .h-screen`), and
  // 03 §UC-FL-002/006 mandate `<h1 class="h-screen">` / `<h2 class="h-screen">`
  // verbatim. Tailwind's JIT generates a utility the moment its name appears in
  // any scanned source, so writing that markup made it emit `.h-screen{height:
  // 100vh}` — same specificity as the theme rule, different property, so BOTH
  // applied and the login headline became a full viewport tall (measured: an
  // 855px gap between the headline and its subtitle at 378px).
  //
  // Blocking the CANDIDATE is the only fix that scales: an inline `height:auto`
  // would have to be repeated on every heading modules 03–06 add, and one
  // omission is invisible until someone opens that screen.
  //
  // ⚠ This does NOT touch `min-h-screen` — a different candidate string, and
  // the only one the 19 admin/guest views actually use. Nothing in the tree
  // uses bare `h-screen` as a height utility.
  //
  // ⚠ CONSEQUENCE FOR FUTURE CODE, because the failure is silent: outside
  // `.app`/`.modal-layer`, `class="h-screen"` now resolves to NOTHING — no
  // height, no error, no warning. If you want the Tailwind height utility, use
  // `min-h-screen` (already used across the admin views) or the arbitrary value
  // `h-[100vh]`, which is a different candidate string and is not blocked.
  blocklist: ['h-screen'],
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
