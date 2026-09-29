// Product switches — one home for features the PO has parked but not removed.
//
// ⚠ DEPENDENCY-FREE PLAIN ESM, so a Playwright spec can `import()` it and skip the
// tests of a parked feature off THE SAME value the app reads (never a second copy).

/**
 * Module 19's STANDING guest link („Stály odkaz pre kolegov") on the FRIEND surface.
 *
 * `false` — PO 2026-09-29: parked until module 21's WhatsApp notifications ship,
 * because the standing link's pre-open waitlist promises a WhatsApp message nobody
 * sends yet. While it is off:
 *   · `GuestShareDialog.vue` renders only the per-cycle section, never READS
 *     `GET /guest-links/standing` (that read MINTS the token lazily), and its
 *     „Zdieľať odkaz" shares the per-cycle URL;
 *   · the drawer's „Zdieľať s kolegami" row is back to `state === 'open'` only
 *     (on locked/closed the dialog would have nothing left to show).
 * The backend routes, the admin FriendDetail card and existing standing tokens are
 * untouched — a URL already handed out keeps working.
 */
export const STANDING_GUEST_LINK = false

/**
 * Module 19's pre-open WAITLIST FORM on the guest page („Daj mi vedieť" + the WhatsApp
 * consent). `false` — PO 2026-09-29, same reason as above: it promises a WhatsApp
 * message module 21 does not send yet. It is still reachable without the standing
 * link: a per-cycle link opened after its round closed lands on the stale pre-open
 * page. While it is off, `GuestOrder.vue` renders neither the form nor the „Dáme
 * vedieť" success banner; the rest of the pre-open page (hero, steps, next-round
 * sentence, preview) stays. The public signup route is untouched.
 */
export const GUEST_WAITLIST = false
