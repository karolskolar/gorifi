# 02 — Design system: "09 Neobrutal PP" port

> Scope: How the Podpultovka "09 Neobrutal PP" design language gets into the existing
> Vue 3 + Vite + Tailwind 3 frontend (`frontend/`): token scoping, the ported stylesheet,
> Google Fonts loading, the Tailwind extension, the shared Vue primitives (brand chrome,
> icons, stepper, checkbox, modal layer, copy row), the layout/z-index/hit-target contract,
> and the per-class port disposition for every class in `theme.css`. This module is the
> foundation the per-screen modules build on and is **inert until consumed** — it changes
> no rendered pixel anywhere on its own. Out of scope (handoffs): per-screen layouts, copy
> and states → `03-friend-login-portal.md` (login/portal), `04-friend-order.md` (friend
> order incl. cat-tabs composition, product cards, vbox, cartbar), `05-colleagues-panel.md`
> (suborder cards, share dialog), `06-guest-flow.md` (guest screens, PaymentModal restyle
> internals — but the modal shell, QR frame and copy-row primitives are defined HERE).
> Actors: Friend (host) and Guest (colleague) — the surfaces this system styles; Admin —
> never sees this system: admin views must remain pixel-identical (hard invariant).
> Sources: `docs/design/friends-portal-redesign/friends/theme.css` (canonical stylesheet —
> every class dispositioned below), `docs/design/friends-portal-redesign/README.md`
> (handoff contract §Design Tokens, §Fidelity, §Interactions, §Assets),
> `docs/design/friends-portal-redesign/friends/ui.jsx` (primitives reference),
> `docs/design/friends-portal-redesign/Podpultovka Friends.html` (prototype shell — font
> URL reference only), `docs/brand/Podpultovka — Brand Brief.md` (wordmark, voice), repo
> `frontend/` (`tailwind.config.js`, `src/style.css`, `src/main.js`, `index.html`,
> `src/components/ui/*`, `src/lib/utils.ts`). The handoff bundle (2026-08) is canonical
> for all visuals; repo code is canonical for behavior. The most recent decision wins.
> **Design reference:** `docs/design/friends-portal-redesign/friends/theme.css` is the
> byte-level reference for every rule; `screenshots/17-shot.png` for the desktop 760px
> centered layout; `screenshots/01/02/03-shot.png` for general look. Open
> `Podpultovka Friends.html` in a browser for the live prototype.

---

## Resolved conflicts (recency / canonicity)

1. **Ticker animation.** README calls `.ticker` a "marquee ticker", but `theme.css` (the
   canonical stylesheet) defines **no `@keyframes` and no `animation`** — the prototype
   ticker is **static** (text repeated 3× inside an `overflow:hidden` bar). Resolution:
   static, no animation. Do not add a marquee.
2. **Font weights.** The prototype shell's Google Fonts URL loads Figtree 900, Darker
   Grotesque 600/700/900, Anton, Inter and Courier Prime italic. README (canonical,
   newer) pins "Darker Grotesque 800, Figtree 400–800, Courier Prime", and a grep of the
   screen sources finds no italic and no weight-900 usage. Resolution: load only the
   weights in UC-DS-003; **Anton and Inter are NOT loaded** (Inter stays as an unloaded
   CSS fallback name; Anton only styles the prototype-only bag placeholder label).
3. **Money format.** Slovak locale would use a decimal comma, but the prototype's `Money`
   primitive renders `v.toFixed(2) + " EUR"` (dot decimal, `EUR` suffix, mono). Prototype
   copy is final (00-overview) — resolution: `12.40 EUR`, dot decimal, on all friend/guest
   surfaces (see UC-DS-012).

---

## UC-DS-001 Port `theme.css` as the scoped stylesheet `friends-theme.css` (Friend, Guest)

**Goal:** the entire canonical stylesheet is available in production, scoped so it can
never affect admin views.

**Preconditions:** none (first task of the effort).

**Main flow:**

1. Create **`frontend/src/friends-theme.css`**. Its content is
   `docs/design/friends-portal-redesign/friends/theme.css` copied **byte-for-byte**,
   then transformed ONLY by the exhaustive adaptation list below. Any other deviation is
   a fidelity bug.
