// 21 §UC-WA-011 / §UC-WA-012 — the pairing QR as `data:image/png;base64,…` for health's
// `qr` field (the `qrcode` package). ⚠ The QR is a PAIRING CREDENTIAL: it lives only in
// the process's in-memory status while `state = 'qr'`, is never logged and never written
// anywhere. Fed by the whatsapp sender's `qr` event (WA-T10); the stub never pairs.

import QRCode from 'qrcode'

export async function qrDataUrl(text) {
  if (typeof text !== 'string' || !text) return null
  try {
    return await QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, scale: 6 })
  } catch {
    return null
  }
}
