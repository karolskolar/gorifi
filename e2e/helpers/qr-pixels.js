// Reading a Pay-by-Square QR back off the RENDERED PIXELS.
//
// ⚠ WHY THIS LIVES OUTSIDE `tests/`. `playwright.config.js` sets `testDir: './tests'`,
// so a module here is imported by specs and never collected as one (a file under
// `tests/` with no `test()` in it fails the run outright).
//
// ⚠ WHY PIXELS AND NOT THE `src` ATTRIBUTE. The technique is the module-15 money
// contract (01-architecture §Testing & gate): the assertion must be over what a BANK
// APP would scan, not over the string the component happened to hand `qrcode`. Reading
// the data URL back would re-assert the app's own input; decoding the painted image
// asserts the output. Everything below is derived from the image alone — the dark
// bounding box, the pitch from the 7-module top-left finder run, the size snapped to
// the legal series (21 + 4k). Nothing about the expected payload leaks in.
//
// ⚠ ORIGIN. Written for `guest-payment-modal.spec.js` (the Platba modal), copied once
// into `money-rounding.spec.js` (the friend success modal). PL-T4 needed it a THIRD
// time (15 §UC-PL-009 item 7: "lift it into a shared e2e helper file rather than a
// third copy"), so the copy stops here. The two existing in-spec copies were left
// byte-untouched on purpose: PL-T4's sanctioned edit list (15 §UC-PL-009 item 2) covers
// `money-rounding.spec.js`'s `independentQr()` and NOTHING else, and
// `guest-payment-modal.spec.js` is not PL-T4's file at all. Retro-fitting them is a
// one-row cleanup for whoever next holds a sanction on those files.

/**
 * Scans the first `.qr img` on the page and returns `{ size, matrix }` — the module
 * grid as `'0'`/`'1'` rows joined by newlines, comparable byte-for-byte against
 * `qrMatrix()` of an independently encoded payload.
 *
 * Returns `{ error }` instead of throwing, so a spec asserts
 * `expect(scanned.error).toBeUndefined()` and reads WHY it failed.
 */
export async function readQrModules(page, selector = '.qr img') {
  return page.evaluate(async (sel) => {
    const img = document.querySelector(sel)
    if (!img) return { error: 'no img' }
    if (!img.complete) await new Promise((r) => { img.onload = r })
    const n = img.naturalWidth
    const cv = document.createElement('canvas')
    cv.width = n
    cv.height = n
    const cx = cv.getContext('2d')
    cx.drawImage(img, 0, 0)
    const px = cx.getImageData(0, 0, n, n).data
    const dark = (x, y) => px[(y * n + x) * 4] < 128

    let minX = n, minY = n, maxX = -1, maxY = -1
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!dark(x, y)) continue
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
    if (maxX < 0) return { error: 'all light' }

    let run = 0
    while (dark(minX + run, minY)) run++
    const width = maxX - minX + 1
    const approx = width / (run / 7)
    let size = 21
    let best = Infinity
    for (let s = 21; s <= 177; s += 4) {
      const d = Math.abs(s - approx)
      if (d < best) { best = d; size = s }
    }
    const step = width / size
    const rows = []
    for (let r = 0; r < size; r++) {
      let line = ''
      for (let c = 0; c < size; c++) {
        line += dark(Math.round(minX + (c + 0.5) * step), Math.round(minY + (r + 0.5) * step)) ? '1' : '0'
      }
      rows.push(line)
    }
    return { size, matrix: rows.join('\n') }
  }, selector)
}

/**
 * The module grid of an encoded Pay-by-Square string, for comparison against
 * `readQrModules()`. `QRCode` is the CALLER's import — the frontend's own copy — so
 * this file adds no dependency of its own and the two sides cannot drift apart.
 */
export function qrMatrix(QRCode, qrString) {
  const qr = QRCode.create(qrString, { errorCorrectionLevel: 'M' })
  const rows = []
  for (let r = 0; r < qr.modules.size; r++) {
    let line = ''
    for (let c = 0; c < qr.modules.size; c++) line += qr.modules.get(r, c) ? '1' : '0'
    rows.push(line)
  }
  return { size: qr.modules.size, matrix: rows.join('\n') }
}
