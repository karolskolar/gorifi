// FUP-T13 — the THIRD non-string body class: a request field that reaches a
// SQLite BIND PARAMETER (or a numeric coercion feeding one) without ever being
// type-checked.
//
// ⚠ THIS IS NOT THE BCRYPT CLASS (FUP-T10/T11) AND NOT THE STRING-METHOD CLASS
// (FUP-T12), which is exactly why FUP-T12's sweep correctly left these alone.
// Nothing here calls a method on the value at all — the throw comes from
// better-sqlite3's binder, and it has three distinct shapes, all measured
// against a running server:
//
//   `{}`            → RangeError: Too few parameter values were provided
//                     (better-sqlite3 reads a plain OBJECT as a NAMED-parameter
//                     map, finds none of the statement's `?` slots, and refuses)
//   `['a','b','c']` → RangeError: Too many parameter values were provided
//                     (an ARRAY argument is SPREAD into the positional slots)
//   `true`          → TypeError: SQLite3 can only bind numbers, strings,
//                     bigints, buffers, and null
//   `{toString:1}`  → TypeError: Cannot convert object to primitive value, when
//                     the value first passes through `parseInt`/`parseFloat`
//                     (ToPrimitive CALLS `toString`; a non-callable one throws —
//                     the FUP-T12 review's lesson, and the reason `String(x)` is
//                     not a coercion guard either)
//
// Every one of those is a 500 `Nieco sa pokazilo` plus a FULL STACK IN THE
// SERVER LOG for a body that is merely malformed — the FUP-T3/FUP-T7 rule
// verbatim: a client-triggerable branch must not cost a stack per hit, or it is
// a free remote log-flood.
//
// ⚠ A ONE-ELEMENT ARRAY IS THE TRAP HERE, AND IT IS THE MIRROR IMAGE OF
// FUP-T11's. There, `['x'].length === 1` made a length rule refuse by accident.
// Here, `run(['abc'], a, b, c, d, e)` spreads to exactly the six values a
// six-slot statement wants, so `{"name":["abc"]}` was ACCEPTED and stored the
// bare string `abc` — a silent success that no shape matrix built from the
// crashing shapes would ever have noticed.
//
// ⚠ WHY A SHARED HELPER HERE WHEN FUP-T12 DELIBERATELY REFUSED ONE. That row's
// thrower was `String.prototype.trim` — a language builtin with no choke point,
// reached by 20 unrelated call sites whose four body-text helpers each preserved
// a DIFFERENT falsy semantics, so a single helper could only have been a
// convenience the next call site skipped. This class is the opposite on both
// counts: there is exactly ONE thrower (the binder), and exactly ONE question to
// ask of a value ("can SQLite bind this?"). The helper answers only that. It
// carries NO policy — what an "absent" field then means is decided at each call
// site by whichever check the route already had, so no route's shipped behaviour
// is centralised here and none of them can drift into each other.

// Returns a value better-sqlite3 can bind as-is, or `undefined` for anything it
// cannot.
//
//   • a string          → itself (INCLUDING a non-numeric one bound to a REAL
//                         column: `price_250g: 'abc'` has always stored the text
//                         `abc`, and this row is not the place to change it)
//   • a finite number   → itself
//   • `null`            → `null`, so an EXPLICIT null still CLEARS the column on
//                         every route whose gate is `x !== undefined`
//   • everything else   → `undefined`
//     (objects, arrays, booleans, NaN, Infinity, and `undefined` itself)
//
// ⚠ `undefined` IS THE DELIBERATE RETURN VALUE, not `null`, and the distinction
// is the FUP-T12 "treat as absent, never coerce to NULL" rule made structural:
//   • better-sqlite3 binds `undefined` as NULL, so on an INSERT an unbindable
//     field stores exactly what an ABSENT field stores — byte-identical, no new
//     branch needed;
//   • on an UPDATE every gate in this repo is `if (x !== undefined)`, so an
//     unbindable field SKIPS THE WRITE and the stored value survives. Returning
//     `null` instead would answer 200 while WIPING real data (a friends
//     password, a stock limit, a cycle's name) — a guard that passes every
//     status assertion and still erases, which is why the tests for this row
//     assert the value READ BACK and not merely the status.
export function bindValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (v === null) return null;
  return undefined;
}

// The same question for one element of a list of records (`variants[i]`,
// `bakery_product_ids[i]`). A caller may send `[null]`, `[1]` or `['a','b']`,
// and reading `.price` off `null` is a TypeError long before any bind — so the
// element itself has to be shape-checked, not just its fields.
export function bindRecord(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
