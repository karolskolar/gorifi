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
# read like the real thing, which is the point. Phones and e-mails are randomised.
# Everything that is a CREDENTIAL is regenerated, and that list is longer than it
# looks; see SCRUB below for why each one is on it.
#
# Usage:  ./e2e/make-test-db.sh [output-path]
#         default output: e2e/fixtures/prod-template.sqlite  (git-ignored)

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
REMOTE_TMP="/tmp/gorifi-e2e-template-$$.sqlite"

echo "==> Snapshotting production (online, WAL-safe)"
# `.backup` and not `cp`: the app is writing, and a plain copy of a live WAL database
# can land mid-transaction. Same reason deploy/backup-db.sh uses it.
ssh "$SERVER" "runuser -u $APP_USER -- sqlite3 '$REMOTE_DB' \".backup '$REMOTE_TMP'\" \
  && runuser -u $APP_USER -- sqlite3 '$REMOTE_TMP' 'PRAGMA integrity_check;' | head -1"

echo "==> Scrubbing on the SERVER (so unscrubbed data never leaves it)"
# ⚠ QUOTED delimiter, and that is not a style choice. With a bare `<<SQL` bash
# expands the body — and the SQL comments below contain BACKTICKS (`/g/:token`,
# `item-packed.spec.js`, `node e2e/seed.mjs`). On the first run that literally
# executed `node e2e/seed.mjs` from inside a comment and fed its stdout to sqlite3,
# which failed with "Parse error near line 59: near \"admin\"" — a message that
# points nowhere near the cause. No variables are interpolated into this SQL, so
# quoting costs nothing.
ssh "$SERVER" "runuser -u $APP_USER -- sqlite3 '$REMOTE_TMP'" <<'SQL'   # ⚠ quoted — see above
BEGIN IMMEDIATE;

-- ── CONTACT DATA (PO: randomise) ──────────────────────────────────────────────
-- Deterministic from the row id, so a given friend keeps ONE number across rebuilds
-- and a screenshot from last week still lines up.
UPDATE friends SET
  phone = '09' || substr('00000000' || (10000000 + id * 7919) % 100000000, -8),
  email = CASE WHEN email IS NULL OR email = '' THEN email
               ELSE 'friend' || id || '@example.test' END,
  -- A Packeta address is contact data too (it can be a home address). Not named by
  -- the PO, scrubbed under the same intent; the SHAPE is kept so the profile modal
  -- and the delivery badge still have something realistic to render.
  packeta_address = CASE WHEN packeta_address IS NULL OR packeta_address = '' THEN packeta_address
                         ELSE 'Z-Box Testovacia ' || id || ', 010 01 Mesto' END;

UPDATE invitations SET
  phone = '09' || substr('00000000' || (20000000 + id * 6421) % 100000000, -8),
  email = CASE WHEN email IS NULL OR email = '' THEN email
               ELSE 'invite' || id || '@example.test' END;

UPDATE guest_orders SET
  guest_phone = '09' || substr('00000000' || (30000000 + id * 5807) % 100000000, -8),
  guest_email = CASE WHEN guest_email IS NULL OR guest_email = '' THEN guest_email
                     ELSE 'guest' || id || '@example.test' END;

UPDATE orders SET
  packeta_address = CASE WHEN packeta_address IS NULL OR packeta_address = '' THEN packeta_address
                         ELSE 'Z-Box Testovacia ' || id || ', 010 01 Mesto' END;

-- ── CREDENTIALS ───────────────────────────────────────────────────────────────
-- ⚠ EVERY ONE OF THESE IS LIVE AGAINST THE PRODUCTION SITE. This is the half that
-- matters most and the easiest to forget: without it, a template file sitting in a
-- developer's /tmp is a set of working keys to podpultovka.biz.
--   friends.invite_code      — anyone holding it can register as a friend
--   guest_order_links.token  — /g/:token, the ordering surface; no password at all
--   guest_orders.order_token — /g/o/:orderToken, and since GR-T1 it is the WHOLE
--                              credential: it resolves regardless of the link half
--   login_tokens.token       — magic-link login
--   onboarding_links.token   — onboarding
--   friend_sessions          — live Bearer sessions
--   friends.password_hash / google_sub — a real person's login
-- Regenerated, not blanked, where a NOT NULL / UNIQUE constraint or a route's shape
-- depends on the column existing.
UPDATE friends SET
  invite_code   = 'T' || substr('0000000' || id, -7),
  password_hash = NULL,
  google_sub    = NULL;

