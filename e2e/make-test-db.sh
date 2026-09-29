#!/bin/bash
# Build a REALISTIC e2e template database from production, scrubbed.
#
# Why this exists (GR-T9 + a PO decision, 2026-08-31):
#   1. Fixture accumulation was silently degrading the suite. The SAME tree failed
#      2/15 in 3.7 min against a long-lived /tmp DB and passed 15/15 in 19 s against
#      a fresh one; `item-packed.spec.js` fails on ANY database it has already run
#      against once. Three separate wrong diagnoses were chased before the cause was
#      found, including a commit bisection for a regression that did not exist.
#   2. A hand-seeded DB has 1 friend and 1 cycle. Production has 76 friends, 12
#      cycles, guests, vouchers and a ledger. Bugs that only appear at that shape —
#      a fold that is fine with 3 rows and unusable with 76, an N+1, an unbounded
#      list — cannot be seen locally at all.
#
# So this produces a TEMPLATE, never a working file. The run recipe copies it to a
# throwaway path per run (see e2e/README.md), which is what makes runs comparable:
# every run starts from byte-identical, realistic state.
#
# ⚠ PO decision on scrubbing (2026-08-31): NAMES ARE KEPT — they make the screens
# read like the real thing, which is the point. Everything else identifying is
# regenerated, and that list is longer than it looks: the WHAT and the WHY live in
# `e2e/scrub-template.sql`, and every column it touches is checked by
# `e2e/verify-scrub.sql` before a single byte is downloaded. Those two files are one
# unit — add a column to the scrub, add a line to the verification.
#
# Usage:  ./e2e/make-test-db.sh [output-path]
#         default output: e2e/fixtures/prod-template.sqlite  (git-ignored)
#
# The RUN RECIPE is `e2e/README.md` → "Run against a local prod-like backend". This
# script does not print a second copy of it, on purpose (GR-T9): two copies of the
# recipe disagreeing is the defect this whole row exists to fix.

set -euo pipefail

SERVER="${GORIFI_SERVER:-root@gorifi}"
REMOTE_DB="${REMOTE_DB:-/var/www/gorifi/backend/src/db/database.sqlite}"
APP_USER="${APP_USER:-gorifi}"
OUT="${1:-$(cd "$(dirname "$0")" && pwd)/fixtures/prod-template.sqlite}"

# Fixture credentials the suite logs in with. MUST match e2e/fixtures.js defaults,
# or every admin-authenticated spec fails at the login field.
ADMIN_PASSWORD="${ADMIN_PASSWORD:-e2e-admin-pass-9271}"
FRIENDS_PASSWORD="${FRIENDS_PASSWORD:-e2e-friends-pass}"

mkdir -p "$(dirname "$OUT")"
HERE="$(cd "$(dirname "$0")" && pwd)"
REMOTE_TMP="/tmp/gorifi-e2e-template-$$.sqlite"

# ⚠ $REMOTE_TMP is a FULL UNSCRUBBED PRODUCTION SNAPSHOT for the seconds between the
# `.backup` and the scrub. Before this trap, any failure in between — `.backup` itself,
# the integrity check, the scrub ssh — aborted under `set -e` BEFORE the cleanup line and
# left that file sitting in the server's /tmp, world-readable by anything that can read
# /tmp, indefinitely. Cleanup is now on EXIT so it runs on every path, and it is the ONLY
# home for that `rm` (the success and failure paths no longer repeat it).
# Installed immediately after the assignment, so $REMOTE_TMP is always in scope when it
# fires; the guard is belt-and-braces for a future edit that moves this block.
cleanup_remote_tmp() {
  [ -n "${REMOTE_TMP:-}" ] || return 0
  ssh "$SERVER" "rm -f '$REMOTE_TMP'" >/dev/null 2>&1 \
    || echo "!! could not remove $SERVER:$REMOTE_TMP — an UNSCRUBBED snapshot may remain there" >&2
}
trap cleanup_remote_tmp EXIT

echo "==> Snapshotting production (online, WAL-safe)"
# `.backup` and not `cp`: the app is writing, and a plain copy of a live WAL database
# can land mid-transaction. Same reason deploy/backup-db.sh uses it.
ssh "$SERVER" "runuser -u $APP_USER -- sqlite3 '$REMOTE_DB' \".backup '$REMOTE_TMP'\" \
  && runuser -u $APP_USER -- sqlite3 '$REMOTE_TMP' 'PRAGMA integrity_check;' | head -1"

