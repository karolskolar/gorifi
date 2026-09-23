-- Scrub a production snapshot into an e2e TEMPLATE. Run by `e2e/make-test-db.sh`
-- ON THE SERVER, before anything is downloaded, and by the local re-scrub path the
-- README documents. It lives in a FILE, not in a heredoc inside the script, for two
-- reasons (GR-T9, 2026-09-19):
--
--   1. There must be exactly ONE copy of this SQL. A local re-scrub that retypes it
--      is a second copy that drifts, which is this row's whole thesis.
--   2. It removes the heredoc trap the first version hit: with a bare `<<SQL` bash
--      EXPANDS the body, and the comments below are full of backticks — one run
--      literally executed `node e2e/seed.mjs` from inside a comment and fed its
--      stdout to sqlite3, failing with "Parse error near line 59: near \"admin\"",
--      a message that points nowhere near the cause.
--
-- ⚠ EVERY column touched here MUST have a matching check in `e2e/verify-scrub.sql`.
-- The two files are read together; the verification is the only thing that makes the
-- word "scrubbed" mean anything, and twice now it was NARROWER than the scrub, which
-- was itself narrower than the schema. Add a column here ⇒ add a row there.
--
-- ⚠ PO decision (2026-08-31): NAMES ARE KEPT — they make the screens read like the
-- real thing, which is the point. Everything else identifying is regenerated
-- DETERMINISTICALLY from the row id, so a friend keeps one number across rebuilds.

BEGIN IMMEDIATE;

-- ── CONTACT DATA (PO: randomise) ──────────────────────────────────────────────
-- ⚠ THE INNER PARENTHESES ON EVERY PHONE LINE ARE LOAD-BEARING (GL-T3 review, fixed
-- GL-T6). In SQLite `||` binds TIGHTER than `%`, so the old
-- `'00000000' || (10000000 + id * 7919) % 100000000` padded FIRST and took the modulo
-- of the padded string: correct only while the sum stayed below 100000000. Past that
-- (friends from id ~11365, guest_orders ~12055, invitations ~12459) the modulo result
-- was no longer padded, `substr(…, -8)` returned fewer than 8 digits and the verify's
-- GLOB failed — closed, not leaking, but a template build that dies once production
-- grows. `((… ) % 100000000)` takes the modulo first, then pads. Keep the form.
UPDATE friends SET
  phone = '09' || substr('00000000' || ((10000000 + id * 7919) % 100000000), -8),
  email = CASE WHEN email IS NULL OR email = '' THEN email
               ELSE 'friend' || id || '@example.test' END,
  -- A Packeta address is contact data too (it can be a home address). Not named by
  -- the PO, scrubbed under the same intent; the SHAPE is kept so the profile modal
  -- and the delivery badge still have something realistic to render.
  packeta_address = CASE WHEN packeta_address IS NULL OR packeta_address = '' THEN packeta_address
                         ELSE 'Z-Box Testovacia ' || id || ', 010 01 Mesto' END;

UPDATE invitations SET
  phone = '09' || substr('00000000' || ((20000000 + id * 6421) % 100000000), -8),
  email = CASE WHEN email IS NULL OR email = '' THEN email
               ELSE 'invite' || id || '@example.test' END;

UPDATE guest_orders SET
  guest_phone = '09' || substr('00000000' || ((30000000 + id * 5807) % 100000000), -8),
  guest_email = CASE WHEN guest_email IS NULL OR guest_email = '' THEN guest_email
                     ELSE 'guest' || id || '@example.test' END;

UPDATE orders SET
  packeta_address = CASE WHEN packeta_address IS NULL OR packeta_address = '' THEN packeta_address
                         ELSE 'Z-Box Testovacia ' || id || ', 010 01 Mesto' END;

-- 19 §UC-GL-004 (GL-T6) — the guest WAITLIST: people who asked to be told when a
-- host's round opens and who NEVER JOINED. ⚠ The name is scrubbed TOO — the stricter
-- default (orchestrator, 2026-09-23): the PO's „names are kept" rule above was made
-- for friends and is not extended to strangers.
-- ⚠ `phone_e164` is re-derived from the SAME expression as `phone`, not from `phone`:
-- an UPDATE's right-hand side reads the OLD row, so `'+421' || substr(phone, 2)` here
-- would copy the REAL number. NULL stays NULL (a number that did not normalise). The
-- partial unique index on (host_friend_id, phone_e164) cannot collide — the value is
-- per id. The verify ties e164 to the SCRUBBED phone, so a real number cannot survive.
UPDATE guest_waitlist SET
  name       = 'Cakajuci ' || id,
  phone      = '09' || substr('00000000' || ((40000000 + id * 4973) % 100000000), -8),
  phone_e164 = CASE WHEN phone_e164 IS NULL THEN NULL
                    ELSE '+4219' || substr('00000000' || ((40000000 + id * 4973) % 100000000), -8) END;

