// 15 §UC-PL-004 — THE ONE CLIENT HOME for "turn a payment block into links and a
// Pay-by-Square payload".
//
// The server owns what is OWED (`backend/src/helpers/payment.js`: the variable symbol,
// the reference, the amount, the bank details). This file owns how that is handed to a
// payment app: a `revolut.me` link, a `payme.sk` deep link and the object `bysquare`
// encodes into the QR. Nothing here invents a symbol, a reference or an amount — props
// in, links out.
//
// ⚠ TWO CONSUMERS, AND THAT IS THE WHOLE REASON THIS IS A MODULE. `PaymentModal.vue`
// (the shared Platba modal, three callers) AND `FriendOrder.vue`'s success modal
// („Hotovo!“) each compose a QR and a Revolut link for the SAME order. They were two
// hand-written copies; the friend's first QR would otherwise be the one without the
// variable symbol. §UC-PL-004/D6 — 01-architecture's "pure URL composition in
// PaymentModal.vue" means client-side, no outbound call, no dependency, NOT "inline in
// that file".
//
// ⚠ NOT ADMIN CODE. It imports `./money.js`, which is friend/guest-only by its own
// header, and `payment-links.spec.js` sweeps every `/admin/...` view in `router.js` to
// prove none of them imports this file or `PaymentModal.vue`.
//
// ⚠ EVERY VALUE THAT ENTERS A URL GOES THROUGH `encodeURIComponent`, AND THIS IS A
// HAND-OFF, NOT A HABIT. PL-T1 recorded it explicitly: `payment_creditor_name` is
// validated for LENGTH ONLY — no control-character, newline or whitespace rule, matching
// the IBAN and the Revolut handle beside it. A name containing `&`, `#`, `%`, `+` or a
// newline is harmless while it is only stored and echoed, and becomes a broken (or
// forged) payment link the moment it is interpolated raw: `CN=A & B` would end the `CN`
// parameter early and introduce a parameter named ` B`. So: no template literal ever
// receives a raw value here. Pinned by `payment-links.spec.js`, which asserts the
// PARAMETER KEY SET of a link built from a hostile name — a raw interpolation grows a
// ninth key and fails, where a value-only assertion would not.
//
// ⚠ THE CONVERSE, AND IT BIT ONCE: "encode everything" is not the rule either. Encode
// VALUES, never STRUCTURE. The `PI=/VS…/SS/KS` triplet's slashes are the parameter's
// shape and stay bare (see `paymeLink` below); only the symbol between them is encoded.
//
// ⚠ THE RELATIVE `./money.js` IMPORT IS DELIBERATE (the rest of the app writes
// `@/lib/money`). Without the Vite alias this module is importable by a plain `node`
// process, which is what lets `payment-links.spec.js` drive the three builders
// directly — over inputs no fixture can conjure (a hostile creditor name, a zero
// amount, the flag flipped off). The alias would make that impossible and buy nothing.

import { PaymentOptions, CurrencyCode } from 'bysquare'
import { roundMoney } from './money.js'

// ⚠ R6.1 IS NOT VERIFIED ON A REAL PHONE YET, AND THIS CONSTANT IS THE WHOLE FALLBACK.
// Revolut has changed its link format before. If `?amount=&currency=` does not prefill
// in the app (or breaks the link outright), flip this to `false`: `revolutLink()` then
// returns the plain profile link for every amount and `PaymentModal.vue` drops the
// amount from the label. ONE line, ONE place — and `payment-links.spec.js` proves it by
// importing a copy of this file with exactly that one line flipped.
export const REVOLUT_AMOUNT_LINK = true

// PayMe's `MSG` field. ⚠ OPEN (§UC-PL-004 rule 3, same status as the 70-char `CN` bound
// in `helpers/payment.js`): payme.sk's developer page states no caps and the SBA Payment
// Link Standard PDF is not text-extractable, so 140 is the defensible default, not a
// verified quote. If the published standard differs, this constant moves alone.
const MAX_PAYME_MESSAGE_LENGTH = 140

