# Bakery Self-Onboarding Links — Design Spec

**Date:** 2026-05-03

## Overview

Provide a public URL that lets new bakery customers self-register: they fill name, mobile, email, username, and password; an account is created immediately, subscribed only to bakery cycles, and they land logged-in on the friend portal. Admin can mint multiple campaign-labelled links over time (e.g. "May onboarding"), toggle them active/inactive, and regenerate the token if a URL leaks. Every friend created via a link is permanently stamped with the link's note so the admin can trace each friend's origin.

This flow is parallel to — not a replacement for — the existing per-friend referral invitations system used for coffee. The two share `friends` table fields but live in separate admin sections and behave differently (referrals require admin approval; onboarding does not).

## Scope

- One new table for shareable onboarding links with active/inactive toggle and regenerable token
- New columns on `friends` for phone, email, and origin tag
- Public onboarding page rendered for `/onboard/<token>` URLs
- Auto-login on submit using the existing modern-mode session-token mechanism
- Admin section inside the existing Pozvánky tab for managing onboarding links
- Origin badge on the admin friends list and read-only origin field in the friend edit modal

## Out of Scope

- Email/SMS confirmation of the new account
- Editing the `onboarding_source` after account creation
- Per-link analytics beyond a registration count
- Any modification to the existing coffee referral / `invitations` flow
- Anti-abuse measures beyond the active/inactive toggle (no rate limiting, no captcha)
- Filterable/sortable "origin" column on the friends list (badge only in v1)

## Data Model Changes

### `friends` table — three new columns

```sql
ALTER TABLE friends ADD COLUMN phone TEXT;
ALTER TABLE friends ADD COLUMN email TEXT;
ALTER TABLE friends ADD COLUMN onboarding_source TEXT;
```

- `phone` — nullable. Populated by this flow; manually editable in the friend edit modal.
- `email` — nullable. Same.
- `onboarding_source` — nullable. Set at create time to the onboarding link's `note` (e.g. `"May onboarding"`). Never updated thereafter, even if the link's note is later edited or the link is deleted. Friends not created via an onboarding link have `NULL`.

All three follow the project's `try/catch ALTER TABLE` migration pattern.

### `onboarding_links` table — new

```sql
CREATE TABLE IF NOT EXISTS onboarding_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  note TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- `token` — random URL-safe slug (16-char base62 generated via `crypto.randomBytes`). The shareable URL is `https://gorifi.skolar.sk/onboard/<token>`.
- `note` — required, free-text human label, also stamped onto friends as `onboarding_source` at signup time.
- `active` — `1` accepts new signups; `0` rejects them with a Slovak "link is no longer active" message.
- `created_at` — for sort order in the admin list.

No "submissions" table: a successful submit creates the friend directly. The `friends.onboarding_source` value is the audit link.

## Public Onboarding Flow

### URL & page lifecycle

- URL: `https://gorifi.skolar.sk/onboard/<token>` — same frontend host as the rest of the app, no separate subdomain.
- A new Vue route `/onboard/:token` renders an `OnboardingPage.vue` view.
- On mount, the page calls `GET /api/onboarding/:token` which returns one of:
  - `200 { active: true, note: "May onboarding" }` → render the form.
  - `200 { active: false }` → render "Tento odkaz už nie je aktívny" page.
  - `404` → render generic "Odkaz neexistuje" page.

### Form fields

All labels in Slovak.

| Label | Field | Required | Validation |
| --- | --- | --- | --- |
| Meno | `name` | yes | non-empty after trim |
| Mobil | `phone` | yes | non-empty after trim |
| Email | `email` | no | if present, must contain `@` |
| Užívateľské meno | `username` | yes | reuses existing `validateUsername` (regex `^[a-z0-9._-]{3,}$`, lowercased on submit) |
| Heslo | `password` | yes | min 4 chars (matches existing `reset-password` rule) |

Username availability check: on blur of the username field, the page calls `GET /api/onboarding/:token/check-username?u=<value>` (open to anyone with a valid active token) and shows a green/red hint. Reuses the existing `isUsernameTaken` helper.

### Submit endpoint

`POST /api/onboarding/:token` with body `{ name, phone, email?, username, password }`.

