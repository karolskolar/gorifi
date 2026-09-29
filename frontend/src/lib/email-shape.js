// 20 §UC-GP-003 item 4 — the CLIENT mirror of `backend/src/helpers/mailer.js
// EMAIL_SHAPE`, the ONE server home of „is this plausibly an e-mail address?".
//
// ⚠ A MIRROR, NOT A SECOND OPINION. The server's Packeta checkout gate (GP-T1) and the
// confirmation mail's send gate both test that regex; the guest's screen must refuse
// exactly what the server would refuse, or the guest meets a server 400 the page could
// have prevented (or, worse, is blocked by a stricter client for an address the server
// would take). `guest-packeta.spec.js` imports BOTH files in node and compares
// `source` + `flags` byte for byte — edit them together or the gate goes red.
//
// Dependency-free on purpose (plain `node` imports it — the `lib/cycle-stages.js`
// precedent). Consumers: `views/GuestOrder.vue` (checkout); GP-T4's edit mode on
// `views/GuestOrderStatus.vue` imports the same constant — never a local copy.
export const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/