/** `YYYYMMDD` for today — the same derivation `PaymentModal.generateQr()` shipped with. */
function todayCompact() {
  const t = new Date()
  return t.getFullYear().toString()
    + (t.getMonth() + 1).toString().padStart(2, '0')
    + t.getDate().toString().padStart(2, '0')
}

/** A trimmed string, or `''` — `null`/`undefined`/a number never reach a template. */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** A finite, strictly positive amount, or `null`. Anything else means "no link". */
function payableAmount(amount) {
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? roundMoney(amount) : null
}

/**
 * The Revolut profile link, with the amount prefilled when the flag allows it.
 *
 * `26.19` becomes `?amount=2619&currency=EUR` — Revolut takes MINOR units, so the
 * rounding is load-bearing twice over: `roundMoney` first (the float-drift incident in
 * `money.js`'s header), `Math.round` second (a half-cent can only come from drift).
 *
 * Returns `''` for a blank handle, which is the shipped gate: `PaymentModal` renders the
 * control only when `revolutUsername` is set.
 */
export function revolutLink(username, amount) {
  // The `@` is how a handle is written and shown; it is not part of the URL path. No
  // lower-casing: Revolut handles are case-insensitive, but the value is the admin's own
  // setting echoed back, and rewriting it would be a second transformation to explain.
  const handle = text(username).replace(/^@+/, '').trim()
  if (!handle) return ''

  const base = `https://revolut.me/${encodeURIComponent(handle)}`
  const payable = REVOLUT_AMOUNT_LINK ? payableAmount(amount) : null
  if (payable === null) return base
  return `${base}?amount=${Math.round(payable * 100)}&currency=EUR`
}

/**
 * The PayMe.sk deep link (Slovak Banking Association standard) — opens the payer's own
 * banking app with the transfer already filled in.
 *
 * `''` unless there is an IBAN, a creditor name AND a positive amount: PayMe has no
 * "payee unknown" form, and §UC-PL-002 rule 1 makes the creditor name the switch for
 * this whole feature. The caller renders the button only when this returns a link.
 */
export function paymeLink({ iban, amount, variableSymbol, reference, creditorName, date } = {}) {
  // ⚠ The IBAN is upper-cased and stripped of whitespace here and NOWHERE else on this
  // path: `payBySquarePayload` strips whitespace for the QR (as the shipped component
  // did) and the modal prints the stored, spaced form for a human to read. Three
  // renderings of one value, one source.
  const account = text(iban).replace(/\s/g, '').toUpperCase()
  // Trim is the blankness test AND what is sent: the server trims on write, so these are
  // the same string in practice, and a name of nothing but spaces must not buy a button.
  const name = text(creditorName)
  const payable = payableAmount(amount)
  if (!account || !name || payable === null) return ''

  const vs = text(variableSymbol)
  const note = text(reference).slice(0, MAX_PAYME_MESSAGE_LENGTH)

  const params = [
    'V=1',
    `IBAN=${encodeURIComponent(account)}`,
    `AM=${encodeURIComponent(payable.toFixed(2))}`,
    'CC=EUR',
    `DT=${encodeURIComponent(text(date) || todayCompact())}`,
  ]
  // `/VS<vs>/SS/KS` is the standard's payment-identification triplet with the two symbols
  // this app does not use left empty. Never emitted without a symbol: an empty
  // `PI=/VS/SS/KS` is a malformed identification, not an absent one.
  //
  // ⚠ THE STRUCTURAL SLASHES STAY BARE — THE VALUE INSIDE IS ENCODED, THE SHAPE IS NOT,
  // and this is the one place where "encode everything" was WRONG. A `/` is legal
  // unencoded in a query string, §UC-PL-006 and the published PayMe examples write this
  // parameter literally, and a receiving bank app that splits the RAW query instead of
  // URL-decoding it would read `%2FVS…%2FSS%2FKS` verbatim — a malformed identifier on
  // the single field that makes a bank statement match a person. ⚠ Neither a parsed
  // assertion (`searchParams.get('PI')` decodes, so both forms look identical) nor a raw
  // pin written against the encoded form can see this: `payment-links.spec.js` therefore
  // asserts the RAW `PI=` segment, character for character.
  // The symbol itself still goes through `encodeURIComponent`: it is server-derived
  // digits, so it costs nothing, and a refused/odd value can never break the shape.
  if (vs) params.push(`PI=/VS${encodeURIComponent(vs)}/SS/KS`)
  if (note) params.push(`MSG=${encodeURIComponent(note)}`)
  params.push(`CN=${encodeURIComponent(name)}`)

  return `https://payme.sk/?${params.join('&')}`
}