-- ── CREDENTIALS ───────────────────────────────────────────────────────────────
-- ⚠ EVERY ONE OF THESE IS LIVE AGAINST THE PRODUCTION SITE. This is the half that
-- matters most and the easiest to forget: without it, a template file sitting in a
-- developer's /tmp is a set of working keys to podpultovka.biz.
--   friends.invite_code      — anyone holding it can register as a friend
--   friends.access_token     — see the note on it below
--   guest_order_links.token  — /g/:token, the ordering surface; no password at all
--   guest_orders.order_token — /g/o/:orderToken, and since GR-T1 it is the WHOLE
--                              credential: it resolves regardless of the link half
--   friends.guest_link_token — 19's STANDING /g/:token (GL-T1), a host's permanent
--                              door; `invite_code`'s class. NULLed, not regenerated:
--                              NULL is the „not minted yet" state (the next GET mints
--                              lazily) and the unique index ignores NULLs (GL-T6)
--   login_tokens.token       — magic-link login
--   onboarding_links.token   — onboarding
--   friend_sessions          — live Bearer sessions
--   friends.password_hash    — a real person's login
--   friends/invitations.google_sub + google_email — a real person's Google identity
-- Regenerated, not blanked, where a NOT NULL / UNIQUE constraint or a route's shape
-- depends on the column existing.
--
-- ⚠ GR-T9 (2026-09-19): `access_token`, `friends.google_email`, `invitations.google_sub`
-- and `invitations.google_email` were all MISSING here. The two Google columns on
-- `invitations` are not inert — `routes/invitations.js:572,653` copies `google_sub`
-- onto the friend row created at approval and `:321,580` MATCHES on it, so the
-- template shipped a live Google identity. `friends.google_email` held 11 real
-- third-party Gmail addresses while `friends.email` beside it was correctly
-- randomised: the scrub enumerated columns and missed one.
--
-- ⚠ `access_token` is REGENERATED rather than justified as safe. No route
-- authenticates with it today — it is INSERTed at friend creation
-- (`friends.js:1101,1124`, `invitations.js:651`, `onboarding.js:371`) and deleted
-- from every payload by `sanitizeFriend` — but `routes/friends.js:18` calls it "a
-- live auth credential", it is `UNIQUE NOT NULL`, and 76 production values were
-- leaving the server under a banner saying the file is scrubbed. A comment and an
-- artifact that disagree is the thing this row exists to stop; regenerating costs
-- one line and ends the argument.
UPDATE friends SET
  invite_code   = 'T'   || substr('0000000'   || id, -7),
  access_token  = 'TOK' || substr('000000000' || id, -9),
  password_hash = NULL,
  google_sub    = NULL,
  google_email  = CASE WHEN google_email IS NULL OR google_email = '' THEN google_email
                       ELSE 'gfriend' || id || '@example.test' END;

-- ⚠ Its OWN statement (GL-T6a review): on a snapshot without the column this fails
-- ALONE, and the five credential scrubs above it have already run.
UPDATE friends SET guest_link_token = NULL;

UPDATE invitations SET
  google_sub   = NULL,
  google_email = CASE WHEN google_email IS NULL OR google_email = '' THEN google_email
                      ELSE 'ginvite' || id || '@example.test' END;

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
-- ⚠ GR-T9: `payment_iban` / `payment_revolut_username` were missing — the PO's real
-- bank account and Revolut handle, invisible because `seed.mjs` step 3b fills
-- payment settings only when BOTH are empty ("payment details already present, left
-- untouched"). No spec hardcodes the IBAN; they all read it back from
-- `/api/admin/payment-settings`, so seed.mjs writing the fixture value is free.
-- ⚠ `admin_google_subs_corrupt` is the raw allowlist `routes/admin.js:162,168` parks
-- when `admin_google_subs` will not parse — admin Google subs and e-mails in a
-- string nothing else reads. Absent in today's snapshot (the key only exists since
-- FUP-T19, which landed 2026-09-19), which is exactly why it is listed: this list is
-- for the snapshot that HAS it.
-- ⚠ PL-T1 (2026-09-19): `payment_creditor_name` is the THIRD payment setting and is
-- DELIBERATELY ABSENT FROM THIS LIST — not an oversight of the kind the two keys above
-- were. It holds the account HOLDER'S NAME, which is not a credential (every bank
-- transfer shows it to the payer, and `/api/admin/payment-settings` publishes it
-- unauthenticated by design, 15 §UC-PL-002), and friends' real names are KEPT in this
-- template by PO decision — scrubbing one name while 76 others stay would buy nothing.
-- Consequences, both already true: `seed.mjs` 3b writes the fixture name ONLY when the
-- key is empty, so a template rebuilt from a production that has it set keeps the real
-- value; and no spec hardcodes the seeded name (`payment-links.spec.js` reads it back).
DELETE FROM settings WHERE key IN ('admin_password', 'admin_token', 'friends_password',
                                   'admin_google_subs', 'admin_google_subs_corrupt',
                                   'payment_iban', 'payment_revolut_username');
-- The suite's own recipe is legacy mode (seed.mjs sets it); prod may be 'modern',
-- which would make every shared-password spec fail for a reason that is not a bug.
UPDATE settings SET value = 'legacy' WHERE key = 'auth_mode';

COMMIT;
-- VACUUM rewrites the file, so the scrubbed values do not survive in freed pages.
-- ⚠ It must be outside the transaction, and it is the reason the raw byte scan in
-- the README's local re-scrub path finds nothing.
VACUUM;
