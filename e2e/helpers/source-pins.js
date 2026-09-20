import { expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ONE HOME for reading FRONTEND SOURCE in a spec — 18 §UC-PI-019, PI-T3 review.
//
// ⚠⚠ WHY THIS FILE EXISTS, AND IT IS NOT TIDINESS. A source pin is almost always an
// ABSENCE (`expect(src).not.toContain('resolveLanding')`), and an absence passes
// trivially against text that was never read. So the comment stripper in front of it
// is load-bearing, and the obvious version of it is WRONG on a `.vue` file:
//
//   .replace(/\/\*[\s\S]*?\*\//g, ' ')            // block comments FIRST  ← the bug
//   .split('\n').map(l => l.replace(/\/\/.*$/,'')) // line comments second
//
// `FriendPortalSession.vue:56` carries the LINE comment
//
//     // ⚠ No `@/components/ui/*` import remains in this file. …
//
// whose `/*` opens a block comment that the block-strip then closes at the next `*/`
// — **16 709 characters later** (measured; there is a second such comment at `:2277`).
// Everything in that hole is invisible to every pin built on it. It was found when a
// mutation that mounted a second `<GuestShareDialog>` in that file landed inside the
// hole and the pin stayed GREEN; the reviewer then measured the same hole swallowing
// `portal-shell.spec.js`'s „no plain `<script>` block" and „nothing persisted" pins
// across lines 56–347 of the same file.
//
// Two rules come out of it, and both live here so no spec re-derives them:
//   1. LINE comments are stripped FIRST, so a `/*` inside one can never open a block.
//   2. Every absence pin is preceded by `assertReadable()`, which fails loudly if the
//      strip ate the file. ⚠ ITS REAL GATE IS THE NAMED TOKENS, NOT A LENGTH — and
//      that is a measurement, not a preference. This repo comments heavily, so the
//      surviving fraction is legitimately tiny and varies fourfold:
//
//          lib/portal-state.js   0.166      views/FriendPortal.vue         0.367
//          lib/dates.js          0.290      views/FriendPortalSession.vue  0.372
//          router.js             0.562      views/FriendOrder.vue          0.356
//
//      Any ratio tight enough to catch the 16 709-character hole (which cost
//      `FriendPortalSession.vue` 0.13 of its ratio) red-lines `portal-state.js` on a
//      perfectly good strip — measured, a 0.3 floor did exactly that. So the ratio is
//      a CATASTROPHE backstop only, and the discriminating gate is `mustContain`:
//      tokens picked from the REGION the pins care about. A caller that passes none is
//      refused, because an absence pin with no readability gate is the vacuous thing
//      this helper exists to prevent.
//      A fixed length floor (`> 200`, `> 1000`) is neither: 29 000 surviving characters
//      of a 47 000-character file clear it while a third of the file is gone.
//
// ⚠ Absolute paths are resolved against `frontend/src`, so a run against a deployment
// (no source beside `e2e/`) skips rather than fails — see `HAS_SRC` / `NEEDS_SRC`.

const HERE = dirname(fileURLToPath(import.meta.url))

/** `frontend/src`, or wherever this checkout keeps it. */
export const FRONTEND_SRC = resolve(HERE, '../../frontend/src')
/** False when the suite runs against a deployment rather than a checkout. */
export const HAS_SRC = existsSync(FRONTEND_SRC)
export const NEEDS_SRC = 'needs the frontend source beside e2e/ (skipped against a deployment)'

/** The file, verbatim. */
export function read(relPath) {
  return readFileSync(join(FRONTEND_SRC, relPath), 'utf8')
}

/**
 * The file with COMMENTS removed — a rule about code must not read prose.
 *
 * ⚠ Order: HTML comments, then LINE comments, then BLOCK comments. See the header:
 * reversing the last two lets `ui/*` in a `//` comment swallow a third of the file.
 */
export function code(relPath) {
  return read(relPath)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/**
 * Strip `relPath` and PROVE the result is still the file before anything asserts an
 * absence against it.
 *
 * @param relPath      path under `frontend/src`
 * @param mustContain  tokens that must survive the strip — pick ones from the part of
 *                     the file the pins actually care about, not from line 1.
 * @returns the stripped source
 */
export function assertReadable(relPath, mustContain) {
  // ⚠ Not a default of `[]`: a caller with no tokens has no readability gate, which is
  // precisely the vacuous pin this helper exists to prevent. Refuse it loudly.
  expect(Array.isArray(mustContain) && mustContain.length > 0,
    `${relPath}: assertReadable needs at least one surviving token — see this file's header`).toBe(true)

  const raw = read(relPath)
  const src = code(relPath)

  // Catastrophe backstop ONLY (see the header's measured ratios): this catches „the
  // strip returned almost nothing", not „the strip lost a region". The tokens below
  // are what catch the region.
  expect(src.length / raw.length, `${relPath}: the comment strip returned almost nothing`)
    .toBeGreaterThan(0.05)

  for (const token of mustContain) {
    expect(src, `${relPath}: expected \`${token}\` to survive the strip`).toContain(token)
  }
  return src
}
