// Magic-link recovery — the REQUEST half (09 §UC-ML-003 + §UC-ML-004 + §UC-ML-009
// rule 1) and, since ML-T3, the REDEMPTION half (§UC-ML-005) at the bottom.
//
// ⚠ THIS ROUTER IS MOUNTED BARE at /api/magic-link — public and anonymous by design.
// It is the path for someone who CANNOT log in, so neither `requireAdmin` nor friend
// auth may ever wrap it (the invitations mixed-mount lesson, in reverse: there the
// hazard was gating too little, here it would be gating at all).
//
// ══ THE THREE RULES THIS FILE EXISTS TO ENFORCE ═══════════════════════════════
//
//  1. ONE RESPONSE LITERAL, BYTE-IDENTICAL ON EVERY PATH. `200 {"success":true}` for
//     a matching username, a matching unique e-mail, an unknown identifier, a matched
//     friend with no e-mail, a matched friend with no password_hash, an inactive
//     friend, an ambiguous e-mail, the cooldown, legacy mode — and EVERY mailer
//     outcome, a Mailgun 500 included. There is exactly one `res.json(NEUTRAL_RESPONSE)`
//     below and nothing variable reaches it, because any observable difference is an
//     account-existence oracle. The only other response this endpoint can produce is
//     the input-shape 400, which fires identically for any account state.
//
//  2. THE SEND IS FIRE-AND-FORGET, AFTER THE RESPONSE — THE TIMING-ORACLE KILLER.
//     `sendMail()` awaits a network round trip with a 10 s timeout; awaiting it would
//     make a matched identifier measurably slower than an unmatched one, which is rule
//     1 defeated by a stopwatch. So the handler responds immediately after the
//     transaction and lets the send settle in the background. `sendMail` never throws
//     (its rule 3), but the whole render+send sits in a try/catch anyway so a
//     `renderEmail` throw cannot become an unhandled rejection that takes the process
//     down. ⚠ ACCEPTED CONSEQUENCE, recorded in the spec: a mail failure is visible
//     only in the server log — the requester simply retries from the same screen.
//
//  3. ONE TRANSACTION for the write half: cooldown check, predecessor invalidation,
//     INSERT, and the opportunistic GC of expired rows. ⚠ THAT GC IS LOAD-BEARING —
//     no scheduler exists in this stack (01-architecture §Shared services) and none is
//     added, so §UC-ML-009 rule 5 relies on it continuing to exist here.
//
// The raw token is NEVER logged, never returned, never persisted: it exists in the
// outbound e-mail's URL and (transiently, in ML-T3) the redeeming request body. Only
// `sha256(raw)` is stored (the 07 §UC-IA-005 temp-password discipline).

import { Router } from 'express';
import db, { generateLoginToken, hashLoginToken, LOGIN_TOKEN_TTL_MS } from '../db/schema.js';
import { getAuthMode, createFriendSession } from '../middleware/friend-auth.js';
import { magicLinkLimiter, authLimiter } from '../middleware/rate-limit.js';
import { renderEmail } from '../helpers/email-templates.js';
import { sendMail } from '../helpers/mailer.js';
import { resolveLoginUrl } from '../helpers/credentials-message.js';

const router = Router();

// The e-mail bound (the GSO-T3 mirror — `friends.email` is capped at 160 too), which
// also comfortably covers any username.
const MAX_IDENTIFIER_LENGTH = 160;

// One outbound mail per friend per minute, regardless of how many requests the IP
// limiter lets through. Compared in MILLISECONDS against `login_tokens.created_at`,
// which is a ms-epoch INTEGER for exactly this reason (§UC-ML-001).
const COOLDOWN_MS = 60 * 1000;

const MAGIC_LINK_SUBJECT = 'Prihlásenie do Podpultovky';

// ⚠ THE one success literal. Frozen so no future edit can decorate it in place, and
// referenced from exactly one `res.json` below.
const NEUTRAL_RESPONSE = Object.freeze({ success: true });

