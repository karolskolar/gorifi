# Session — Guest roastery feedback survey design

**Date:** 2026-05-26
**Branch:** `main`

## Summary

Non-code session. Designed a follow-up survey for friends about the guest coffee roastery that was offered alongside Gorifi in the last cycle. Goal: inform three decisions at once — keep/drop the guest roastery, adjust the offering (taste profile, brand positioning), and learn buyer vs non-buyer behavior. Output is a 5-question survey with branching, intended for an external tool (Google Forms / Typeform), to be translated to Slovak before sending.

## Files Changed

- `SESSION.md` — this file (session log refresh).

No repo code was modified. The survey draft was delivered inline in the conversation; the user is sending it manually.

## Current State

- No code changes pending in the working tree beyond `SESSION.md`.
- Untracked files (`.superpowers/`, `deploy/.windsurf/`, `deploy/WARP.md`, `docs/brand/`) were present at session start and are unrelated to today's work — leaving them untouched.
- Previous session's feature (`unpaid_count` badge on admin cycle cards) is already committed as `dfa711f` and presumably deployed.

## Survey draft (for reference)

5 questions with branching. Most respondents see ~4.

- **Q1.** Did you order coffee from the new roastery in the last cycle? (Yes / No, noticed it / No, didn't realize)
- **Q2** [if Yes]. How did it compare to your usual Gorifi pick? (5-point scale + "can't compare")
- **Q3a** [if Yes]. Would you order from this roastery again? (regularly / occasionally / only if profile changes / probably not)
- **Q3b** [if No]. Main reasons you didn't order? (up to 2 from: trust/loyalty, taste mismatch, already had Gorifi, description didn't sell me, didn't get around to it, other)
- **Q4** [everyone]. If we match your preferred taste profile, would you try it? Multi-select profiles (fruity, chocolatey, floral, dark, decaf, happy-with-Gorifi).
- **Q5** [optional]. Free-text catch-all.

All required except Q5. Translate to Slovak before sending. Pilot with 2–3 friends before broad send.

## Next Steps

1. Translate the 5 questions to Slovak.
2. Build the form in Google Forms or Typeform with the branching logic.
3. Pilot with 2–3 friends (one buyer, one non-buyer) to verify branching and clarity.
4. Send to the whole friend pool; keep open ~1 week with one mid-week reminder.
5. After responses come in, cross-check Q1 "Yes" answers against actual order data for the cycle as a sanity check.

## How to Test

N/A — no code changes. Verification is on the survey content itself (pilot run with 2–3 friends).
