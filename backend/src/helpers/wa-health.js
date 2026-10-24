// 21 §UC-WA-008 / §UC-WA-012 (WA-T5) — the API's ONE reader of the `gorifi-wa` process's
// health endpoint. WA-T5 uses it for the wa.me tick's duplicate-send guard (`PATCH
// /api/notifications/:id/manual-sent` on a `released` row ⇒ 409 `bot_active` while the bot
// is connected); ~~WA-T8's~~ WA-T7's `GET /api/admin/whatsapp/health` proxy
// (`routes/admin.js`) reuses `fetchWaHealth()` — no second fetch exists.
//
//   URL      `${WA_HEALTH_URL}/health`, `WA_HEALTH_URL` default `http://127.0.0.1:3010`
//            (21 §UC-WA-012; staging sets `:3011`). Read at CALL time, so the e2e gate
//            server can point it at a stub (`e2e/README.md`).
//   timeout  2 s (`AbortSignal.timeout`), redirects refused.
//   result   `{ reachable: true, ...health }` only for a 200 whose body is a JSON
//            OBJECT; anything else — refused connection, timeout, non-200, non-JSON, a
//            JSON array/scalar — is `{ reachable: false }`.
//
// ⚠ NEVER THROWS and NEVER LOGS (the health body carries the pairing QR while
// `state = 'qr'` — a credential; 21 §UC-WA-012).
//
// ⚠ An `await` of this inside a handler BREAKS the `instances: 1` check-then-write
// atomicity (CLAUDE.md, GA-T8): the caller must re-read / re-assert its row AFTER the
// await — `helpers/outbox.js markManualSent()` does it in its UPDATE's WHERE.
//
// ⚠ Deliberately the spec's DEFAULT when the env is unset, not „unset ⇒ not connected":
// the guard exists to stop a duplicate send, and a production `.env` that forgot the key
// must still find the bot on its documented port rather than silently disable the guard.

export const DEFAULT_WA_HEALTH_URL = 'http://127.0.0.1:3010';
export const WA_HEALTH_TIMEOUT_MS = 2000;

export function waHealthUrl() {
  const raw = typeof process.env.WA_HEALTH_URL === 'string' ? process.env.WA_HEALTH_URL.trim() : '';
  return `${(raw || DEFAULT_WA_HEALTH_URL).replace(/\/+$/, '')}/health`;
}

/** The health of the WA process: `{ reachable: false }` or `{ reachable: true, ...body }`. */
export async function fetchWaHealth({ timeoutMs = WA_HEALTH_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(waHealthUrl(), {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (res.status !== 200) return { reachable: false };
    const body = await res.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { reachable: false };
    return { ...body, reachable: true };
  } catch (e) {
    return { reachable: false };
  }
}

/** Is the bot CONNECTED right now? Unreachable / anything but `state: 'connected'` ⇒ false. */
export async function botConnected(options) {
  const health = await fetchWaHealth(options);
  return health.reachable === true && health.state === 'connected';
}