Server actions, in order:
1. Look up the link by `token`. If missing → `404 { error: "Neplatný odkaz" }`.
2. If `active = 0` → `403 { error: "Tento odkaz už nie je aktívny" }`.
3. Validate body fields. On failure → `400` with a Slovak error per the broken field.
4. Lowercase the username. If `isUsernameTaken(username, null)` → `409 { error: "Užívateľské meno je už obsadené" }`. Phone/email duplicates are allowed silently.
5. Generate `uid` and `invite_code` using the same helpers the existing flow uses.
6. Insert into `friends`: `name`, `phone`, `email`, `username`, `password_hash = hashPassword(password)`, `onboarding_source = link.note`, `uid`, `invite_code`, `active = 1`, plus `cycle_id` set to whatever placeholder value the existing global-mode friend creation paths use (the column is `NOT NULL` but unused since the global friends model — implementation must match the existing convention rather than inventing a new one).
7. Insert into `friend_subscriptions`: `(friend_id, type='bakery')`. No coffee subscription. The existing portal subscription filter therefore hides coffee cycles for this friend automatically.
8. Mint a session token using the existing `friend_sessions` table (the same mechanism the modern-mode login uses).
9. Return `201 { sessionToken, friendId, friendName }`.

### Post-submit UX

The frontend stores `sessionToken` and `friendId` in the same localStorage keys the modern-mode login uses (`gorifi_friend_auth`), then redirects to `/`. The friend lands on `FriendPortal` already authenticated, sees only bakery cycles.

## Admin UI

### Placement

A new section is added at the top of the existing **Pozvánky** tab (`AdminInvitations.vue`), above the existing referral invitations list. The header reads "Onboarding linky (pekáreň)".

### Layout

```
┌─ Onboarding linky (pekáreň) ─────────────────────────────┐
│                                          [+ Nový link]   │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ "May onboarding"          [Aktívny ●]    🔄  🗑      │ │
│ │ gorifi.skolar.sk/onboard/Xk8aLp2q…    [Kopírovať]    │ │
│ │ 7 registrácií · Vytvorené 3.5.2026                   │ │
│ └──────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ "Apr testing"             [Neaktívny ○]   🔄  🗑     │ │
│ │ gorifi.skolar.sk/onboard/9pQa…       [Kopírovať]     │ │
│ │ 2 registrácie · Vytvorené 18.4.2026                  │ │
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘

┌─ Pozvánky (priatelia) ───────────────────────────────────┐
│ <existing referral invitations list, unchanged>          │
└──────────────────────────────────────────────────────────┘
```

Each link card shows:
- The note (large, bold)
- An active/inactive toggle (visually like the existing friend `active` switch on `AdminFriends`)
- A regenerate icon (🔄) — confirm-then-replace; old URL stops working immediately
- A delete icon (🗑) — only enabled when `registration_count = 0`; tooltip explains why if disabled
- The full shareable URL with a "Kopírovať" button next to it
- A footer line: `<count> registrácií · Vytvorené <date>`

The "+ Nový link" button opens a small modal: one text input ("Note", e.g. *Máj onboarding*), one save button. On save, the backend generates the token and the new card appears at the top.

### Auth-mode warning banner

If `auth_mode = 'legacy'` (read from the existing settings endpoint), a yellow alert appears above the "Onboarding linky" header:

> *"Auth mode je 'legacy' — používatelia sa nebudú môcť prihlásiť, kým neprepneš na 'modern' v Nastaveniach."*

Friends are still created normally; only their ability to log in is gated. This avoids silent failures.

## Backend Routes

All admin routes use the project's existing client-side admin auth pattern (no server-side token check, per CLAUDE.md convention).

### Public

- `GET /api/onboarding/:token` — returns `{ active, note }` or `404`.
- `GET /api/onboarding/:token/check-username?u=<value>` — returns `{ available: true|false }`. Requires the token to exist and be active; otherwise `403`.
- `POST /api/onboarding/:token` — creates friend + subscription + session as described above.

### Admin

- `GET /api/onboarding-links` — returns `[{ id, token, note, active, created_at, registration_count }]`. The count comes from `SELECT COUNT(*) FROM friends WHERE onboarding_source = ?` per row (acceptable cost — admin list is small).
- `POST /api/onboarding-links` — body `{ note }`. Generates a 16-char base62 token via `crypto.randomBytes(12).toString('base64url')` and inserts.
- `PATCH /api/onboarding-links/:id` — body `{ active?, note? }`. Either or both fields can be updated.
- `POST /api/onboarding-links/:id/regenerate` — issues a new token and returns the updated row. The old URL becomes 404 immediately.
- `DELETE /api/onboarding-links/:id` — allowed only when `registration_count = 0`. Otherwise `400 { error: "Link už má registrácie, nemôže byť vymazaný — deaktivuj ho namiesto toho." }`.