/**
 * The object `bysquare.encode()` turns into the Pay-by-Square QR.
 *
 * ⚠ THIS IS MONEY A BANK APP SCANS. It is the shipped payload of
 * `PaymentModal.generateQr()` / `FriendOrder.generateSuccessQr()` with exactly TWO
 * fields changed (§UC-PL-004): `variableSymbol` and `beneficiary.name`. Everything else
 * — the empty `invoiceId`, `constantSymbol`, `specificSymbol`,
 * `originatorsReferenceInformation`, `bic`, `street`, `city`, and the `paymentNote`
 * carrying the server's human reference — is byte-identical, and stays that way: both
 * encode sites are pinned by a pixel-level QR comparison (`guest-payment-modal.spec.js`,
 * `money-rounding.spec.js`).
 *
 * `beneficiary.name` is `creditorName || 'Gorifi'` (D3): with a creditor name configured
 * the QR and the PayMe link must not name two different payees in the same banking app;
 * with the setting blank the payload is byte-identical to what shipped.
 *
 * The caller still owns the two library calls — `encode(payload, { version:
 * Version['1.0.0'] })` and `QRCode.toDataURL(...)` — because the error handling around
 * them (the two status strings) is the caller's UI.
 */
export function payBySquarePayload({ amount, iban, variableSymbol, reference, creditorName, date } = {}) {
  return {
    invoiceId: '',
    payments: [{
      type: PaymentOptions.PaymentOrder,
      // ⚠ ROUNDED HERE, not in the caller. `bysquare` serialises the amount verbatim, so
      // float noise reaches the bank as `Nesprávna suma` — a real user's app refused
      // `26.189999999999998` while her screen read `26.19 EUR`. `FriendOrder.paymentTotal`
      // therefore stays UNROUNDED on purpose (its comment is load-bearing) and the rule
      // lives at the payload, where it holds for every caller.
      // ⚠ NOT `payableAmount()`: a missing amount must pass through unchanged (`roundMoney`
      // returns non-numbers as they are) rather than become a `0` payment request. The
      // modal has a shipped `'-'` guard for exactly that state.
      amount: roundMoney(amount),
      currencyCode: CurrencyCode.EUR,
      paymentDueDate: text(date) || todayCompact(),
      variableSymbol: text(variableSymbol),
      constantSymbol: '',
      specificSymbol: '',
      originatorsReferenceInformation: '',
      paymentNote: reference || '',
      // ⚠ `.replace` ON THE RAW VALUE, BYTE-IDENTICAL TO THE SHIPPED LINE, AND THE THROW
      // IS PART OF THE CONTRACT. A non-string `iban` must still blow up here so the
      // caller's catch arm paints „Nepodarilo sa vygenerovat QR kod." instead of a blank
      // 190×190 ink frame that reads as "scan me" — `guest-payment-modal.spec.js` drives
      // exactly that arm with an `iban: 123456` response. Guarding the type here would
      // silently encode a bad account number instead.
      bankAccounts: [{ iban: iban.replace(/\s/g, ''), bic: '' }],
      beneficiary: { name: text(creditorName) || 'Gorifi', street: '', city: '' },
    }],
  }
}
