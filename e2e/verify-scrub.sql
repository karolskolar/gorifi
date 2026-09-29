-- Fail-closed verification for `e2e/scrub-template.sql`. Emits `check|count` lines;
-- ANY non-zero count means the file is not safe to download or to keep.
--
-- ⚠ ONE ROW PER COLUMN THE SCRUB TOUCHES — that is the contract, and it is the part
-- that has now been wrong twice (GR-T9, 2026-09-19). Before this rewrite the check
-- covered 9 of the 22 things the scrub writes, so it returned a confident `0` for a
-- template carrying 76 `access_token`s, 11 real third-party Gmail addresses in
-- `friends.google_email`, a live `invitations.google_sub`, and the PO's IBAN. A
-- verification narrower than the scrub does not weaken the claim, it LAUNDERS it:
-- the banner in `e2e/README.md` promises "a fail-closed check that refuses to
-- download anything while a single row still carries production contact data or a
-- credential", and that sentence is only as true as this file.
--
-- Derive additions from the scrub, not from memory: every `UPDATE … SET col`,
-- `DELETE FROM table` and settings key over there needs a line here. The order below
-- follows the scrub's own order so the two can be diffed side by side.
--
-- A missing column makes sqlite3 exit non-zero, which also fails closed.
-- ⚠ GL-T6 (2026-09-23): the `guest_waitlist.*` and `friends.guest_link_token` lines
-- (and their scrub twins) name a table and a column that exist only from module 19's
-- GL-T1/GL-T3 migrations on. Until PRODUCTION carries them, `make-test-db.sh` FAILS
-- CLOSED here („no such table/column") — deliberate: the lines ship with the first row
-- that can mint a standing token / write a waitlist row, never after it.
--
-- ⚠ FORMAT CONTRACT, relied on by `make-test-db.sh`: each check is exactly ONE line
-- beginning `SELECT '<name>'` (the `UNION ALL`s sit on their own lines). The script
-- COUNTS those lines and refuses to download unless it gets back that many
-- `name|integer` rows — so a truncated run, a lost dot-command or a changed separator
-- fails closed instead of producing an empty offender list under a "verified" banner.
-- Reformat freely, but keep one `SELECT '<name>'` per line, or that count drifts.

.mode list
.separator |

-- ── CONTACT DATA ──────────────────────────────────────────────────────────────
-- phone columns are rewritten UNCONDITIONALLY (no CASE), so every row must match.
  SELECT 'friends.phone',              COUNT(*) FROM friends
   WHERE phone IS NULL OR phone NOT GLOB '09[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
UNION ALL
  SELECT 'friends.email',              COUNT(*) FROM friends
   WHERE email IS NOT NULL AND email <> '' AND email NOT LIKE '%@example.test'
UNION ALL
  SELECT 'friends.packeta_address',    COUNT(*) FROM friends
   WHERE packeta_address IS NOT NULL AND packeta_address <> ''
     AND packeta_address NOT LIKE 'Z-Box Testovacia %'
UNION ALL
  SELECT 'invitations.phone',          COUNT(*) FROM invitations
   WHERE phone IS NULL OR phone NOT GLOB '09[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
UNION ALL
  SELECT 'invitations.email',          COUNT(*) FROM invitations
   WHERE email IS NOT NULL AND email <> '' AND email NOT LIKE '%@example.test'
UNION ALL
  SELECT 'guest_orders.guest_phone',   COUNT(*) FROM guest_orders
   WHERE guest_phone IS NULL OR guest_phone NOT GLOB '09[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
UNION ALL
  SELECT 'guest_orders.guest_email',   COUNT(*) FROM guest_orders
   WHERE guest_email IS NOT NULL AND guest_email <> '' AND guest_email NOT LIKE '%@example.test'
UNION ALL
  SELECT 'orders.packeta_address',     COUNT(*) FROM orders
   WHERE packeta_address IS NOT NULL AND packeta_address <> ''
     AND packeta_address NOT LIKE 'Z-Box Testovacia %'
UNION ALL
  SELECT 'guest_waitlist.name',        COUNT(*) FROM guest_waitlist
   WHERE name IS NULL OR name NOT GLOB 'Cakajuci [0-9]*'
UNION ALL
  SELECT 'guest_waitlist.phone',       COUNT(*) FROM guest_waitlist
   WHERE phone IS NULL OR phone NOT GLOB '09[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
UNION ALL
  -- tied to the SCRUBBED phone, so a real number cannot survive in it
  SELECT 'guest_waitlist.phone_e164',  COUNT(*) FROM guest_waitlist
   WHERE phone_e164 IS NOT NULL AND phone_e164 <> '+421' || substr(phone, 2)

-- ── CREDENTIALS ───────────────────────────────────────────────────────────────
UNION ALL
  SELECT 'friends.invite_code',        COUNT(*) FROM friends WHERE invite_code IS NULL OR invite_code NOT LIKE 'T%'
UNION ALL
  SELECT 'friends.access_token',       COUNT(*) FROM friends WHERE access_token IS NULL OR access_token NOT LIKE 'TOK%'
UNION ALL
  SELECT 'friends.password_hash',      COUNT(*) FROM friends WHERE password_hash IS NOT NULL
UNION ALL
  SELECT 'friends.google_sub',         COUNT(*) FROM friends WHERE google_sub IS NOT NULL
UNION ALL
  SELECT 'friends.google_email',       COUNT(*) FROM friends
   WHERE google_email IS NOT NULL AND google_email <> '' AND google_email NOT LIKE '%@example.test'
UNION ALL
  SELECT 'friends.guest_link_token',   COUNT(*) FROM friends WHERE guest_link_token IS NOT NULL
UNION ALL
  SELECT 'invitations.google_sub',     COUNT(*) FROM invitations WHERE google_sub IS NOT NULL
UNION ALL
  SELECT 'invitations.google_email',   COUNT(*) FROM invitations
   WHERE google_email IS NOT NULL AND google_email <> '' AND google_email NOT LIKE '%@example.test'
UNION ALL
  SELECT 'guest_order_links.token',    COUNT(*) FROM guest_order_links WHERE token IS NULL OR token NOT LIKE 'LNK%'
UNION ALL
  SELECT 'guest_orders.order_token',   COUNT(*) FROM guest_orders WHERE order_token IS NULL OR order_token NOT LIKE 'ORD%'
UNION ALL
  SELECT 'friend_sessions',            COUNT(*) FROM friend_sessions
UNION ALL
  SELECT 'login_tokens',               COUNT(*) FROM login_tokens
UNION ALL
  SELECT 'onboarding_links',           COUNT(*) FROM onboarding_links

-- ── SETTINGS ──────────────────────────────────────────────────────────────────
UNION ALL
  SELECT 'settings.credential_keys',   COUNT(*) FROM settings
   WHERE key IN ('admin_password', 'admin_token', 'friends_password',
                 'admin_google_subs', 'admin_google_subs_corrupt',
                 'payment_iban', 'payment_revolut_username')
UNION ALL
  SELECT 'settings.auth_mode',         COUNT(*) FROM settings WHERE key = 'auth_mode' AND value <> 'legacy';