## Origin Tracking in Admin Friends List

Two surfaces in `AdminFriends.vue`:

1. **Friend row.** When `friend.onboarding_source` is non-null, render a small grey badge (e.g. `border-gray-400 text-gray-600 bg-gray-50`, matching the existing pickup-location badge style) inline after the friend's name: `[May onboarding]`. Friends with `NULL` origin show no badge.
2. **Friend edit modal ("Upraviť priateľa").** Add three fields:
   - `Telefón` — editable text input bound to `phone`.
   - `Email` — editable text input bound to `email`.
   - `Pôvod onboardingu` — read-only label rendering `onboarding_source` (or "—" if null). Hidden when null to keep the modal compact.

The existing `PATCH /api/friends/:id/profile` endpoint is extended to accept `phone` and `email` (currently it only accepts `name` and `packeta_address`). `onboarding_source` is never accepted — set at create time only.

## Edge Cases & Guards

- **Auth mode = legacy.** Onboarding still creates the friend and stores `username`/`password_hash`. The implementation plan must verify whether the initial session-token returned by submit is honored by `FriendPortal` regardless of `auth_mode`; if it is, the friend is auto-logged-in for that session but cannot log in *again* (after expiry/logout) via the standard login form until the admin switches mode. If session-token auth is gated by `auth_mode`, the post-submit redirect must instead show a "Účet vytvorený — prihlásenie bude možné po prepnutí režimu" message. Either way, the admin sees the warning banner described above.
- **Inactive link.** Public page renders an "inactive" message; submit endpoint rejects with `403`.
- **Token regeneration.** Single browser-confirm prompt on the admin side. No cooldown. The new token is shown immediately and the old URL stops working.
- **Username collision.** Returns `409` with a Slovak field-level error so the username input can be re-prompted without losing the rest of the form state.
- **Phone/email duplicates.** Allowed silently. Two onboardings can produce two friend records with the same phone — admin can clean this up manually if it ever matters.
- **Deletion safety.** Deleting a link that has produced registrations breaks the audit trail (since `onboarding_source` is a free-text snapshot, not an FK, the data survives — but the *intent* of "I want to wipe this link" suggests confusion). Block deletion in that case and steer the admin to deactivate instead.
- **Concurrency.** Token uniqueness is enforced by the `UNIQUE` index. Username uniqueness is enforced by the existing helper. Otherwise no contention is expected at this volume.
- **Rate limiting.** None in v1. If abuse appears, adding a per-IP throttle to the public POST is a one-file change.

## Frontend Structure

New files:
- `frontend/src/views/OnboardingPage.vue` — the public onboarding form.
- Possibly a small `OnboardingLinksSection.vue` component to keep `AdminInvitations.vue` readable.

Modified files:
- `frontend/src/router.js` — adds the `/onboard/:token` route (no auth required).
- `frontend/src/views/AdminInvitations.vue` — adds the onboarding links section and the warning banner.
- `frontend/src/views/AdminFriends.vue` — adds the origin badge on each row and the phone/email/origin fields in the edit modal.
- `frontend/src/api.js` — adds the new endpoints under existing organisational sections.

Backend new file:
- `backend/src/routes/onboarding.js` — public + admin route handlers for this feature, mounted at `/api/onboarding` and `/api/onboarding-links` from `index.js`.

## Testing Plan

Manual testing on staging covers the realistic scenarios:

1. Admin creates a link with note "May onboarding", copies the URL.
2. URL opens in a private window: form renders, username availability check works, submit creates an account, browser lands on friend portal showing only bakery cycles.
3. Admin friends list shows the new friend with a grey "May onboarding" badge.
4. Admin edits the friend; phone and email are editable, origin is read-only.
5. Admin toggles the link to inactive; the same URL now shows the inactive message.
6. Admin regenerates the token; the previous URL 404s; the new URL works.
7. Admin attempts to delete the link → blocked with the "deactivate instead" message.
8. Admin creates a second link "Jún onboarding"; new submissions get tagged with that note instead.
9. Submit with a username that already exists → 409 surfaced as a field error; rest of form preserved.
10. With `auth_mode = legacy`, the warning banner appears; created friend cannot log in until mode is switched.

No automated tests in this scope (project has none for similar features; matching the existing convention).
