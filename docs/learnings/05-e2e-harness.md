# E2E harness traps — running playwright from the wrong cwd

> Moved verbatim out of `CLAUDE.md` on 2026-09-03 (it had grown to 153 KB). These are the full per-task learnings; the load-bearing rules are summarised in `CLAUDE.md` → Hard rules. **Append new learnings for this area HERE, and add only the one-line rule to `CLAUDE.md`.**

### ⚠ Running playwright from the repo ROOT is a FALSE-GREEN vector (GA-T10, 2026-08-17)

`npx playwright test` **must** be run from `/home/karolskolar/projects/gorifi/e2e`. From the
repo root it resolves a **second** `@playwright/test`, dies with *"did not expect
test.beforeAll() to be called here"*, and reports **`Error: No tests found`** — which a
script checking only for `✘` lines reads as a clean run. A GA-T10 mutation probe
"passed" that way and proved nothing; both affected runs had to be redone.

⚠ The general form: **`No tests found` is not a pass.** Any wrapper that greps for
failures must also assert a non-zero test count, or a wrong cwd, a bad `-g` filter and a
typo'd path all look identical to success.

⚠ **And the failure GLYPH is REPORTER-DEPENDENT — never grep for it alone** (measured on
this repo's Playwright 1.61, GR-T4): **`list`** (the config default,
`e2e/playwright.config.js:18`) emits `✓` / `✘` / `-`; **`line`** emits **no glyphs at
all** — progress as `[k/n]`, failures as `1) [chromium] › …`; **`dot`** emits `·` / `F`
/ `°` and no `✘`. A `grep -c "✘"` therefore returns **0 on a run with real failures**
under `line` or `dot`. The reporter-independent check is the summary: assert there is no
`N failed` line **and** that an `N passed` with N > 0 exists. Same class as the rule
above — a green-looking wrapper that measured nothing.


