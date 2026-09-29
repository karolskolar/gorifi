// The frontend's product switches, as the e2e suite reads them — ONE value, the
// app's own (`frontend/src/lib/features.js`), never a second copy typed here.
//
// Read as TEXT, synchronously, so a spec can gate a `describe` at collection time.
// Without the source tree (a remote-target run) the parked default is assumed —
// that is what every deployed build carries until the PO flips it.
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FEATURES = fileURLToPath(new URL('../../frontend/src/lib/features.js', import.meta.url))

function flag(name, fallback) {
  if (!existsSync(FEATURES)) return fallback
  const m = readFileSync(FEATURES, 'utf8').match(new RegExp(`export const ${name} = (true|false)`))
  if (!m) throw new Error(`helpers/features.js: ${name} not found in frontend/src/lib/features.js`)
  return m[1] === 'true'
}

/** Module 19's standing guest link on the friend surface (PO 2026-09-29: parked). */
export const STANDING_GUEST_LINK = flag('STANDING_GUEST_LINK', false)

/** Module 19's pre-open waitlist form on the guest page (PO 2026-09-29: parked). */
export const GUEST_WAITLIST = flag('GUEST_WAITLIST', false)

export const WAITLIST_PARKED = 'guest waitlist form parked (frontend/src/lib/features.js, PO 2026-09-29)'

export const STANDING_PARKED = 'standing guest link parked (frontend/src/lib/features.js, PO 2026-09-29)'