echo "==> Scrubbing on the SERVER (so unscrubbed data never leaves it)"
# ⚠ The SQL lives in `e2e/scrub-template.sql`, NOT in a heredoc here. One copy, so
# the local re-scrub path in the README runs the same bytes this does — and it also
# retires the heredoc trap the first version hit (a bare `<<SQL` made bash EXPAND the
# comment body, which is full of backticks, and one run literally executed
# `node e2e/seed.mjs` from inside a comment and fed its stdout to sqlite3).
ssh "$SERVER" "runuser -u $APP_USER -- sqlite3 '$REMOTE_TMP'" < "$HERE/scrub-template.sql"

echo "==> Verifying the scrub ON THE SERVER (fail closed before anything is downloaded)"
# ⚠ One line per column the scrub touches — see the header of verify-scrub.sql for
# why that contract is the whole safety margin. ANY non-zero count aborts.
LEAKS=$(ssh "$SERVER" "runuser -u $APP_USER -- sqlite3 '$REMOTE_TMP'" < "$HERE/verify-scrub.sql")

# ⚠ THIS GATE IS FAIL-CLOSED ON THE SHAPE OF THE OUTPUT, NOT ONLY ON THE NUMBERS — and
# that distinction is the same species as the leak this row was raised for. Checking only
# "no line has a non-zero second field" passes VACUOUSLY when the verification is
# malformed: a lost `.mode`/`.separator` dot-command, a changed separator or a truncated
# run yields lines that match nothing, an empty offender list, and a download under a
# "verified" banner. So: every line must be exactly `name|integer`, and there must be as
# many lines as verify-scrub.sql has checks.
#
# EXPECTED is DERIVED, not hardcoded: each check in verify-scrub.sql is one line starting
# with `SELECT '<name>'` (the `UNION ALL`s sit on their own lines). That file's header
# states the convention; keep it, or this count silently drifts.
EXPECTED=$(grep -cE "^[[:space:]]*SELECT '" "$HERE/verify-scrub.sql")
ACTUAL=$(printf '%s\n' "$LEAKS" | grep -c . || true)
# One pass classifies both failure modes, so a malformed line can never be read as a zero.
BAD=$(printf '%s\n' "$LEAKS" | awk -F'|' '
  NF != 2 || $1 == "" || $2 !~ /^[0-9]+$/ { print "MALFORMED  " $0; next }
  $2 + 0 != 0                             { print $1 "  " $2 }
')

# ⚠ `if/fi`, not `[ … ] && echo …`: under `set -e` a false left operand makes the whole
# AND-list fail, which exits the script right there — so a count mismatch would abort
# before the offender list ever printed. The reporting path has to survive its own guard.
if [ "$ACTUAL" != "$EXPECTED" ] || [ -n "$BAD" ]; then
  echo "!! SCRUB VERIFICATION FAILED — nothing downloaded." >&2
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "!! expected $EXPECTED check lines from verify-scrub.sql, got $ACTUAL — the" \
         "verification itself is wrong or truncated; treat this as a leak, not a glitch." >&2
  fi
  if [ -n "$BAD" ]; then
    printf '%s\n' "$BAD" | sed 's/^/!!   /' >&2
  fi
  exit 1
fi
echo "    scrub verified, all $EXPECTED checks 0:"
printf '%s\n' "$LEAKS" | sed 's/^/      /'

echo "==> Downloading"
scp -q "$SERVER:$REMOTE_TMP" "$OUT"
# No `rm` here: the EXIT trap owns the remote temp file on every path, success included.

echo "==> Done"
echo ""
echo "Template written: $OUT"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$OUT" "SELECT 'friends', COUNT(*) FROM friends UNION ALL SELECT 'cycles', COUNT(*) FROM order_cycles UNION ALL SELECT 'orders', COUNT(*) FROM orders UNION ALL SELECT 'guest_orders', COUNT(*) FROM guest_orders UNION ALL SELECT 'transactions', COUNT(*) FROM transactions;"
else
  echo "  (no local sqlite3 — skipping the row-count summary)"
fi
echo ""
echo "⚠ TEMPLATE, not a working file — and it still needs \`node e2e/seed.mjs\` on top"
echo "  (it deliberately has no E2E Test Cycle / E2ETester and no bcrypt password rows)."
echo "  Do NOT start a server on this file. Follow the recipe, which copies it per run,"
echo "  in the order that matters (stop the server by the PID owning the port → confirm"
echo "  the port is free → copy → start → seed):"
echo ""
echo "      e2e/README.md  →  \"Run against a local prod-like backend\""