// Input-shape errors. These are NOT existence signals — they fire identically for any
// account state, which is why they may differ from the neutral 200 at all. Slovak
// vy-form + a `field` marker, the guest.js 400 contract.
// ⚠ Copy status: proposed, not signed (the consolidated 09 §UC-ML-006 OPEN).
const IDENTIFIER_REQUIRED = 'Zadajte užívateľské meno alebo e-mail';
const IDENTIFIER_TOO_LONG = `Užívateľské meno alebo e-mail je príliš dlhý (najviac ${MAX_IDENTIFIER_LENGTH} znakov)`;

// ── the match ────────────────────────────────────────────────────────────────
// Username first, e-mail only as a fallback. Usernames are `[a-z0-9._-]` (no `@`), so
// the two paths cannot collide.
function findFriend(lower) {
  const byUsername = db
    .prepare('SELECT * FROM friends WHERE username = ? AND active = 1')
    .get(lower);
  if (byUsername) return byUsername;

  if (!lower.includes('@')) return null;

  // ⚠ DELIBERATE DEVIATION FROM §UC-ML-003 step 4's LITERAL SQL — do not "restore"
  // `WHERE lower(trim(email)) = ?`. SQLite's `lower()` is ASCII-ONLY and its `trim()`
  // strips only U+0020, while the identifier arrives through JS `toLowerCase()`, which
  // is Unicode-aware. The two sides therefore disagree on exactly the characters this
  // app is full of: `lower('ŽOFIA@Example.TEST')` is `'Žofia@example.test'`, which can
  // never equal the JS-lowercased `'žofia@example.test'`. A friend whose stored address
  // carries an uppercase diacritic — or a stray tab — would be permanently unable to
  // recover, and because of the enumeration guarantee below NOTHING could ever tell
  // them: they would just keep requesting links that are never sent. It fails closed
  // (neutral 200, no mail), so this was a usability dead-end rather than a hole.
  //
  // `friends` is tens of rows, so both sides are normalised in JS instead. The scan is
  // also constant work for every `@`-shaped identifier, matched or not, which is mildly
  // better for the timing property than a predicate an index could short-circuit.
  const candidates = db
    .prepare('SELECT * FROM friends WHERE active = 1 AND email IS NOT NULL')
    .all();

  // ⚠ EXACTLY ONE active friend, or no match at all. `friends.email` carries no UNIQUE
  // constraint, and mailing a shared office inbox a login link for an ambiguous account
  // would log in "whoever clicks first" as an arbitrary friend. Zero or ≥2 ⇒ no match
  // (recorded in §Accepted risks: those friends recover by username).
  const matches = candidates.filter(
    (f) => typeof f.email === 'string' && f.email.trim().toLowerCase() === lower
  );
  return matches.length === 1 ? matches[0] : null;
}

// ── the write half ───────────────────────────────────────────────────────────
// Returns `{ email, rawToken }` when a link was actually minted, or null on EVERY
// other path (wrong mode, no match, ineligible, cooldown). The caller cannot tell the
// difference from the response — only the outbound mail differs, which is why the send
// is the one thing this function's result decides.
function issueLoginToken(identifierLower) {
  // Modern-mode only (01-architecture). The mode is already public via
  // `/friends/auth-mode`, so a second response shape would buy nothing — the endpoint
  // simply does no work.
  if (getAuthMode() !== 'modern') return null;

  const friend = findFriend(identifierLower);
  if (!friend) return null;

  // Eligibility. Every failure below is silent — §UC-ML-006's UI can never say "you
  // have no e-mail on file"; module 11 makes that state visible to the ADMIN instead.
  const email = typeof friend.email === 'string' ? friend.email.trim() : '';
  if (!email) return null;
  // Recovery presupposes a password to recover: a credential-less legacy friend must
  // not gain a login side-door here (their path is the admin's credentials actions, 07).
  if (!friend.password_hash) return null;

  const rawToken = generateLoginToken();
  const tokenHash = hashLoginToken(rawToken);
  const now = Date.now();

  // ⚠ ONE transaction, synchronous writes only. SHA-256 is microseconds, so the IA-T3
  // "no bcrypt inside a transaction" invariant is not implicated — but note the hash is
  // computed ABOVE the transaction anyway, keeping the pattern intact.
  const issued = db.transaction(() => {
    // 1. Cooldown — the newest row for this friend, used or not. Inside the transaction
    //    so the check and the insert cannot be interleaved (the standing GSO-T3
    //    `instances: 1` caveat still applies to a PM2 cluster).
    const newest = db
      .prepare('SELECT MAX(created_at) AS newest FROM login_tokens WHERE friend_id = ?')
      .get(friend.id);
    if (newest && Number(newest.newest) > now - COOLDOWN_MS) return false;

    // 2. Predecessor invalidation (§UC-ML-009 rule 1): at most ONE redeemable link per
    //    friend at any moment. Conservative, and it is also what makes "the mail didn't
    //    arrive, request again" self-consistent.
    db.prepare('DELETE FROM login_tokens WHERE friend_id = ? AND used_at IS NULL').run(friend.id);

    // 3. The new row.
    db.prepare(
      'INSERT INTO login_tokens (friend_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)'
    ).run(friend.id, tokenHash, now + LOGIN_TOKEN_TTL_MS, now);

    // 4. Opportunistic GC, mirroring createFriendSession's pattern — see rule 3 in the
    //    header. Runs AFTER the insert, whose `expires_at` is 15 minutes out, so it can
    //    never collect the row just written.
    db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').run(now);

    return true;
  })();

  if (!issued) return null;
  return { email, rawToken };
}

