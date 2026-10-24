// 21 §UC-WA-011 — the REAL sender (whatsapp-web.js `LocalAuth` + headless Chromium).
//
// ⚠⚠ NOT IMPLEMENTED IN WA-T9 — it is WA-T10's (PROGRESS, BLOCKED on the bot number and the
// LXC resize). What exists here is the SHAPE WA-T10 fills, and the one property WA-T9 must
// already guarantee: the library is reached ONLY through the dynamic `import()` below,
// inside `start()`, so nothing in `wa/` loads whatsapp-web.js or puppeteer unless
// `WA_SENDER=whatsapp` (the default) actually starts — the stub never does.
//
// Until WA-T10, `start()` reports `disconnected` with `error = 'sender_not_implemented'`
// (or `whatsapp_web_js_missing` when the optional peer is not installed — it is declared
// as an OPTIONAL peer in `wa/package.json`, so `npm ci` does not download Chromium yet).
// The health server stays up, the loop never sends (it sends only while `connected`), and
// every released row simply stays `released` — exactly the „bot down" picture the admin
// already handles with the wa.me tab.
//
// WA-T10 contract (21 §UC-WA-011): `new Client({ authStrategy: new LocalAuth({ dataPath:
// config.sessionDir }), puppeteer: { args: ['--no-sandbox', '--disable-dev-shm-usage'] } })`;
// `qr` ⇒ onState({ state: 'qr', qrText }) (index.js renders the data URL with `qrcode`);
// `ready` ⇒ onState({ state: 'connected', number: '+' + client.info.wid.user });
// `disconnected` ⇒ backoff 5·10·20 s … ≤ 5 min; `auth_failure`/LOGOUT ⇒ stop sending,
// onState({ state: 'auth_failure' }); send() = getNumberId() null ⇒ { ok: false, error:
// 'not_on_whatsapp' }, else client.sendMessage(chatId, body) ⇒ { ok: true }.

import { log, logError } from './log.js'

export function createWhatsappSender(/* config — WA-T10: sessionDir, … */) {
  return {
    name: 'whatsapp',
    async start({ onState }) {
      onState({ state: 'starting' })
      try {
        await import('whatsapp-web.js')
      } catch (e) {
        logError('whatsapp-web.js is not installed (an optional peer until WA-T10) — no sends; use WA_SENDER=stub')
        onState({ state: 'disconnected', error: 'whatsapp_web_js_missing' })
        return
      }
      log('sender=whatsapp is not implemented yet (WA-T10) — rows stay released')
      onState({ state: 'disconnected', error: 'sender_not_implemented' })
    },
    async send() {
      throw new Error('sender_not_implemented')
    },
    async stop() {},
  }
}