UPDATE guest_order_links  SET token       = 'LNK' || substr('00000000000' || id, -11);
UPDATE guest_orders       SET order_token = 'ORD' || substr('00000000000' || id, -11);

DELETE FROM friend_sessions;
DELETE FROM login_tokens;
DELETE FROM onboarding_links;

-- ── SETTINGS: make the suite able to log in ───────────────────────────────────
-- ⚠ The password columns hold bcrypt hashes, which SQL cannot produce — so they are
-- DELETED here and re-created by `node e2e/seed.mjs`, which hashes the fixture
-- values properly. Leaving the production hashes in place would mean the suite
-- cannot authenticate at all (and would keep the real admin password around).
DELETE FROM settings WHERE key IN ('admin_password', 'admin_token', 'friends_password', 'admin_google_subs');
-- The suite's own recipe is legacy mode (seed.mjs sets it); prod may be 'modern',
-- which would make every shared-password spec fail for a reason that is not a bug.
UPDATE settings SET value = 'legacy' WHERE key = 'auth_mode';

COMMIT;
VACUUM;
SQL

echo "==> Verifying the scrub ON THE SERVER (fail closed before anything is downloaded)"
LEAKS=$(ssh "$SERVER" "runuser -u $APP_USER -- sqlite3 '$REMOTE_TMP' \"
  SELECT
    (SELECT COUNT(*) FROM friends WHERE password_hash IS NOT NULL OR google_sub IS NOT NULL)
  + (SELECT COUNT(*) FROM friends WHERE invite_code NOT LIKE 'T%')
  + (SELECT COUNT(*) FROM guest_order_links WHERE token NOT LIKE 'LNK%')
  + (SELECT COUNT(*) FROM guest_orders WHERE order_token NOT LIKE 'ORD%')
  + (SELECT COUNT(*) FROM friend_sessions) + (SELECT COUNT(*) FROM login_tokens)
  + (SELECT COUNT(*) FROM onboarding_links)
  + (SELECT COUNT(*) FROM settings WHERE key IN ('admin_password','admin_token','friends_password'))
  + (SELECT COUNT(*) FROM friends WHERE email IS NOT NULL AND email <> '' AND email NOT LIKE '%@example.test')
  + (SELECT COUNT(*) FROM guest_orders WHERE guest_email IS NOT NULL AND guest_email <> '' AND guest_email NOT LIKE '%@example.test');
\"")

if [ "${LEAKS:-1}" != "0" ]; then
  echo "!! SCRUB INCOMPLETE ($LEAKS rows still carry production credentials or contact data)." >&2
  echo "!! Nothing downloaded. The template is only useful if this is 0." >&2
  ssh "$SERVER" "rm -f '$REMOTE_TMP'"
  exit 1
fi
echo "    scrub verified: 0 leaking rows"

echo "==> Downloading"
scp -q "$SERVER:$REMOTE_TMP" "$OUT"
ssh "$SERVER" "rm -f '$REMOTE_TMP'"

echo "==> Seeding the suite's own fixtures on top (bcrypt hashes, E2E cycle + friend)"
echo "    run:  DB_PATH=<a COPY of the template> node backend/src/index.js"
echo "          cd e2e && BASE_URL=http://localhost:3997 node seed.mjs"
echo ""
echo "Template written: $OUT"
ssh "$SERVER" "true" 2>/dev/null || true
sqlite3 "$OUT" "SELECT 'friends', COUNT(*) FROM friends UNION ALL SELECT 'cycles', COUNT(*) FROM order_cycles UNION ALL SELECT 'orders', COUNT(*) FROM orders UNION ALL SELECT 'guest_orders', COUNT(*) FROM guest_orders UNION ALL SELECT 'transactions', COUNT(*) FROM transactions;" 2>/dev/null || true
echo ""
echo "⚠ TEMPLATE, not a working file. Copy it per run:"
echo "    cp $OUT /tmp/gorifi-run.sqlite && DB_PATH=/tmp/gorifi-run.sqlite ..."
echo "  Running the suite against the template itself reintroduces exactly the"
echo "  fixture accumulation this script exists to end."