// ── the mail (§UC-ML-004) ────────────────────────────────────────────────────
// The second consumer of module 08's `renderEmail`/`sendMail` seam. This module
// supplies subject, text and blocks; the layer supplies everything else.
//
// ⚠ Copy status: proposed, not signed (the consolidated §UC-ML-006 OPEN).
function deliverMagicLink(req, { email, rawToken }) {
  try {
    // ⚠ `resolveLoginUrl(req)` — so 08 §UC-EM-004's PUBLIC_BASE_URL pin covers this URL
    // automatically and the same origin-allowlist reasoning applies: this link is
    // mailed to a third party, so an attacker-chosen Origin must never mint its domain.
    // Server-derived, satisfying 08's "button.url never from a request body" rule.
    const url = `${resolveLoginUrl(req)}/magic/${rawToken}`;

    const text =
      `Dobrý deň, na prihlásenie do Podpultovky použite tento odkaz: ${url}\n` +
      'Odkaz platí 15 minút a dá sa použiť len raz. Ak ste o prihlásenie nežiadali, tento e-mail ignorujte - vaše heslo sa nezmenilo.';

    // No interpolated user-supplied string appears in any block: the URL is
    // server-minted and the friend's name is deliberately unused — one fewer escaping
    // surface, and the mail then works for every register.
    const { html } = renderEmail({
      text,
      blocks: [
        {
          type: 'paragraph',
          text: 'Na prihlásenie do Podpultovky použite toto tlačidlo. Odkaz platí 15 minút a dá sa použiť len raz.',
        },
        // URL-as-label default kept: an invented button label would be new unsigned
        // Slovak copy (the §UC-EM-003 OPEN).
        { type: 'button', url },
        {
          type: 'small',
          text: 'Ak ste o prihlásenie nežiadali, tento e-mail ignorujte. Vaše heslo sa nezmenilo.',
        },
      ],
    });

    // ⚠ NOT awaited (rule 2). The result vocabulary — sent / skipped:'no_recipient' |
    // 'not_configured' / error:* — is CONSUMED HERE and never surfaced: the neutral 200
    // has already gone out. `not_configured` is the normal local-dev and e2e state.
    sendMail({ to: email, subject: MAGIC_LINK_SUBJECT, text, html })
      .then((result) => {
        if (!result || !result.sent) {
          // Terse and token-free: the identifier, the address and the link never enter
          // the log. This line is the ONLY visibility a failed send has.
          console.error(`[magic-link] mail not sent: ${result?.error || result?.skipped || 'unknown'}`);
        }
      })
      .catch((e) => {
        // Unreachable per the mailer's rule 3; kept so a future regression there cannot
        // become an unhandled rejection.
        console.error(`[magic-link] mail send threw: ${e?.message || 'unknown error'}`);
      });
  } catch (e) {
    // A `renderEmail` throw (08 §UC-EM-002's one acceptable failure mode) degrades to
    // "no mail", logged as a message only.
    console.error(`[magic-link] could not build the mail: ${e?.message || 'unknown error'}`);
  }
}

