// 21 §UC-WA-011 — THE ONE SENDER INTERFACE (R5.6's „pluggable sender" survives only as
// this: one interface, ONE real implementation, plus the stub — resolved conflict 1).
//
//   sender.name                       'whatsapp' | 'stub'
//   await sender.start({ onState })   begin connecting; every transition is reported as
//                                     onState({ state, number?, qrText?, error? })
//                                       state ∈ starting | qr | connected | disconnected | auth_failure
//                                       (`paused` is NOT a sender state — the loop overlays
//                                       it from `settings.whatsapp_paused`)
//   await sender.send({ id, phoneE164, body })
//                                     ⇒ { ok: true }                 — delivered to WhatsApp
//                                     ⇒ { ok: false, error: <code> } — a KNOWN refusal
//                                        (`not_on_whatsapp`, `stub_fail`)
//                                     throws on anything else ⇒ the loop stores
//                                        `failed` / `<name>: <message ≤ 300>`
//   await sender.stop()
//
// ⚠ NO static import of `whatsapp-web.js` / puppeteer anywhere in `wa/`: the whatsapp
// sender loads its library with a dynamic `import()` INSIDE its own `start()`, so
// `WA_SENDER=stub` runs on a box with no Chromium and no whatsapp-web.js installed
// (21 §UC-WA-011 „WA_SENDER=stub", 01-architecture §Testing & gate).

import { createStubSender } from './stub-sender.js'
import { createWhatsappSender } from './whatsapp-sender.js'

export function createSender(config) {
  if (config.sender === 'stub') return createStubSender(config)
  return createWhatsappSender(config)
}
