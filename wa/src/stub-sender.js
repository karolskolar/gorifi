// 21 §UC-WA-011 „WA_SENDER=stub" — the e2e/staging sender (D9: staging runs it unless the
// operator deliberately pairs). No network, no library: `state = 'connected'` at once,
// `number = '+421000000000'`, and every send succeeds except a row addressed to
// `WA_STUB_FAIL_NUMBER` ⇒ `failed`/`stub_fail`. The SAME poll loop, pacing and
// conditional UPDATEs as the real sender drive it — only the delivery is fake.
//
// `WA_STUB_SEND_MS` (TEST SEAM, stub only, default 0): each send takes that long, so a
// spec can finalise the row elsewhere WHILE it is in flight and prove the conditional
// UPDATE's duplicate guard (`[wa] row id=… was finalised elsewhere`). With it set, the
// stub logs `[wa] stub sending id=<id>` when a send starts — ids only.

import { log } from './log.js'

export const STUB_NUMBER = '+421000000000'

export function createStubSender({ stubFailNumber, stubSendMs = 0 }) {
  return {
    name: 'stub',
    async start({ onState }) {
      onState({ state: 'starting' })
      onState({ state: 'connected', number: STUB_NUMBER })
    },
    async send({ id, phoneE164 }) {
      if (stubSendMs > 0) {
        log(`stub sending id=${id}`)
        await new Promise((resolve) => setTimeout(resolve, stubSendMs))
      }
      if (phoneE164 === stubFailNumber) return { ok: false, error: 'stub_fail' }
      return { ok: true }
    },
    async stop() {},
  }
}