// POST /api/magic-link/request — public, anonymous, enumeration-safe.
router.post('/request', magicLinkLimiter, (req, res) => {
  // ⚠ TYPE AND BOUNDS FIRST, before anything that can throw. `hashLoginToken` throws a
  // TypeError on a non-string (ML-T1 handover), and `.trim()` on a number throws too —
  // either would turn a malformed body into a 500 with a stack trace, which is both a
  // broken contract and a difference an enumerator could steer into.
  const raw = req.body?.identifier;
  if (typeof raw !== 'string') {
    return res.status(400).json({ error: IDENTIFIER_REQUIRED, field: 'identifier' });
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return res.status(400).json({ error: IDENTIFIER_REQUIRED, field: 'identifier' });
  }
  if (trimmed.length > MAX_IDENTIFIER_LENGTH) {
    return res.status(400).json({ error: IDENTIFIER_TOO_LONG, field: 'identifier' });
  }

  // Everything from here answers with the SAME 200, so a failure inside the write half
  // must not become a 500 either — that would be a difference visible to a caller, and
  // it is precisely the matched path that does the extra work. Logged, then neutralised.
  let pending = null;
  try {
    pending = issueLoginToken(trimmed.toLowerCase());
  } catch (e) {
    console.error(`[magic-link] request failed: ${e?.message || 'unknown error'}`);
  }

  // ⚠ THE ONE SUCCESS LITERAL, and the response goes out BEFORE the send (rule 2).
  res.json(NEUTRAL_RESPONSE);

  if (pending) deliverMagicLink(req, pending);
});

// ═════════════════════════════════════════════════════════════════════════════
// REDEMPTION — POST /api/magic-link/redeem (09 §UC-ML-005), ML-T3
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠ ON `authLimiter`, NOT `magicLinkLimiter`. This endpoint mints sessions — it IS a
// login, and it costs no outbound mail. Putting it on the mail bucket would let a
// redemption storm block the *requests* that produce the links, and vice versa.
//
// ══ THE TWO RULES THIS HALF EXISTS TO ENFORCE ═════════════════════════════════
//
//  1. THE ATOMIC SINGLE-USE WRITE. The `used_at IS NULL` predicate lives INSIDE the
//     UPDATE, so "is this token still redeemable?" and "claim it" are one statement.
//     Never a read-then-write pair — not even with a check in between: two concurrent
//     redemptions of one link would both pass the read and both mint a session. The
//     `expires_at >` predicate rides along for the same reason.
//     `changes !== 1` is the ONLY thing that decides whether the token was ours;
//     unknown, expired and already-used are therefore indistinguishable BY
//     CONSTRUCTION, not by three branches that happen to return the same body.
//
//  2. ONE NEUTRAL FAILURE — one status, one message, one frozen literal, referenced
//     from a single helper. Unknown / expired / used / inactive / ineligible /
//     legacy-mode / malformed / over-length all answer with it. No `reason` field, no
//     differing status codes: any distinction here is an oracle over token state, and
//     the token is the whole credential.
//     ⚠ Note the deliberate asymmetry with `/request` above, where a malformed body
//     IS a distinct 400: there the input is an identifier the caller already knows,
//     here the input is the secret itself, so "wrong shape" is already a statement
//     about it.
//
// The raw token is read from the body, hashed, and dropped. It is never logged and
// never echoed — a failure response carries nothing but the sentence below.

// Generous but finite: the token is 64 hex chars. The bound exists so a multi-megabyte
// string never reaches `createHash` (§UC-ML-005 "non-string or length > 128").
const MAX_TOKEN_LENGTH = 128;

// ⚠ THE one failure literal. Frozen, and reached through `neutralFailure()` only.
// ⚠ Copy status: proposed, not signed (the consolidated §UC-ML-006 OPEN).
const NEUTRAL_FAILURE = Object.freeze({
  error: 'Odkaz na prihlásenie už nie je platný. Požiadajte o nový na prihlasovacej obrazovke.',
});

function neutralFailure(res) {
  return res.status(401).json(NEUTRAL_FAILURE);
}

