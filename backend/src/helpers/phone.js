import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

// ═══════════════════════════════════════════════════════════════════════════
// PHONE → E.164 — THE ONE NORMALISER (21 §UC-WA-002, shipped by 19 §UC-GL-004).
//
// Module 19 needs it first (the waitlist's `(host, phone_e164)` idempotency key);
// module 21 ADOPTS THIS FILE UNCHANGED for `friends.phone_e164` /
// `guest_orders.phone_e164` (WA-T1). Whichever lands first ships the contract; the
// other consumes it — never a second copy, never a regex fallback.
//
//   toE164(raw, { defaultCountry = 'SK' } = {}) → '+421905123456' | null
//
// - `raw` is coerced with `String(raw ?? '').trim()`; empty ⇒ null. A value whose
//   `String()` throws (an object with a non-callable `toString`) is null too.
// - `parsePhoneNumberFromString(raw, defaultCountry)`, gated on `isValid()`: a
//   national `09xx…`, an international `00421…` and `+421…` all converge; a Czech
//   `+420…` stays Czech (the library's metadata — no hand-rolled prefix logic).
// - ⚠ NEVER THROWS. A phone must never 500 a checkout or a waitlist signup: every
//   failure — unparsable input, an unknown country, a library error — is null.
// - ⚠ NORMALISATION NEVER REFUSES A WRITE. Callers keep their length-only validation
//   and store `phone_e164 = NULL` when this returns null (the composer later lists
//   such a row as „bez platného čísla").
//
// `/min` metadata is sufficient (21 §UC-WA-002). `grep -rn parsePhoneNumber
// backend/src` must hit THIS file only.
// ═══════════════════════════════════════════════════════════════════════════

// The options object is read INSIDE the try (not destructured in the parameter list),
// so even `toE164(x, null)` answers null instead of throwing a TypeError.
export function toE164(raw, options = {}) {
  try {
    const defaultCountry = options?.defaultCountry ?? 'SK';
    const text = String(raw ?? '').trim();
    if (!text) return null;
    const parsed = parsePhoneNumberFromString(text, defaultCountry);
    if (!parsed || !parsed.isValid()) return null;
    return parsed.number || null;
  } catch {
    return null;
  }
}