2. Import it in **`frontend/src/main.js`**, immediately **after** `./style.css`
   (`import './friends-theme.css'`). Plain CSS, **no `@layer`**, no `@apply` — a later
   stylesheet with equal specificity wins ties against Tailwind utilities, which matches
   the prototype cascade (theme.css is the prototype's only stylesheet).
3. Do **not** add the `.app` class to any view in this module — applying `class="app"`
   to a view root is each screen module's first step (seam → 03, 04, 05, 06). Until
   then the stylesheet matches nothing.

**Adaptation list (exhaustive — everything else is verbatim; A9 added by RD-DS-5, A10
added by RD-FL-8a and **completed by RD-FL-8b**, the module-03 closeout):**

| # | theme.css original | Ported form | Why |
|---|---|---|---|
| A1 | `*{box-sizing:border-box}` (line 6) | **dropped** | Tailwind preflight already sets it globally; re-declaring globally is redundant, and it must not be admin-visible anyway. |
| A2 | `html,body{margin:0;padding:0;background:#201f1c}` (line 7) | **dropped** | `#201f1c` is the prototype shell's dark surround, not app UI. Global — would repaint admin. |
| A3 | `body{font-family:'Figtree',…}` (line 8) | **dropped** | Global body font would change admin. Friend/guest surfaces get the font from the `.app`/`.modal-layer` token block (`font-family:var(--font-body)` on the scope root), which they already declare. |
| A4 | `a{color:var(--accent,#ff2d87)}a:hover{color:#0a0a0a}` (line 9) | `:where(.app,.modal-layer) a{color:var(--accent)}` `:where(.app,.modal-layer) a:hover{color:#0a0a0a}` | Same rules, scoped. |
| A5 | Every component-class selector from `.mono` (line 27) to `.hstack` (line 224) | prefixed with **`:where(.app, .modal-layer) `** (descendant combinator) | Leak-proofing (see business rules). `:where()` adds **zero specificity**, so every rule keeps its prototype specificity and internal cascade byte-identically. Compound selectors keep their tails: e.g. `.cartbar .actions .btn` → `:where(.app,.modal-layer) .cartbar .actions .btn`. |
| A6 | `.app,.modal-layer{ --nb-ink:… }` token block, `.app{…}`, `.app::before{…}`, `.app>*{…}`, `.modal-layer{…}` | **unprefixed** (they ARE the scope roots) | Tokens must live on the wrappers themselves — `.modal-layer` sits outside `.app` in the DOM (portaled), which is exactly why the token block names both. |
| A7 | `.app{min-height:100%;…}` | `min-height:100vh` | The prototype runs inside a fixed-height device frame; production is a normal document where `100%` resolves to nothing. |
| A8 | `.modal-layer{position:absolute;inset:0;…}` | `position:fixed` | Prototype layers inside the device frame; production must cover the viewport regardless of scroll. Everything else in the modal block (z-index 200, pointer-events dance, scrim, `.modal` widths/borders) is verbatim. |
| A9 | *(not in theme.css)* | **added** at the end of the file: `:where(.app, .modal-layer) .inp, :where(.app, .modal-layer) .btn{line-height:normal}` | **The FIRST addition** (RD-FL-8a's A10 is the second, and is the same defect one layer out). Tailwind preflight ships `button,input,optgroup,select,textarea{line-height:inherit}` on top of `html{line-height:1.5}`; the prototype has neither, so its controls compute the UA default `normal` (~1.2). theme.css's 7 `line-height` declarations govern `.appbar .titles`, `.appbar .titles .t`, `.h-screen`, `.stepper button`, `.cartbar .sum`, `.pimg .lbl`, `.modal .m-title` — **none of them `.inp` or `.btn`**, so the canon is silent and `normal` is what it renders. Without this, `.inp` = 22.5 (1.5×15px) + 24 padding + 6 border = **52.5** vs the canon's 48, and `.btn` = 21 (1.5×14px) + 20 + 6 = **47** vs 44. Scoped to the two classes rather than to `button,input,…` inside `.app`, so shadcn children still rendering in a half-migrated `.app` (UC-DS-002) are untouched; `:where()` keeps the (0,1,0) specificity so `.btn.sm` and every compound variant keep their own cascade. |
| A10 | *(not in theme.css)* | **added** at the end of the file: ONE rule listing the **twenty-six** selectors below (each prefixed `:where(.app, .modal-layer) `) `{line-height:normal}`. **Ten** from RD-FL-8a — `.field-lbl`, `.field-help`, `.sub`, `.appbar .chip`, `.badge`, `.banner`, `.copyrow .val`, `.tab`, `.tbl td`, `.statuspill` — plus **sixteen** completing it in RD-FL-8b: `.ticker`, `.display`, `.mono`, `.neg`, `.zero`, `.stepper .val`, `.vbox .vsize`, `.vbox .vprice`, `.suborder .items`, `.suborder .total`, `.cartbar .deadline`, `.cartbar details summary`, `.cartbar .lines`, `.tbl`, `.tbl th`, `.confirmbox`. | **The second ADDITION, and the same defect as A9 one layer out.** A9 covered the two CONTROL classes; Tailwind preflight's `html{line-height:1.5}` reaches every *other* class the canon leaves silent too. theme.css carries exactly **seven** `line-height` declarations — `.appbar .titles` (33), `.appbar .titles .t` (34), `.h-screen` (44), `.stepper button` (95), `.cartbar .sum` (163), `.pimg .lbl` (186), `.modal .m-title` (193) — and **every selector in this rule is absent from that list**, so the prototype computes the UA default `normal` for all of them. **⚠ MEMBERSHIP IS DEFINED BY A STATIC PASS OVER theme.css, NOT BY A SCREEN SWEEP.** The set is: *every rule declaring `font-size` / `font-family` / `font-weight`, **minus** every rule declaring `line-height`.* That definition is reproducible from the stylesheet alone and does not depend on which screens a module happens to render — which is exactly how the earlier versions of this row went wrong. **A10 shipped twice on a screen sweep and was falsified twice:** RD-FL-8a's first cut covered three plain-text classes and deferred the rest to "the module-03 audit"; its second cut covered ten and asserted *"nothing else in theme.css renders text and is line-height-silent; the sweep behind this table walked every element on all 16 prototype screens"*. **RD-FL-8b's static pass disproved that sentence by thirteen classes** (a prototype screen rendering a class is not the same property as the stylesheet declaring one), and it is struck from this row. **Exclusions — four, and they are exhaustive:** (1) the **`.app` / `.modal-layer` scope root** itself — `:where(.app,.modal-layer){line-height:normal}` would need no class list at all, and was REJECTED because the shadcn subtrees still living inside `.app` (UC-FL-003's untouched legacy login card, the out-of-scope voucher banner) move with it: **measured +5 px per `div.space-y-2` row on the legacy card.** It becomes the right shape the moment those two subtrees are gone. (2) **`.appbar .titles .s`** — text-bearing and silent *itself*, but its parent `.appbar .titles` declares `line-height:1.1`, so it inherits the CANON's value rather than `html`'s 1.5; adding it would be a deviation, not a fix. (3) **`.tabbadge`** — canon 22, port 22, **delta 0** (re-measured by RD-FL-8b): `height:22px` with `display:inline-flex;align-items:center` centres the line box inside a fixed box, so the inherited 1.5 changes nothing measurable. (4) **the four compound variants of an already-covered base** — `.badge.acc` and `.banner.slim` (bases in A10), `.btn.sm` and `.inp.mono` (bases in **A9**) — since `:where()` is (0,1,0), the base selector already reaches them with their own cascade intact; listing them would be noise. **Reproduce the whole set with:** *font-bearing rules* (41) *minus line-height-bearing rules* (9) *minus the 26 + 2 counter selectors* — it yields exactly these eight lines (`.app` and `.app,.modal-layer` being exclusion 1's two). **Measurement method:** identical markup injected into the canon `.app` (prototype over HTTP) and into the built port's `.app`, fonts force-loaded on both sides (`normal` is font-metric driven, so an unswapped webfont silently changes the answer); border-box heights. **canon → port before → delta:** `.appbar .chip` 25 → 28.5; `.badge` 26 → 30; `.banner` 52 → 56.5; `.banner.slim` 40 → 44.25; `.copyrow .val` 42 → 46.75; `.tab` 42 → 45 (the canon's `min-height:42px` stopped governing entirely); `.cat-tabs .tab` / `.tabgroup .tab` 40 → 41; `.tbl td` 46.5 → 50.5; `.statuspill` 36 → 40.25; `.field-lbl` 15 → 18.75; `.field-help` / `.sub` 15 → 19.5 @13px, 21 @14px; `.ticker` 34 → 36; `.display` 24 → 27; `.mono` 15 → 18; `.neg` 28 → 34; `.stepper .val` 27 → 30; `.vbox .vsize` 15 → 19.5; `.vbox .vprice` 24 → 27; `.suborder .items` 112 → 137.5; `.suborder .total` 27 → 30; `.cartbar .deadline` 13 → 16.5; `.cartbar details summary` 16 → 19.5; `.cartbar .lines` 22 → 26.25. `.zero`, `.tbl`, `.tbl th` and `.confirmbox` render on no prototype screen and are included **on static inspection alone** (text-bearing + line-height-silent), on the same basis `.tbl td` and `.statuspill` already were. After the rule the port reproduces the canon **exactly on every measured row**. Every delta is a REDUCTION; nothing here can make a box taller. Knock-on: `.copyrow`'s copy `.btn` was being stretched to 46.75 by the inflated `.val` and returns to its canon 44. **⚠ WHAT THIS RULE STRUCTURALLY CANNOT REACH — binding on 03–06: a class list only covers elements that CARRY a class.** Plain text written in a view's own markup inherits the 1.5 with nothing to override it; the four sites found in module 03 measured **4–13 px** taller than the canon. **Remedy: `line-height:normal` at the call site**, cross-referenced to the A10 block in `friends-theme.css` — do NOT grow this class list to chase them, since there is no class to name. Every module adding markup inside `.app` must check its own unclassed text. Scoped to an explicit class list rather than a blanket `line-height:normal` inside `.app`, on A9's rationale verbatim (see exclusion 1). `:where()` keeps the (0,1,0) specificity so `.mono.sub`, `.badge.acc`, `.banner.slim` and every compound keeps its own cascade — and so does every element declaring its own line-height, which is why `.mono` cannot disturb the cycle-card plan block (inline `1.7`) and `.display` cannot disturb the cycle name (inline `1`) or `.cartbar .sum`. Admin reach is nil **by construction**: `.app` is declared only in `FriendPortal.vue` and `.modal-layer` only in `NeoModal.vue`. Regression-pinned by `e2e/tests/portal-fidelity.spec.js`. |

**Business rules:**

- **Tokens are declared on `.app, .modal-layer` — NEVER on `:root`, never on `body`,
  never in `@layer base`.** The shadcn token set in `style.css` stays where it is.
- **Every component-class rule is scoped with `:where(.app, .modal-layer)`.** The
  concrete forcing case: theme.css defines **`.h-screen` as a display heading**, and
  Tailwind's `h-screen` utility (`height:100vh`) is used across admin views
  (`AdminDashboard.vue`, `CycleDetail.vue`, …). Unscoped, whichever loads later corrupts
  the other. The same risk applies to future admin code using generic names (`.card`,
  `.badge`, `.tab`, `.modal`, `.toggle`). Scoping makes the collision structurally
  impossible instead of convention-guarded.
- Consequence, binding on modules 03–06: **inside `.app`, the class token `h-screen`
  means the heading** — friend/guest templates must use `min-h-screen`-style Tailwind
  utilities only where they cannot collide, and never put Tailwind's `h-screen` on an
  element inside `.app` expecting the height utility.
- The halftone texture ports verbatim as part of this UC: `.app::before` =
  `radial-gradient(circle, rgba(10,10,10,0.55) 0.6px, transparent 1px)`, `background-size:
  5px 5px`, `opacity:.06`, `pointer-events:none`, `z-index:0`; `.app>*{position:relative;
  z-index:1}` keeps content above it. Modules must not flatten `.app`'s children in a way
  that breaks this stacking (any direct child of `.app` is auto-lifted).
- Friend/guest surfaces are **single-theme**: the `.dark` class / `darkMode:['class']`
  mechanism has no effect inside `.app` and no dark variant exists. Do not add one.

**Acceptance criteria:**

- `frontend/src/friends-theme.css` exists; diff against the source `theme.css` shows
  only adaptations A1–A10.
- Measured in a browser against the live prototype served **over HTTP**: `.inp` 48 px,
  `.btn` 44 px, `.btn.sm` 38 px, all at `line-height: normal` — and every `.btn`
  variant (`.sm`, `.ghost`, `.accent`, `.ok`, `.dark`, `.danger`, `.block`) still meets
  UC-DS-005's hit-target minima (`.btn` ≥44, `.btn.sm`/`.btn.ghost` ≥38, inputs ≥46).
- With the stylesheet imported and **no** `.app` class applied anywhere yet, every
  existing route (admin + friend + guest) renders pixel-identically to before.
- A scratch element `<div class="app"><div class="card">x</div></div>` mounted anywhere
  shows: `#fff8f3` background with halftone dots, card with 3px `#0a0a0a` border,
  `border-radius:14px`, `5px 5px 0 #0a0a0a` shadow.
- `grep -c ":where(.app, .modal-layer)"` over the file covers every component-class rule
  (spot-check `.h-screen`, `.btn`, `.modal`, `.cat-tabs::after`).

---

## UC-DS-002 De-collide the shadcn token layer (Admin — invariance)

**Goal:** the three custom-property names that both systems use (`--accent`, `--border`,
`--radius`) stop colliding, so (a) `theme.css` token names port **verbatim** — prototype
inline styles like `color: var(--accent)` can be transcribed 1:1 by modules 03–06 — and
(b) shadcn-styled components still rendering inside `.app` mid-migration don't break.

**Preconditions:** none; independent of UC-DS-001 but must land in the same task.

**Collision analysis (fixed):** shadcn (`style.css`) declares hsl-triplet tokens
`--background, --foreground, --card*, --popover*, --primary*, --secondary*, --muted*,
--accent, --accent-foreground, --destructive*, --border, --input, --ring, --radius`.
theme.css declares full-color tokens `--nb-ink, --bg, --surface, --surface-2, --ink,
--ink-dim, --ink-faint, --accent, --accent-ink, --accent-soft, --hi, --border,
--border-strong, --danger, --danger-soft, --ok, --ok-ink, --ok-soft, --ok-deep, --warn,
--warn-soft, --nav-bg, --nav-ink, --nav-ink-dim, --nav-ink-soft, --radius, --font-body,
--font-display, --font-mono`. **Intersection: `--accent`, `--border`, `--radius` only.**
Without this UC, `hsl(var(--border))` inside `.app` becomes `hsl(#0a0a0a)` — invalid at
computed-value time — and e.g. the `* { @apply border-border }` base rule silently loses
its color for every not-yet-restyled child (GuestSubOrders inside a restyled FriendOrder,
until module 05 lands).

**Main flow — rename the shadcn side (its names are private plumbing; theme.css names are
the canonical deliverable):**

1. In `frontend/src/style.css`, in **both** `:root` and `.dark` blocks, rename:
   `--accent` → `--ui-accent`, `--accent-foreground` → `--ui-accent-foreground`
   (renamed as a pair for coherence), `--border` → `--ui-border`, `--radius` → `--ui-radius`.
   Values unchanged. All other vars (`--input`, `--ring`, `--card`, …) untouched.
2. In `frontend/tailwind.config.js`, update the consumers: `colors.border` →
   `'hsl(var(--ui-border))'`; `colors.accent.DEFAULT/foreground` →
   `'hsl(var(--ui-accent))'` / `'hsl(var(--ui-accent-foreground))'`; all four
   `borderRadius` entries → `var(--ui-radius)`.
3. Verify no other consumer exists: `grep -rn "var(--accent)\|var(--border)\|var(--radius)"
   frontend/src frontend/tailwind.config.js` must return **zero** hits outside
   `friends-theme.css` (a repo grep on 2026-08-07 confirmed no component references these
   vars directly — only `style.css` and `tailwind.config.js` do).

**Business rules:**

- This is a **pixel-no-op for admin**: same values, new plumbing names. Any visible admin
  change is a defect.
- After this UC, `var(--accent)` / `var(--border)` / `var(--radius)` are **owned by the
  Neobrutal token set** and are only defined inside `.app`/`.modal-layer`.
- shadcn utilities (`bg-accent`, `border-border`, `rounded-lg`, …) keep working
  **everywhere, including inside `.app`** (resolving to their admin-gray values) — the
  correct transitional look for not-yet-restyled children.

**Acceptance criteria:**

- The grep in step 3 is clean; `grep -rn "\-\-ui-accent\|--ui-border\|--ui-radius"`
  hits exactly `style.css` (definitions ×2 themes) and `tailwind.config.js` (consumers).
- Before/after screenshots of `/admin` (login) and the admin dashboard are identical.
- e2e suite remains at baseline **238 passed / 3 skipped**.

---

## UC-DS-003 Load the brand fonts from Google Fonts (Friend, Guest)

**Goal:** Darker Grotesque, Figtree and Courier Prime are available to the token stacks
(`--font-display`, `--font-body`, `--font-mono`).

**Main flow:** add to `frontend/index.html` `<head>` (this is the pinned mechanism — a
`<link>`, not a CSS `@import`, so the fetch starts before CSS parse):

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Darker+Grotesque:wght@800&family=Figtree:wght@400;500;600;700;800&family=Courier+Prime:wght@400;700&display=swap" rel="stylesheet">
```

**Business rules:**

- Exact weight set (resolved conflict #2): **Darker Grotesque 800** only (the display
  face is always weight 800, uppercase); **Figtree 400/500/600/700/800** (500 is used by
  `.badge`, 800 by `.appbar .chip`-adjacent bolds); **Courier Prime 400/700** (700 for
  `.neg`, `.tabbadge`). No italics, no 900, **no Anton, no Inter** (see UC-DS-013 →
  `.pimg`).
- `display=swap` is required (text must never be invisible while fonts load).
- **This is the only new external resource the whole redesign adds**
  (01-architecture §Shared services). Any further external URL is out of contract.
- Fonts load globally (index.html is shared with admin) but change nothing visually:
  no admin rule names these families. Admin's `font-family: system-ui,…` in `style.css`
  stays untouched, and Tailwind's default `font-mono` stack is NOT overridden
  (UC-DS-004) — admin's `font-mono` usages keep their current rendering.
- `OPEN:` `index.html` still has `<title>frontend</title>`, `lang="en"` and the Vite
  favicon — all shared with admin, none specified by the handoff bundle. Proposed
  default: leave untouched in this effort; needs an explicit product decision
  (title/favicon would also rebrand the admin tab).

**Acceptance criteria:**

- Network tab on any route shows one `css2?family=…` stylesheet + font files for exactly
  the three families/weight sets above.
- Inside a scratch `.app` element: `.display` renders Darker Grotesque 800 uppercase,
  body text renders Figtree, `.mono` renders Courier Prime.
- Admin routes render identically to before (fonts downloaded but unused there).

---

## UC-DS-004 Tailwind extension + usage conventions for the restyle modules (Friend, Guest)

**Goal:** Tailwind utilities that resolve to the Neobrutal tokens exist under a `pp`
namespace, and the styling conventions modules 03–06 must follow are pinned.

**Main flow:** extend `frontend/tailwind.config.js` `theme.extend`:

```js
colors: {
  // …existing shadcn colors (with --ui-* per UC-DS-002)…
  pp: {
    ink: 'var(--ink)', 'ink-dim': 'var(--ink-dim)', 'ink-faint': 'var(--ink-faint)',
    bg: 'var(--bg)', surface: 'var(--surface)', 'surface-2': 'var(--surface-2)',
    accent: 'var(--accent)', 'accent-ink': 'var(--accent-ink)',
    'accent-soft': 'var(--accent-soft)', hi: 'var(--hi)',
    danger: 'var(--danger)', 'danger-soft': 'var(--danger-soft)',
    ok: 'var(--ok)', 'ok-ink': 'var(--ok-ink)', 'ok-soft': 'var(--ok-soft)',
    'ok-deep': 'var(--ok-deep)', warn: 'var(--warn)', 'warn-soft': 'var(--warn-soft)',
  },
},
fontFamily: {
  display: ['"Darker Grotesque"', 'sans-serif'],
  body: ['Figtree', 'Inter', 'system-ui', 'sans-serif'],
  courier: ['"Courier Prime"', 'monospace'],
},
```

**Business rules:**

- `pp-*` utilities (`text-pp-accent`, `bg-pp-ok-soft`, `border-pp-ink`, …) reference the
  scoped vars **without fallback values** — outside `.app`/`.modal-layer` the var is
  undefined, the declaration is invalid, and the utility is a no-op. That failure mode is
  deliberate: it keeps the palette unusable in admin code by construction. **Admin views
  must never use `pp-*` or `font-display/body/courier` utilities.**
- Tailwind's default `sans`/`mono`/`serif` keys are **not** overridden (admin `font-mono`
  depends on the default).
- **No safelist is needed and none may be added:** every theme component class lives in
  plain CSS (`friends-theme.css`), which Tailwind's content scanner never purges; `pp-*`
  utilities appear literally in templates. Dynamic `:class` bindings must compose from
  full literal class names (standard Tailwind 3 rule).
- Styling conventions for modules 03–06 (binding):
  1. **Theme component classes first** (`class="btn accent"`, `class="card hl"` …) —
     they are the fidelity carrier.
  2. Tailwind utilities for layout/spacing (`flex`, `gap-*`, `mx-auto`, `max-w-[760px]`,
     `p-4`…), and `pp-*` for one-off token colors.
  3. Prototype inline styles (`style={{ marginTop: 12 }}`, `color: "var(--accent)"`)
     transcribe to Vue `:style`/`style` attrs or equivalent utilities — token var names
     are valid verbatim thanks to UC-DS-002.
  4. **`frontend/src/components/ui/*` (shadcn/radix primitives) are admin-only from this
     effort on.** Friend/guest surfaces do not restyle them — they replace them with
     native elements + theme classes and the `neo/` primitives (UC-DS-006…011). No file
     under `components/ui/` is modified by any module of this effort.

**Acceptance criteria:**

- `text-pp-accent` inside `.app` computes `#ff2d87`; the same class outside `.app`
  leaves `color` at its inherited value.
- `font-mono` in admin renders exactly as before the change.
- `frontend && npx vite build` succeeds; no safelist entry added.

---

## UC-DS-005 Layout container, breakpoints, z-index and hit-target contract (Friend, Guest)

**Goal:** the shared geometry every screen module composes against.

**Business rules (all sourced from README §Design Tokens + prototype inline layout +
01-architecture NFRs):**

- **Phone-first 378 px; desktop is the SAME single-column layout centered.** There are no
  `md:` layout forks — only padding may widen. Reference: `screenshots/17-shot.png`
  (desktop 1180px viewport, content centered at 760).
- **Standard page column:** `max-width: 760px`, centered (`margin: 0 auto`),
  `width: 100%`, horizontal padding **16 px on phone, 28 px on desktop** (prototype uses
  16/20 phone, 28/32 desktop per screen — the screen modules pin their exact value; the
  Tailwind idiom is `mx-auto w-full max-w-[760px] px-4 sm:px-7`). Narrow variants used by
  specific screens (login 480, guest confirm/dead-link 520/400) are those modules'
  business (03, 06) — the numbers come from the prototype's inline `maxWidth`.
- **Minimum supported width 320 px with zero horizontal page overflow** — pinned by the
  existing `e2e/tests/mobile-no-h-overflow.spec.js`; the redesign must keep it green.
  Scrollable strips (`.cat-tabs`) scroll **within themselves**.
- **z-index registry (fixed, from theme.css):** `.cat-tabs` sticky top `z-index:40` ·
  `.cartbar` sticky bottom `z-index:50` · `.modal-layer` `z-index:200`. New stacked UI
  must slot into these bands, never above 200 except inside the modal layer.
- **At most ONE sticky bar per screen edge on phones** (01-architecture NFR): `.cat-tabs`
  owns the top edge, `.cartbar` the bottom. The brand chrome (UC-DS-006) is NOT sticky —
  it scrolls away. If a screen needs another persistent control (e.g. the purpose-tab
  switch in FriendOrder), it must scroll away or fold into the existing bar — the screen
  module decides, this rule constrains it.
- **Hit targets:** `.btn` min-height 44 px (`.btn.sm`/`.btn.ghost` 38 px), stepper
  buttons 38×38 px, checkboxes 24 px (`.cbox.big` 32 px), inputs min-height 46 px — all
  already encoded in the ported CSS; screen modules must not shrink them below these
  values with utility overrides.

**Acceptance criteria:**

- A composed test page (any first consuming module) shows: content column ≤760 px
  centered at 1180 px viewport; no horizontal overflow at 320 px; DevTools confirms the
  z-index values above; tap targets measured ≥ the minima.

---

## UC-DS-006 Brand chrome component — `BrandChrome.vue` (Friend, Guest)

**Goal:** one component renders the per-screen header stack: black appbar → 10 px hazard
tape → magenta ticker. Every friend AND guest screen mounts it (guest screens keep full
branding — README).

**File:** `frontend/src/components/neo/BrandChrome.vue`.

**Field group — props, slots & events:**

| API | Type / default | Renders |
|---|---|---|
| `title` prop | String, required unless `#titles` slot used | `.appbar .titles .t` (display font, 25px, uppercase, ellipsis) |
| `subtitle` prop | String, optional | `.appbar .titles .s` (12px, letter-spaced uppercase, dim) |
| `ticker` prop | String, default `"+++ TOVAR POD PULTOM +++ IBA PRE STÁLYCH +++"` | ticker segment text |
| `titlesAction` prop | String, default `''` (amended RD-DS-5) | **opt-in**: makes the `.titles` block interactive. Non-empty ⇒ `role="button" tabindex="0" aria-label="<value>" style="cursor:pointer"` on `.titles` + click/Enter/Space handlers. Empty ⇒ **nothing at all** is added |
| `#leading` slot | optional | before `.titles` — e.g. `.back` arrow (`NeoIcon name="back"` in a `span.back`) |
| `#titles` slot | optional, overrides title/subtitle props | custom titles block (e.g. the wordmark) — **fills** `.titles`, never replaces it |
| `#after-titles` slot | optional (added RD-DS-5) | **between `.titles` and the `.grow` spacer** — the portal's pencil icon (`friends/portal.jsx:101`) |
| `#trailing` slot | optional | after the `.grow` spacer — chips (`span.chip`, `span.chip.acc`), icon buttons |
| `@titles-click` event | emitted only while `titlesAction` is non-empty | fired by click, Enter and Space on the `.titles` block |

**Structure (fixed):**

```html
<div class="appbar">
  <slot name="leading" />
  <div class="titles" v-bind="titlesAttrs">   <!-- titlesAttrs = {} unless titlesAction -->
    <span class="t">{{ title }}</span>
    <span v-if="subtitle" class="s">{{ subtitle }}</span>
  </div>
  <slot name="after-titles" />
  <div class="grow"></div>
  <slot name="trailing" />
</div>
<div class="hazard"></div>
<div class="ticker"><span>{{ seg }}&nbsp;&nbsp;{{ seg }}&nbsp;&nbsp;{{ seg }}</span></div>
```

**Amendment (RD-DS-5) — why the structure gained a fourth slot and a titles affordance.**
Both come from the portal's authenticated appbar (§03 UC-FL-004), which the original
three slots could not express:

- `friends/portal.jsx:97` puts `cursor:pointer` **and an `onClick` on the `.titles` div
  itself**. `.titles` is component-owned and `#titles` *fills* it, so no consumer could
  ever reach it → `titlesAction` + `@titles-click`.
- `friends/portal.jsx:101` puts the pencil **between `.titles` and `.grow`**
  (`screenshots/02-shot.png`: next to "LEGO", not at the right edge). `#trailing`
  renders *after* the spacer and would fling it to the edge, `#leading` is the wrong
  side, and `.titles` is `flex-direction:column` so `#titles` would stack it under the
  name → `#after-titles`.

Everything else this UC pins is unchanged: the fixed appbar → hazard → ticker stack,
`inheritAttrs: false`, the static 3× ticker with two `&nbsp;`, and `#titles` filling
`.titles` rather than replacing it.

**Business rules:**

- **`titlesAction` carries the accessible LABEL, not a boolean.** `.titles` holds the
  friend's name and code, so a bare `role="button"` would announce "LEGO lego-4821,
  button" — the person's name, never the action's. One prop meaning both "interactive"
  and "announced as" makes an unlabelled interactive titles block impossible to ship.
  A `titlesClass` prop was rejected for the mirror-image reason: a class can paint
  `cursor:pointer` but cannot attach a handler, so look and behaviour would be
  separable.
- **The affordance is strictly opt-in and adds ZERO markup when off.** With
  `titlesAction` empty, `.titles` carries no `role`, no `tabindex`, no `aria-label`, no
  `cursor` and no listener — the attributes are bound as one `v-bind` object precisely
  so the inactive case registers nothing (a static `@click` would always attach a
  handler). Pinned by an SSR markup diff against the pre-amendment component.
- **Keyboard operability is the house zero-pixel ARIA enhancement** (as in
  `NeoCheckbox`, `NeoModal`'s `.m-x`, 03's eye toggle): `role`/`tabindex`/`aria-label`
  plus Enter **and** Space, both `preventDefault`ed so Space cannot also scroll.
- The `cursor:pointer` is written **inline**, exactly as the prototype writes it —
  `.titles` has no cursor rule in the canonical stylesheet and `friends-theme.css` is a
  byte-for-byte port (UC-DS-001).
- **No comment may live in `BrandChrome.vue`'s template.** Vue keeps template comments
  in the DOM in dev builds, and this component's rendered markup is a fidelity contract.

- Ticker text is rendered **exactly 3×** inside one `<span>` separated by two `&nbsp;`
  (the `span` carries `padding-right:24px` from CSS). **Static — no animation**
  (resolved conflict #1).
- Per-screen ticker copy is supplied by the screen modules via the `ticker` prop
  (transcribed verbatim from the prototype, e.g. login
  `"+++ VSTUP LEN PRE SVOJICH +++ HESLO NEDÁVAJ ĎALEJ +++"`, order open
  `"+++ OBJEDNÁVKY OTVORENÉ +++ NEHOVOR O TOM NAHLAS +++"`). This module owns only the
  default string above (ui.jsx's default).
- **Wordmark convention** (screens whose appbar title is the brand — login, portal,
  guest screens): the `#titles` slot content is
  `<span class="t">Pod<span style="color:var(--accent)">pult</span>ovka</span>` —
  "POD**PULT**OVKA" with PULT in magenta; uppercasing comes from `.t`'s CSS, do not
  hardcode caps (Brand Brief + README).
- The chrome is **not sticky** (UC-DS-005) and sits as the first child of the screen's
  `.app` root, full-bleed (no page-column padding around it — the column starts below).

**Acceptance criteria:**

- Side-by-side with `screenshots/01-shot.png` (login) and `17-shot.png` (order,
  desktop): black `#0a0a0a` bar with 4px magenta bottom rule; 10px hazard tape of 22px
  magenta/ink stripes with 3px ink bottom border; magenta ticker with ink bottom border,
  display font 14px, uppercase, letter-spaced.
- Rotated accent chip in `#trailing` (`chip acc`) shows −2° rotation, accent-ink border
  and `3px 3px 0` accent-ink shadow.
- `#after-titles` content renders as a sibling **immediately after `.titles` and before
  `.grow`** (DOM order asserted, not just visual).
- A consumer supplying neither `#after-titles` nor `titlesAction` renders **every element,
  attribute, class, text node and computed style identical** to the pre-amendment
  component — identical **modulo the empty-slot fragment anchors** (two empty text nodes
  between `.titles` and `.grow`, exactly as `#leading`/`#trailing` already emit for an
  unused slot). Those anchors form no anonymous flex item and shift no box: verified with
  `.titles` ending at 170 and `.grow` starting at 184, i.e. the single 14px gap and
  nothing more. ⚠ State the caveat when re-running this criterion — a strict whole-DOM
  comparison "fails" on the anchors while nothing is wrong, which would invite either a
  false regression report or a "fix" that removes the slot. With `titlesAction` set,
  `.titles` is reachable by Tab and activates on Enter and Space.

---

## UC-DS-007 Icon set — `NeoIcon.vue` (Friend, Guest)

**Goal:** the 14 inline stroke icons from ui.jsx `I`, as one Vue component.

**File:** `frontend/src/components/neo/NeoIcon.vue`. Props: `name` (String, required),
`size` (Number, optional — overrides the per-icon default below).

**Field group — icon inventory (all `viewBox="0 0 24 24"`, `fill="none"`,
`stroke="currentColor"`, `stroke-linecap`/`join` as in source; path data transcribed
1:1 from `friends/ui.jsx` lines 5–18):**

| name | default size | stroke-width | glyph |
|---|---|---|---|
| `back` | 20 | 2.6 | chevron-left |
| `chev` | 16 | 2.6 | chevron-right (used by `.chev`, rotates 90° via `.chev.open`) |
| `check` | 14 | 3.6 | checkmark (checkbox tick) |
| `share` | 17 | 2.2 | share nodes |
| `gear` | 18 | 2 | settings |
| `pencil` | 16 | 2.2 | edit |
| `logout` | 18 | 2.2 | logout |
| `close` | 18 | 2.6 | × (modal close) |
| `copy` | 15 | 2.2 | copy |
| `lock` | 17 | 2.2 | padlock (locked cycle chip) |
| `cal` | 15 | 2.2 | calendar (deadlines) |
| `invite` | 17 | 2.2 | person-plus |
| `eye` | 17 | 2.2 | password reveal |
| `warn` | 17 | 2.2 | warning triangle |

**Business rules:**

- Color always via `currentColor` — never a fill/stroke prop; consumers set `color`.
- Unknown `name` renders nothing (and logs in dev) rather than throwing.
- No icon font, no external icon package — this component is the only icon source for
  friend/guest surfaces (README §Assets).

**Acceptance criteria:** each icon rendered at default size matches the prototype glyph
(visual check against the running prototype); `stroke-width` per table (the fat 3.6
check inside checkboxes is the giveaway if wrong).

---

## UC-DS-008 Stepper — `NeoStepper.vue` (Friend, Guest)

**Goal:** the quantity stepper used by product variant boxes and carts.

**File:** `frontend/src/components/neo/NeoStepper.vue`.

**Field group:** `modelValue` (Number, required), `min` (Number, default 0), `disabled`
(Boolean, default false), `incDisabled` (Boolean, default false — disables only the "+"
button; module 06 uses it for stock-ceiling states), and optional pass-through testids
`decTestid` / `valTestid` / `incTestid` (String — rendered as `data-testid` on the "−"
button / value span / "+" button so consuming views can keep their pinned e2e hooks,
per module 06 UC-GX-002). Emits `update:modelValue` (v-model compatible).

**Structure:** `div.stepper` (+` disabled` class when disabled) → `button` "−" ·
`span.val` value · `button` "+".

**Business rules:**

- Minus emits `Math.max(min, modelValue − 1)`; plus emits `modelValue + 1`. **No max
  here** — stock-limit ceilings are business logic enforced by the consuming views
  against server availability (existing repo behavior; do not regress it into the
  primitive).
- Buttons are `type="button"` with `aria-label="menej"` / `aria-label="viac"` (verbatim
  from ui.jsx).
- Mutations are instant (README §Interactions: "steppers mutate cart instantly") — the
  primitive emits synchronously on every tap; debouncing/auto-save policy stays in the
  views (CLAUDE.md auto-save rules unchanged).
- When `disabled`, buttons get `pointer-events:none` + 0.35 opacity from CSS
  (`.stepper.disabled`) and the component must also set the `disabled` attribute
  (keyboard/AT correctness). Locked-cycle screens use this (module 04/06).
- Hit target: 38×38 px buttons (from CSS — do not override).

**Acceptance criteria:** v-model round-trips; value below `min` unreachable; value text
in Darker Grotesque 800 at 20px; press physics on buttons (`translate(2px,2px)`,
shadow collapses) visible.

---

## UC-DS-009 Checkbox — `NeoCheckbox.vue` (Friend, Guest)

**Goal:** the neo checkbox (`.cbox`) — subscription toggles (module 03), remember-me
(module 03), the host's big green "Odovzdané" hand-over tick (module 05).

**File:** `frontend/src/components/neo/NeoCheckbox.vue`.

**Field group:** `modelValue` (Boolean, required), `big` (Boolean — 32px variant), `ok`
(Boolean — green checked state instead of magenta), `disabled` (Boolean, default false —
no toggle on click/keyboard, `aria-disabled`, 0.35 opacity; module 05 uses it for
pending/locked hand-over rows). Emits `update:modelValue`.

**Structure:** `span.cbox` (+`.big`/`.ok`/`.on`) containing `NeoIcon name="check"`
(white, stroke-width 3.6; CSS shows it only when `.on`).

**Business rules:**

- Click toggles. Additionally (visual no-op, required for AT): `role="checkbox"`,
  `tabindex="0"`, `aria-checked`, Space/Enter toggle. The prototype's bare
  `span onClick` is the visual contract; the ARIA layer is a permitted enhancement
  because it renders nothing.
- Checked fill: magenta `#ff2d87` default, green `#1f8a5b` with `ok` — the `ok` variant
  is reserved for the delivery/hand-over semantics (green = done/money-good across the
  system: `.btn.ok`, `.badge.ok`, `.banner.ok`).
- The component carries **no label**; consuming screens compose their own label row
  (fold/label click behavior like "whole name block toggles" is screen business —
  module 05).

**Acceptance criteria:** 24px / 32px (`big`) squares with 3px ink border, 6px radius;
tick invisible unchecked; magenta vs green (`ok`) checked fill; keyboard toggling works.

---

## UC-DS-010 Modal layer — `NeoModal.vue` (Friend, Guest)

**Goal:** the single portaled modal shell every friend/guest dialog uses (share, profile,
subscription, invite, pickup, payment, cancel-confirm, checkout, success — composed by
modules 03–06).

**File:** `frontend/src/components/neo/NeoModal.vue`.

**Decision — not radix:** `components/ui/dialog` (radix-vue) stays admin-only
(UC-DS-004 rule 4). `NeoModal` is a plain Vue `<Teleport to="body">` implementation
mirroring ui.jsx `Modal` exactly, because the prototype's behavior surface is small and
pinned, and radix's baked-in animation/data-state classes would fight pixel fidelity.

**Field group:** `title` (String, required), `subtitle` (String, optional — or `#subtitle`
slot for rich content like the payment amount line), `wide` (Boolean — `.modal`
max-width 520px instead of 420px), `closable` (Boolean, default true). Emits `close`.
Slots: default → `.m-body`; `#footer` → `.m-foot` (omitted when empty); `#subtitle`.

**Structure (fixed):**

```html
<Teleport to="body">
  <div class="modal-layer">
    <!-- scrim handlers: see the RD-FL-6 amendment below — the mousedown listener is
         CAPTURE-phase, records `button === 0 && target === currentTarget`, and the
         click handler CONSUMES the flag (sets it false) before closing. -->
    <div class="modal-scrim"
         @mousedown.capture="onScrimMousedown"
         @click.self="onScrimClick">
      <div class="modal" :style="wide ? { maxWidth: '520px' } : null"
           role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <div class="m-head">
          <div style="flex:1;min-width:0">
            <div class="m-title" :id="titleId">{{ title }}</div>
            <div v-if="subtitle || $slots.subtitle" class="sub" style="margin-top:4px">…</div>
          </div>
          <!-- aria-label NORMATIVE — must not CONTAIN "Zavrieť"; see below. -->
          <span v-if="closable" class="m-x" aria-label="Zatvoriť dialóg"
                @click="$emit('close')">
            <NeoIcon name="close" />
          </span>
        </div>
        <div class="m-body"><slot /></div>
        <div v-if="$slots.footer" class="m-foot"><slot name="footer" /></div>
      </div>
    </div>
  </div>
</Teleport>
```

**Business rules:**

- **The tokens ride on `.modal-layer`** — it teleports to `<body>`, OUTSIDE `.app`,
  which is precisely why the token block declares `.app, .modal-layer` (README §Shared
  modals; theme.css line 12). Never "optimize" the teleport away.
- `.modal-layer` is `position:fixed; inset:0; z-index:200; pointer-events:none`; the
  scrim re-enables `pointer-events:auto` and centers via flex with `overflow-y:auto`
  (tall modals scroll within the scrim; `.modal{margin:auto}` keeps short ones centered).
- Scrim click closes **only when the click target is the scrim itself** (`@click.self`)
  and only when `closable`. `Escape` closes under the same condition. When `closable`
  is false there is no ×, no scrim-close, no Esc-close (prototype: `onClose` absent).
- **AMENDMENT (RD-FL-6) — scrim-close additionally requires the gesture to have
  *started* on the scrim.** `@click.self` alone does not mean "the user clicked the
  backdrop": a `click` fires on the nearest common ancestor of its `mousedown` and
  `mouseup`, so a text-selection drag that starts on text inside `.m-body` and
  releases over the scrim delivers a `click` whose target *is* `.modal-scrim` — and
  the dialog closes, discarding whatever the user had typed. The shell carries the
  profile (03 §UC-FL-009), pickup/checkout (04) and guest-identity (06) forms, so
  this is data loss, not a cosmetic quirk. A `mousedown` handler on the scrim
  therefore records whether that press landed on the scrim itself
  (`target === currentTarget`) and `@click.self` closes only when it did; every
  `mousedown` re-computes the flag, and closing consumes it, so a programmatic
  `click` with no press behind it can never dismiss the dialog. This changes
  nothing about a genuine backdrop click, an Esc press, the × or `closable:false`.
  (Implementation may use one handler computing the boolean rather than a
  `.self` setter plus a separate reset — behaviourally identical, with no
  dependence on listener registration order.)
  Three details of that flag are normative, not incidental:
  - **The origin listener runs in the CAPTURE phase.** Bubble-phase, any
    descendant that calls `stopPropagation()` on `mousedown` leaves the flag at
    the previous gesture's value, which re-opens exactly this hazard — and this
    shell is filled by modules 04–06 with checkout, pickup, payment and
    guest-identity content, third-party components included. Capture still fires
    when the scrim itself is the target, so the `target === currentTarget` test
    is unaffected and no descendant can pre-empt it.
  - **Only a PRIMARY button sets the flag** (`button === 0`). A right- or
    middle-click on the scrim must not close the modal — and it emits no `click`
    (middle-click emits `auxclick`), so a non-primary press that set the flag
    would LATCH it with nothing to consume it, handing the permission to some
    later click.
  - **Closing consumes the flag**, so it authorizes at most one dismissal.
- **AMENDMENT (RD-FL-7) — the ×'s accessible name is `"Zatvoriť dialóg"`, and it must
  not CONTAIN the substring `"Zavrieť"`.** The × takes the house zero-pixel ARIA
  enhancement (`role="button"` + `tabindex="0"` + `aria-label` + Enter/Space, per the
  rule above); the *choice of string* is what is normative here.

  Every concrete modal specced on this shell carries a footer `button.btn` labelled
  **exactly** "Zavrieť" — 03 §UC-FL-011 (invite), 05 (share dialog), 06 §UC-GX-005
  (Platba) all pin that word verbatim. Three shipped, **non-editable** specs close the
  payment modal with an unscoped `getByRole('button', { name: 'Zavrieť' })`
  (`guest-status.spec.js:664`, `guest-order.spec.js:865`,
  `guest-lead-capture.spec.js:466`), and 06 §UC-GX-005 names
  `guest-status.spec.js:653–665` as an acceptance criterion **while** mandating that
  footer — so if the × answers to "Zavrieť" too, 06 requires a state that is a
  Playwright strict-mode violation, with no legal escape (06's pin list protects the
  button names). The collision is live today: inside the invite dialog that query
  resolves to 2 elements.

  ⚠ **Why a mere qualifier is not enough, and this is a substring rule rather than an
  inequality:** Playwright matches `getByRole(..., { name })` as a **whitespace-trimmed,
  case-insensitive SUBSTRING** unless the caller passes `exact: true` — and the three
  specs above do not. `aria-label="Zavrieť dialóg"` was therefore tried first and
  **still failed**, resolving to `[<span class="m-x" aria-label="Zavrieť dialóg">,
  <button class="btn">Zavrieť</button>]`. Since those specs cannot be edited to add
  `exact: true` and the × must keep an accessible name, a **synonym** is the only
  remedy: `"Zatvoriť"` is ordinary Slovak for the same action and shares no substring
  with `"Zavrieť"`. Any future rename of either control must preserve that
  non-containment in both directions.

  Scoping the queries instead (`.m-foot`-prefixed) was rejected: it fixes only the
  specs this pipeline may edit and leaves modules 04–06 to trip over the same
  collision. Distinct accessible names for distinct controls is also plainly the
  better screen-reader outcome — "Zavrieť" twice in one dialog names neither. No spec
  queries `.m-x` by name; the two that touch it use the class
  (`portal-profile-modal.spec.js`, `modern-login.spec.js`).
- While open: `document.body` scroll is locked (`overflow:hidden`), focus moves into the
  modal (container `tabindex="-1"` focus on open) and returns to the opener on close.
  Focus handling must add no visual artifact.
- One modal at a time per screen (prototype uses a modal enum). Stacking is not
  supported; the payment-modal-after-success flow (module 06) swaps content, not layers.
- The shells for **Platba** (QR + IBAN + reference copy row) and all other concrete
  modals are composed BY the screen modules from this shell + UC-DS-011/012 primitives;
  their internals (fields, copy, flows) are specced there (→ 03, 04, 06).

**Acceptance criteria:**

- 4px ink border, radius 16, `8px 8px 0 #0a0a0a` shadow, max-width 420/520 (`wide`),
  scrim `rgba(10,10,10,0.5)`, 18px scrim padding — matches `screenshots/05-shot.png` /
  `12-shot.png`.
- Tokens resolve inside the modal (magenta buttons etc.) even though it is outside `.app`.
- Click inside modal body never closes; scrim click / Esc / × close; `closable:false`
  disables all three; background does not scroll while open.
- In a modal whose footer is the specced `button.btn` "Zavrieť", an **unscoped,
  non-exact** `getByRole('button', { name: 'Zavrieť' })` resolves to **exactly one**
  control (the footer button), and the × is reachable as "Zatvoriť dialóg" and still
  closes.
- A text-selection drag that presses inside `.m-body`, moves out and releases over the
  scrim leaves the modal **open** (and its fields untouched); a press-and-release on
  the scrim still closes it.

---

## UC-DS-011 Copy row — `NeoCopyRow.vue` (Friend, Guest)

**Goal:** the link/reference copy control with the 2-second green "Skopírované!" flip
(share link, guest status URL, payment reference, invite link).

**File:** `frontend/src/components/neo/NeoCopyRow.vue`.

**Field group:** `value` (String, required), `small` (Boolean — `.btn.sm` button),
`valueTestid` (String, optional — rendered as `data-testid` on the `.val` element so
consuming views keep their pinned e2e hooks, per module 05 UC-KG-006).

**Structure:** `div.copyrow` → `div.val` (mono 12.5px, single-line ellipsis,
`:title="value"`) + `button.btn` (+` sm` when small, +` ok` while copied).

**Business rules:**

- Button label: **"Kopírovať"** at rest → **"Skopírované!"** for exactly **2000 ms**
  after a successful-or-not `navigator.clipboard.writeText(value)` call (the prototype
  wraps the call in try/catch and flips regardless — keep that: clipboard failures on
  odd browsers must not strand the UI).
- Re-click during the window restarts the 2 s timer (clear the previous timeout — the
  prototype leaks it; the intended behavior is "green for 2 s after the last click").
- While copied, the button gets the `.ok` class (green `#1f8a5b`, white text). No other
  feedback (no toast).
- The truncated `.val` always exposes the full value via `title` and the clipboard —
  never shorten the copied string itself.

**Acceptance criteria:** flip → green → back at 2.0 s; rapid double-click stays green
2 s from the second click; long URL ellipsizes without breaking the row
(`min-width:0` chain intact); clipboard contains the exact `value`.

---

## UC-DS-012 QR frame, snap-tab helper, money convention (Friend, Guest)

**Goal:** the remaining small shared pieces.

**QR frame (`.qr`):**

- The `.qr` class (190×190, 3px ink border, radius 10, white, 10px padding, centered)
  is the frame for the **real** Pay-by-Square QR that `PaymentModal.vue` already
  generates via `bysquare` + `qrcode` (repo canonical for behavior). Module 06 places
  the generated `<canvas>`/`<img>` inside `<div class="qr">` styled `display:block;
  width:100%; height:100%`.
- The `.qr .grid` / `.qr .grid i.on` rules port with the stylesheet but are
  **prototype-placeholder only** — production never renders the pseudo-QR grid. Do not
  port ui.jsx `QRBox`'s cell generator.

**Snap-tab helper:**

- **File:** `frontend/src/lib/snap-tab.js`, exporting
  `export function snapTab(e) { const el = e.currentTarget, p = el.parentNode;
  p.scrollTo({ left: Math.max(0, el.offsetLeft - (p.clientWidth - el.offsetWidth) / 2),
  behavior: 'smooth' }); }` — verbatim math from ui.jsx `window.snapTab`.
- Rule (README §Interactions): tapping a category tab **centers** it in the strip via
  `parent.scrollTo` — explicitly NOT `scrollIntoView` (which scrolls the page
  vertically too). Consumed by `.cat-tabs` (module 04) and the guest grid's tabs
  (module 06).

**Money convention (resolved conflict #3):**

- All money on friend/guest surfaces renders as `value.toFixed(2) + ' EUR'` (dot
  decimal, non-breaking relationship to the unit via `white-space:nowrap`) in Courier
  Prime — either the `.mono` class or `.neg`/`.zero` for signed balance states:
  `.neg` (danger red, bold; `.neg.pill` adds the bordered pill for the portal balance
  card), `.zero` (faint). Large display prices (`.vbox .vprice`, `.cartbar .sum`,
  `.suborder .total`) use the display font per their classes, not mono.
- Implement as a tiny helper if convenient (`fmtEur(v)`), but the format is the
  contract, not the helper. Counts, IDs, references and links are also mono (README:
  "Courier Prime (money, counts, IDs, links, payment references ONLY)") — mono is
  **never** used for running body text.

**Acceptance criteria:** payment modal QR (module 06) shows the real scannable code
inside the neo frame; a cat-tab tap scrolls the strip horizontally only; `0.00 EUR` /
`-12.40 EUR` render per class table above.

---

## UC-DS-013 Component-class inventory — port disposition for every class in `theme.css` (reference)

**Goal:** every class in the canonical stylesheet is accounted for: how it ports and who
consumes it. "Plain CSS" = ported rule used directly in templates; "primitive" = wrapped
by a `neo/` component (CSS still ported); consumers name the module that composes it.

| theme.css block / classes | Ports as | Consumed by |
|---|---|---|
| Token block on `.app,.modal-layer` (incl. `--nb-ink`…`--font-mono`) | plain CSS, unprefixed (UC-DS-001 A6) | all modules |
| `.app` (+`::before` halftone, `>*` lift) | plain CSS; applied to each friend/guest view root | 03, 04, 05, 06 |
| `.mono`, `.display` | plain CSS text utilities | all |
| `.appbar` (+`.back`, `.titles .t/.s`, `.grow`, `.chip`, `.chip.acc`) | primitive: **BrandChrome.vue** (chips/back via slots) | all screens (03–06) |
| `.hazard`, `.ticker` (+`span`) | primitive: **BrandChrome.vue** | all screens |
| `.h-screen` (+`.hl` highlighted words) | plain CSS — screen headline; `.hl` = magenta highlight with 4px ink underline shadow, `box-decoration-break:clone` | 03 (login "Kto klope?"), 06 |
| `.card` / `.card.hl` / `.card.flat` / `.card.dashed` | plain CSS | 03 (cycle cards — open = `.hl`), 04, 05 (empty state = plain `.card` per 05 UC-KG-002; `.dashed` unused there), 06 (guest hero = `.hl`) |
| `.btn` + `.sm/.accent/.ok/.dark/.danger/.ghost/.block/:disabled` (press physics: hover `translate(1px,1px)`+2px shadow, active `translate(3px,3px)`+0 shadow) | plain CSS on `<button>` | all |
| `.badge` + `.solid/.acc(−1.5° rotate)/.acc-o/.danger/.ok/.ok-solid/.warn/.muted` | plain CSS | 03, 04, 05, 06 |
| `.tabs`, `.tab(.on)` | plain CSS | 04, 06 |
| `.tabgroup` (segmented switch), `.tabbadge(.pending)` | plain CSS | 04 (Moja objednávka ⇄ Kolegovia; amber pending count) |
| `.cat-tabs` (sticky top, hidden scrollbar, `scroll-snap-type:x proximity`, right-edge fade via `::after` sticky gradient) | plain CSS + `snapTab` helper (UC-DS-012) | 04, 06 |
| `.stepper` (+`.val`, `.disabled`) | primitive: **NeoStepper.vue** | 04, 06 |
| `.vbox` (+`.vrow/.vsize/.vprice`, `.sel` = ink border + `3px 3px 0` magenta shadow + magenta price) | plain CSS (product-card internals) | 04, 06 |
| `.toggle(.off)` | plain CSS — ported; no prototype screen uses it (share-modal deactivate control renders otherwise); available if a module's screen spec calls for it | — (reserve) |
| `.cbox` (+`.on/.big/.ok`) | primitive: **NeoCheckbox.vue** | 03, 05 |
| `.inp` (+`.mono`), `.field-lbl`, `.field-help` | plain CSS on native `<input>`/`<label>` (no `ui/input`) | 03, 06 |
| `.banner` (+`.dot`, `.ok/.warn/.danger/.slim`) | plain CSS | 04 (submitted/locked banners), 06 (locked/cancelled/error) |
| `.neg(.pill)`, `.zero` | plain CSS money states (UC-DS-012) | 03 (balance card), 05 |
| `.copyrow` (+`.val`) | primitive: **NeoCopyRow.vue** | 03 (invite), 05 (share), 06 (status URL, payment reference) |
| `.suborder` (+`.cancelled` dashed/60%, `.items`, `.foot`, `.total`) | plain CSS | 05 |
| `.cartbar` (+`.meta/.sum/.deadline/.actions`, `details summary` ▸/▾, `.lines .ln`) | plain CSS | 04, 06 |
| `.tbl` (+`th/td`, `.r`), `.sub` | plain CSS; `.tbl` has no consumer in the prototype screens (ported for parity); `.sub` = ubiquitous secondary text | `.sub`: all; `.tbl`: — (reserve) |
| `.pimg` (+`.band/.cap/.lbl`) | plain CSS. Production = **real product photos inside the same 2px-ink rounded frame** (README §Assets): `<img>` inside `.pimg`, `object-fit:cover`. The `.band/.cap/.lbl` stylized-bag internals port but are placeholder-only; **Anton is not loaded** (UC-DS-003), so `.lbl` falls back to sans-serif if ever rendered. ~~`OPEN:` fallback rendering for a product with no uploaded photo (placeholder bag vs. empty frame) — decide in module 04.~~ **RESOLVED (RD-FO-2, 2026-08-08, per 04 §UC-FO-005): the BARE FRAME.** A product with no uploaded photo renders `div.pimg` with its built-in dark gradient and **zero children** — no `.band`/`.cap`/`.lbl` (they encode a per-bag demo colour and want Anton, which UC-DS-003 deliberately does not load) and **no placeholder icon** (the grey photo glyph belonged to the shadcn skin). Pinned by `e2e/tests/order-product-card.spec.js`. Module 06 inherits this decision for `GuestProductGrid.vue` (RD-GX-1). | 04, 06 |
| `.modal-layer`, `.modal-scrim`, `.modal` (+`.m-head/.m-title/.m-x/.m-body/.m-foot`) | primitive: **NeoModal.vue** (UC-DS-010) | 03, 04, 05, 06 |
| `.qr` (+`.grid`) | plain CSS frame; grid = placeholder-only (UC-DS-012) | 06 |
| `.statuspill` (+`.sq`, `.ok/.warn/.off`) | plain CSS | 06 (Zaplatené/Odovzdané pills) |
| `.confirmbox` (+`.row`) | plain CSS inline destructive-confirm | 05 (remove sub-order), 06 (cancel), 05 (regenerate link) |
| `.chev(.open)` | plain CSS + `NeoIcon name="chev"` | 03 (archive fold), 05 (suborder fold) |
| `.divider`, `.stack`, `.hstack` | plain CSS layout helpers | all |

**Business rules:**

- This table is exhaustive against `theme.css` as of the 2026-08 bundle. If the bundle
  is ever re-exported, re-diff and extend the table — a class with no disposition row is
  a spec gap.
- "Reserve" classes (`.toggle`, `.tbl`, `.qr .grid`, `.pimg` internals) still port
  (byte-parity keeps future diffs of `friends-theme.css` against the canon trivial);
  they simply have no production consumer yet.
- Semantic color grammar (binding across modules): **green** `ok` = paid/done/positive
  action confirm · **amber** `warn` = pending/attention/locked-info · **red/danger** =
  negative money, destructive, cancelled, Packeta stays out of this system (admin-side
  badge only) · **magenta accent** = brand, selection, primary action · dashed border +
  reduced opacity = cancelled/muted.

---

## UC-DS-014 Verification: inertness, admin invariance, fidelity procedure (Admin, Friend, Guest)

**Goal:** how the implementing task proves this module correct, and how consuming modules
prove fidelity later.

**Business rules / procedure:**

1. **Inertness:** module 02 alone (UC-DS-001…012 landed, no screen restyled) changes no
   rendered pixel on ANY route. Proof: before/after screenshots of at least `/` (friend
   portal), `/admin` (login) and one authenticated admin page — visually identical
   (byte-identical is not required; font files now load, but nothing renders in them).
2. **Admin invariance is permanent:** every later task of this effort re-asserts that
   admin views don't reference `pp-*` utilities, `neo/` components, or theme classes,
   and that `friends-theme.css` contains no unprefixed component selector
   (`grep -n "^\.\|^[a-z]" frontend/src/friends-theme.css` — every component-class rule
   line starts with `:where(.app, .modal-layer)` except the A6 scope-root rules).
3. **e2e gate:** the Playwright suite stays at baseline **238 passed / 3 skipped**
   (01-architecture §Testing). Module 02 touches no behavior, so zero spec updates are
   expected; a failing spec means a leak.
4. **Build gate:** `cd frontend && npx vite build` green; no new packages (UC-DS-006…011
   are dependency-free; `bysquare`/`qrcode`/`radix-vue` already present).
5. **Fidelity procedure for consuming modules (03–06):** manual comparison — Playwright
   screenshot of the restyled screen at **378 px** viewport width (and 1180 px for the
   desktop check against `17-shot.png`) placed side-by-side with the matching
   `screenshots/NN-shot.png`, plus the live prototype for interactive states. There is
   **no visual-regression CI** — pixel fidelity is a human check, recorded in the task's
   PR. Tokens, borders, shadows and type must match to the pixel (README §Fidelity:
   "recreate pixel-perfectly").
6. **Primitive smoke coverage:** because primitives are unused until 03–06, this module
   needs no new e2e spec. The FIRST consuming module's e2e specs double as the
   primitives' regression net (seam: 03 covers BrandChrome/NeoModal/NeoCopyRow/
   NeoCheckbox/NeoIcon via login+portal; 04 covers NeoStepper/snapTab).

**Acceptance criteria:** items 1–4 pass in the module-02 task itself; items 5–6 are
inherited obligations written into modules 03–06.

---

## Deliverables summary (files this module creates/edits)

| Path | Action |
|---|---|
| `frontend/src/friends-theme.css` | new — ported stylesheet (UC-DS-001) |
| `frontend/src/main.js` | edit — import after `style.css` (UC-DS-001) |
| `frontend/src/style.css` | edit — `--ui-*` renames only (UC-DS-002) |
| `frontend/tailwind.config.js` | edit — `--ui-*` consumers + `pp` palette + fontFamily (UC-DS-002/004) |
| `frontend/index.html` | edit — Google Fonts links (UC-DS-003) |
| `frontend/src/components/neo/BrandChrome.vue` | new (UC-DS-006) |
| `frontend/src/components/neo/NeoIcon.vue` | new (UC-DS-007) |
| `frontend/src/components/neo/NeoStepper.vue` | new (UC-DS-008) |
| `frontend/src/components/neo/NeoCheckbox.vue` | new (UC-DS-009) |
| `frontend/src/components/neo/NeoModal.vue` | new (UC-DS-010) |
| `frontend/src/components/neo/NeoCopyRow.vue` | new (UC-DS-011) |
| `frontend/src/lib/snap-tab.js` | new (UC-DS-012) |

Nothing under `frontend/src/components/ui/` or `frontend/src/views/` is modified by this
module.
