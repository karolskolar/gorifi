// The browser origins this deployment serves its own SPA from — ONE home.
//
// Extracted from `index.js` (where it was inline) because there are now TWO consumers
// and they must never disagree:
//   1. the CORS allowlist (`index.js`) — which requests may be made at all;
//   2. `helpers/credentials-message.js` — which `Origin` may be echoed into the login
//      URL of an e-mail we send to a third party.
//
// Consumer 2 is why this is a module and not a local constant: an origin that reaches
// the credential e-mail must be one this app is actually served from, and that fact
// should not depend on a middleware ordering in `index.js` that nothing asserts.
// Override with `CORS_ORIGIN` (comma-separated, full origins including the scheme).
export const allowedOrigins = (process.env.CORS_ORIGIN
  || 'https://gorifi.skolar.sk,https://gorifi-dev.skolar.sk,https://podpultovka.biz,https://www.podpultovka.biz,https://dev.podpultovka.biz,http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
