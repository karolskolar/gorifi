// Re-scrub and/or verify an e2e template LOCALLY, using the very same
// `scrub-template.sql` / `verify-scrub.sql` that `make-test-db.sh` runs on the
// server. That is the entire point of this file: a local re-scrub that retyped the
// SQL would be a second copy, and a second copy drifting from the first is what
// GR-T9 is about.
//
// Usage:
//   node e2e/scrub-local.mjs --verify [path]    # read-only: SQL checks + byte scan
//   node e2e/scrub-local.mjs --scrub  [path]    # apply the scrub, then verify
//   default path: e2e/fixtures/prod-template.sqlite
//
// Exits non-zero if ANY check is non-zero — same fail-closed contract as the script.
// Uses node:sqlite so it works on a box with no sqlite3 CLI (this one).

import { DatabaseSync } from 'node:sqlite'
import { readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const mode = args.find((a) => a.startsWith('--')) || '--verify'
const target = resolve(args.find((a) => !a.startsWith('--')) || `${HERE}/fixtures/prod-template.sqlite`)

if (!['--verify', '--scrub'].includes(mode)) {
  console.error(`unknown mode ${mode} — use --verify or --scrub`)
  process.exit(2)
}

// ── the SQL, read from the shared files ───────────────────────────────────────
const scrubSql = readFileSync(`${HERE}/scrub-template.sql`, 'utf8')
// verify-scrub.sql opens with sqlite3 CLI dot-commands (`.mode`, `.separator`) that
// only shape the CLI's output. node:sqlite cannot execute them and does not need
// them — we format the rows ourselves — so they are stripped, and nothing else is.
const verifySql = readFileSync(`${HERE}/verify-scrub.sql`, 'utf8')
  .split('\n').filter((l) => !/^\s*\./.test(l)).join('\n')

const db = new DatabaseSync(target)

if (mode === '--scrub') {
  console.log(`==> Scrubbing ${target}`)
  console.log('    (running e2e/scrub-template.sql verbatim — the same file the server runs)')
  db.exec(scrubSql)
}

// ── SQL verification: one row per column the scrub touches ────────────────────
console.log(`==> Verifying ${target} (e2e/verify-scrub.sql)`)
const rows = db.prepare(verifySql).all()
const width = Math.max(...rows.map((r) => Object.values(r)[0].length))
let bad = 0
for (const row of rows) {
  const [name, count] = Object.values(row)
  if (count !== 0) bad++
  console.log(`    ${name.padEnd(width)}  ${count}${count === 0 ? '' : '   <<< LEAK'}`)
}
db.close()

// ── raw byte scan: freed pages are not covered by SQL ─────────────────────────
// The scrub ends in VACUUM, which rewrites the file — but VACUUM is the only thing
// standing between a deleted row and a reader with `strings`, so the claim deserves
// a check that does not go through the query planner at all.
console.log('==> Raw byte scan (freed pages included)')
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const BCRYPT = /\$2[aby]\$\d\d\$/g
const size = statSync(target).size
const fd = openSync(target, 'r')
const CHUNK = 4 << 20
const OVERLAP = 256          // so a match straddling a chunk boundary is not missed
const emails = new Set()
let hashes = 0
let pos = 0
let tail = ''
while (pos < size) {
  const buf = Buffer.alloc(Math.min(CHUNK, size - pos))
  readSync(fd, buf, 0, buf.length, pos)
  const text = tail + buf.toString('latin1')
  // ⚠ SQLite packs a row's values end to end with no separator, so a match here
  // runs on into the NEXT column: `friend21@example.test` reads as
  // `friend21@example.testgfriend21`. Testing the tail (`endsWith('.test')`)
  // therefore reports every scrubbed address as a leak — the first version of this
  // scan did, drowning the real hits in 36 false ones. Judge the DOMAIN's head
  // instead: a generated address always starts its domain with `example.test`, and
  // whatever bytes follow belong to another column.
  for (const m of text.matchAll(EMAIL)) {
    const domain = m[0].slice(m[0].indexOf('@') + 1).toLowerCase()
    if (!domain.startsWith('example.test')) emails.add(m[0])
  }
  hashes += [...text.matchAll(BCRYPT)].length
  tail = text.slice(-OVERLAP)
  pos += buf.length
}
closeSync(fd)

const shown = [...emails].slice(0, 20)
console.log(`    non-.test e-mail addresses: ${emails.size}${shown.length ? ` → ${shown.join(', ')}` : ''}`)
console.log(`    bcrypt hash prefixes:       ${hashes}`)
if (emails.size) bad++
if (hashes) bad++

if (bad) {
  console.error(`\n!! ${bad} check(s) did not come back clean — this file is NOT safe to keep.`)
  process.exit(1)
}
console.log('\nClean: every SQL check 0, no residual contact data or password hashes in the bytes.')
