// Google Identity Services script loading — the ONE home (10 §UC-GA-012).
//
// Every surface that renders a Google control (UC-GA-005 friend login, UC-GA-008
// invite registration, the UC-GA-007 profile modal, UC-GA-009/010 admin) imports
// `loadGis` from here. Nothing else may inject the GIS script.
//
// ⚠ NEVER from `index.html`. GIS is the app's ONE sanctioned CSP exception
// (01 §Integrations) and the exception is kept honest by WHERE the script loads:
// a `<script>` in the document head would fire on every route, including
// `/g/:token` and `/magic/:token`. Guests never see Google — `self-hosted-fonts.spec.js`
// pins `/g/:token` at ZERO non-same-origin requests, and this module is the only
// reason that assertion can keep holding once buttons ship.
//
// ⚠ The CSP must already permit this URL. `deploy/nginx-gorifi.conf` and
// `deploy/nginx-gorifi-staging.conf` carry (six identical lines):
//   script-src  … https://accounts.google.com/gsi/client
//   frame-src       https://accounts.google.com/gsi/
//   connect-src …   https://accounts.google.com/gsi/
//   style-src   …   https://accounts.google.com/gsi/style
// per Google's published guidance, verified 2026-08-16:
// https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid
//
// ⚠ Module scope here is REAL. This is a plain `.js` module, so `pending` below is
// a genuine singleton — unlike a `const` at the top of a `<script setup>` block,
// which the compiler moves inside `setup()` and therefore recreates per component
// instance (the ML-T3 hazard: a "single-shot" guard that silently ran twice and
// spent a one-time login credential). Any dedupe of this kind belongs in a module
// like this one, never in an SFC.

const GIS_SRC = 'https://accounts.google.com/gsi/client'

// Generous, because this races a real network on a phone — but FINITE, which is the
// whole point. A login screen that waits forever on a blocked Google is worse than
// one that shows the password form.
const DEFAULT_TIMEOUT_MS = 10000

// How often to re-check for the namespace after `onload`. It is normally present
// immediately; this only covers a script that loaded but has not finished defining
// itself.
const POLL_MS = 50

// The single in-flight/settled load. Reset to null on failure so a friend who lost
// their connection for one second is not locked out of Google for the life of the
// page.
let pending = null

function namespace() {
  return (typeof window !== 'undefined'
    && window.google
    && window.google.accounts
    && window.google.accounts.id) || null
}

/**
 * True once `window.google.accounts.id` is available. Call sites that need to
 * render synchronously (e.g. re-rendering a button after a modal reopens) can use
 * this instead of awaiting again.
 */
export function isGisReady() {
  return namespace() !== null
}

/**
 * Load the Google Identity Services client.
 *
 * @param {string|null|undefined} googleClientId - from `GET /api/friends/auth-mode`
 *   (`googleClientId`, GA-T2). Falsy means the deployment has no Google configured.
 * @param {{timeoutMs?: number, src?: string}} [options] - ⚠ options apply only to
 *   the call that STARTS the load. A concurrent second caller gets the in-flight
 *   promise built with the first caller's `timeoutMs`/`src`, and its own options
 *   are ignored. Harmless while every call site takes the default; if a surface
 *   ever needs a genuinely shorter deadline (a login screen that must fall back
 *   fast), give it its own race rather than assuming this argument wins.
 * @returns {Promise<object|null>} resolves with `window.google.accounts.id`, or
 *   `null` when Google is not configured. Rejects when the script cannot be
 *   loaded or never initialises — callers must catch and fall back to the
 *   password form (the UI copy is theirs; this layer throws technical errors).
 */
export function loadGis(googleClientId, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, src = GIS_SRC } = options

  // ⚠ THE NO-OP PATH, and it is load-bearing. UC-GA-012 requires this so call
  // sites need no separate `if (googleClientId)` guard — one forgotten guard is
  // how an unconfigured deployment would start contacting Google. Resolving
  // `null` (rather than rejecting) keeps `await` call sites on their happy path:
  // "no Google configured" is a normal state, not an error.
  if (!googleClientId) return Promise.resolve(null)

  const ready = namespace()
  if (ready) return Promise.resolve(ready)

  // Idempotent: concurrent callers (a login card and a prompt modal can mount in
  // the same tick) share ONE promise and ONE script tag.
  if (pending) return pending

  pending = new Promise((resolve, reject) => {
    let timer = null
    let poll = null
    let settled = false

    // Reuse a tag that somehow already exists rather than adding a second one;
    // otherwise this is the only place a GIS tag is created.
    const existing = document.querySelector(`script[src="${src}"]`)
    const script = existing || document.createElement('script')

    const cleanupTimers = () => {
      if (timer !== null) { clearTimeout(timer); timer = null }
      if (poll !== null) { clearInterval(poll); poll = null }
    }

    const succeed = (ns) => {
      if (settled) return
      settled = true
      cleanupTimers()
      resolve(ns)
    }

    const fail = (message) => {
      if (settled) return
      settled = true
      cleanupTimers()
      // Remove the dead tag and clear the singleton so a later attempt starts
      // clean. Without this a transient failure would be cached for the life of
      // the page and the friend could never retry.
      script.remove()
      pending = null
      reject(new Error(message))
    }

    const checkReady = () => {
      const ns = namespace()
      if (ns) succeed(ns)
      return ns !== null
    }

    // ⚠ Idempotent by construction. Two call sites below can both want polling —
    // the `existing`-tag branch starts it, and that same tag's `load` event may
    // then fire with the namespace still absent. A plain `poll = setInterval(…)`
    // in both places ORPHANS the first interval: `cleanupTimers()` only holds the
    // latest handle, so the first one runs `checkReady` every 50ms for the life of
    // the page, immune to cleanup. Unreachable today (it needs a GIS tag this
    // module did not inject, which the "ONE home" test forbids), but it is exactly
    // the branch a future refactor trips over.
    const startPolling = () => {
      if (poll === null) poll = setInterval(checkReady, POLL_MS)
    }

    script.addEventListener('load', () => {
      // Normally ready immediately; poll for the pathological case rather than
      // resolving with an undefined namespace the caller would then crash on.
      if (!checkReady()) startPolling()
    })

    // A blocked, offline or CSP-refused script. Degrade, do not hang.
    script.addEventListener('error', () => fail(`Failed to load Google Identity Services from ${src}`))

    // ⚠ The timeout is NOT redundant with the error handler. The nastier failure is
    // a 200 response that never defines `window.google` — a captive portal, a
    // corporate proxy serving an interstitial, a half-rolled-out GIS build. There
    // `onload` fires and `onerror` never does, so only this timer ends the wait.
    timer = setTimeout(() => fail(`Timeout loading Google Identity Services after ${timeoutMs}ms`), timeoutMs)

    if (existing) {
      // The tag may have finished loading before we attached the listener above.
      if (!checkReady()) startPolling()
    } else {
      script.src = src
      script.async = true
      script.defer = true
      document.head.appendChild(script)
    }
  })

  return pending
}