// Burn the token and resolve the friend, atomically. Returns `{ friend, session }` on
// the one success path and `null` on every other.
//
// ⚠ THE BURN COMMITS EVEN WHEN THE ACCOUNT TURNS OUT TO BE INELIGIBLE. Returning null
// from the callback is not a rollback (better-sqlite3 only rolls back on a throw), and
// that is deliberate per §UC-ML-005 step 2: a token that reached an inactive or
// credential-less account must not stay redeemable. An expired or already-used token,
// by contrast, is never touched at all — the UPDATE's own predicates refuse it.
function redeemLoginToken(rawToken) {
  const tokenHash = hashLoginToken(rawToken);
  const now = Date.now();

  return db.transaction(() => {
    const claim = db
      .prepare(
        'UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?'
      )
      .run(now, tokenHash, now);
    // Unknown, expired, already used — one branch, no oracle.
    if (claim.changes !== 1) return null;

    // Safe as a second statement: the UPDATE above already claimed this row inside
    // this transaction, so nothing else can be holding it. `token_hash` is UNIQUE.
    const row = db.prepare('SELECT friend_id FROM login_tokens WHERE token_hash = ?').get(tokenHash);
    const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(row.friend_id);
    // Same eligibility as the request half: active, and a password to recover. A
    // credential-less legacy friend must not gain a login side-door here.
    if (!friend || !friend.password_hash) return null;

    // ⚠ 24 h, and NO remember opt-in at redemption (resolved by the product owner
    // 2026-08-15): a link can be opened on any device that reaches the friend's
    // mailbox, including a borrowed one. The 60-day session stays an explicit
    // checkbox on the login screen. `via` is written here and NOWHERE else.
    //
    // Sharing the transaction is fine — every write in this flow is synchronous and
    // sub-millisecond, with no bcrypt anywhere (the IA-T3 invariant is about hashing,
    // not about statement count).
    const session = createFriendSession(friend.id, { via: 'magic_link' });
    return { friend, session };
  })();
}

router.post('/redeem', authLimiter, (req, res) => {
  // ⚠ TYPE AND LENGTH FIRST — `hashLoginToken` throws a TypeError on a non-string
  // (ML-T1 handover), and a 500 with a stack is both a broken contract and a
  // difference an attacker can steer into. This is NOT a 400: see rule 2 above.
  const rawToken = req.body?.token;
  if (typeof rawToken !== 'string' || !rawToken || rawToken.length > MAX_TOKEN_LENGTH) {
    return neutralFailure(res);
  }

  // Modern-mode only (01-architecture). Checked BEFORE the write, so a legacy-mode
  // attempt leaves an outstanding token intact rather than silently burning it.
  if (getAuthMode() !== 'modern') return neutralFailure(res);

  let redeemed = null;
  try {
    redeemed = redeemLoginToken(rawToken);
  } catch (e) {
    // A failure inside the write must not surface as a 500 either — that is a
    // difference visible to a caller, on exactly the path that does the extra work.
    console.error(`[magic-link] redeem failed: ${e?.message || 'unknown error'}`);
    return neutralFailure(res);
  }
  if (!redeemed) return neutralFailure(res);

  const { friend, session } = redeemed;

  // ⚠ MIRRORS `POST /friends/auth`'s personal branch (friends.js) field for field, so
  // the frontend reuses its login handling verbatim — plus `viaMagicLink`, which
  // ML-T6's prompt keys off. HAND-PICKED FIELDS, never the row itself: `invite_code`,
  // `access_token`, `password_hash` and `google_sub` stay unpublished (07 §UC-IA-005).
  res.json({
    success: true,
    friend: {
      id: friend.id,
      name: friend.name,
      uid: friend.uid,
      username: friend.username,
      packeta_address: friend.packeta_address,
    },
    token: session.token,
    expiresAt: session.expiresAt,
    hasCredentials: true,
    // Routes into the EXISTING forced-change gate (03 §UC-FL-012) exactly as a
    // password login does — the forced flow wins over the §UC-ML-008 prompt.
    mustChangePassword: !!friend.must_change_password,
    viaMagicLink: true,
  });
});

export default router;
