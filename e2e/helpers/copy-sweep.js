// ONE HOME for the rendered-COPY sweep: "does this page's own wording say X?"
//
// ⚠ WHY THIS LIVES OUTSIDE `tests/`. `playwright.config.js` sets `testDir: './tests'`,
// so a module here is imported by specs and never collected as one (a file under
// `tests/` with no `test()` in it fails the run outright) — the `qr-pixels.js`
// precedent.
//
// ── WHAT IT COLLECTS ─────────────────────────────────────────────────────────
// Everything a human reads on the page: `document.body.innerText` PLUS the
// attributes that render as copy (`placeholder`, `title`, `aria-label`, `alt`).
// The attribute half is NOT redundant — the original "Prihlasovacie meno" lie lived
// in a table header, a `Label`, AND a `placeholder=`, and a partial fix that leaves
// the placeholder behind is invisible to `innerText`. Do not "simplify" it away.
//
// ── WHAT IT DELIBERATELY DOES NOT COLLECT, AND WHY (FUP-T22) ─────────────────
// A copy sweep asserts what the APPLICATION calls something. It is not an assertion
// about the DATA the app renders — a friend's name, an admin's internal note, a
// contact address, a product title are all strings a PERSON typed, and a person may
// type anything.
//
// That is not hypothetical. `e2e/fixtures/prod-template.sqlite` (GR-T9's
// production-shaped template, names KEPT by PO decision) carries an active friend
// whose NAME is literally `Prihlasovacie.meno` — someone once typed the mislabelled
// field's own label into it, which is the original bug's fossil. Rendering that row
// made `admin-friends-labels.spec.js`'s sweep red on DATA, and no code change could
// make it green while the row rendered (PL-T4's module-15 closeout measured
// 1841 passed / 1 failed on exactly this).
//
// So a view marks the elements that render person-supplied values with
// `data-user-copy`, and this collector drops those SUBTREES — text and attributes
// alike — before matching. It excludes by DOM subtree rather than by subtracting the
// known values as strings, because subtraction has a hole this does not: a friend
// named exactly like a real mislabel would silently mask a genuine defect.
//
// ⚠ THE EXCLUSION MUST STAY NARROW. Mark the interpolation, never the cell around
// it: `Bez e-mailu`, `Neúplné`, `dočasné heslo` and every `title=` beside them are
// the app's OWN copy, sitting in the same cells as the data, and they are exactly
// what the guard exists to read. A `data-user-copy` that swallows app copy is a hole
// in the guard, not a fix.
//
// ⚠ FAILURE DIRECTION. Forgetting the marker on a new data field makes the sweep
// read that data and, one unlucky name later, go RED — loud and false. Narrowing the
// regex to make such a failure go away is the one forbidden repair: mark the data
// render instead. (A sweep that matched real copy and was then "fixed" by narrowing
// is the shape of the bug the whole guard exists for.)
//
// ⚠ IMPLEMENTATION NOTE. The marked subtrees are hidden with an inline
// `display:none` for the duration of the read and restored in a `finally`, so the
// collector keeps exact `innerText` semantics (which honour `text-transform` — the
// standing CLAUDE.md trap — and skip invisible text) instead of approximating them
// with a `textContent` walk that would also start sweeping hidden markup and
// `<script>` bodies. The mutation is inline style only: Vue owns no reactive state
// here, so nothing re-renders, and the page is discarded at the end of the test.

// ⚠ NO EXPORTED CONSTANTS FOR `data-user-copy` OR THE ATTRIBUTE LIST, ON PURPOSE.
// Only the FUNCTION BODY is serialized into the page, so a module-level reference
// would arrive `undefined` there — a shared constant here would look like one home
// while every collector still had to inline its own copy. The literals therefore live
// inline, and they move TOGETHER: the selector `[data-user-copy]` appears in
// `collectAppCopy` (twice) and `collectMarkedData`, and the attribute list
// `['placeholder', 'title', 'aria-label', 'alt']` in `collectAppCopy` and
// `collectAllCopy`. Change one, change all of them — and the specs that pass the
// selector to their own `page.evaluate` (`admin-friends-labels.spec.js`) too.

/**
 * The app's own copy on the page right now: visible text + copy attributes, with
 * every `[data-user-copy]` subtree removed.
 *
 * Returns the function to hand to `page.evaluate()` (the established idiom in these
 * specs), so: `const copy = await page.evaluate(collectAppCopy())`.
 */
export function collectAppCopy() {
  return async () => {
    const marked = Array.from(document.querySelectorAll('[data-user-copy]'))
    const saved = marked.map((el) => el.style.display)
    for (const el of marked) el.style.display = 'none'
    try {
      const out = [document.body.innerText]
      for (const el of document.querySelectorAll('*')) {
        if (el.closest('[data-user-copy]')) continue
        for (const attr of ['placeholder', 'title', 'aria-label', 'alt']) {
          const v = el.getAttribute(attr)
          if (v) out.push(v)
        }
      }
      return out.join('\n')
    } finally {
      marked.forEach((el, i) => {
        el.style.display = saved[i]
      })
    }
  }
}

/**
 * The UNFILTERED sweep — app copy AND person-supplied data. Only for proving, in a
 * test, that the data really is on the page and really was excluded (the
 * non-vacuity gate for the exclusion itself). Never assert an absence against this:
 * that is the false positive `collectAppCopy()` exists to prevent.
 */
export function collectAllCopy() {
  return async () => {
    const out = [document.body.innerText]
    for (const el of document.querySelectorAll('*')) {
      for (const attr of ['placeholder', 'title', 'aria-label', 'alt']) {
        const v = el.getAttribute(attr)
        if (v) out.push(v)
      }
    }
    return out.join('\n')
  }
}

/**
 * The texts the page has marked as person-supplied, longest first. Used to derive
 * the exclusion's non-vacuity gate from the page itself rather than hardcoding a
 * fixture row (the suite is target-agnostic — the same file runs against staging).
 */
export function collectMarkedData() {
  return async () => {
    return Array.from(document.querySelectorAll('[data-user-copy]'))
      .map((el) => (el.innerText || '').trim())
      .filter((t) => t.length > 0)
      .sort((a, b) => b.length - a.length)
  }
}
