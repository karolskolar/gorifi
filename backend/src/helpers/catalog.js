import db from '../db/schema.js';

// Catalog identity + fuzzy matching (12 §UC-PC-002, PC-T1).
//
// ⚠ THE ONE HOME for the normalization pipeline and the similarity measure.
// Two normalizers drifting is how duplicates return (01-architecture): the
// importers (UC-PC-003), the manual POST (UC-PC-005), the migration (UC-PC-006),
// the merge tool (UC-PC-007) and the duplicates review (UC-PC-008) must ALL
// import from here. Never re-inline any of this.

// normalizeProductName — the identity key behind coffee_products'
// UNIQUE(normalized_name, roastery). Deterministic pipeline, exactly as spec'd:
//   String(s) → Unicode NFD → strip combining marks (U+0300–036F) → lowercase →
//   replace every run of characters outside [a-z0-9] with a single space → trim.
// Examples: '  Pink  Bourbon – Honey ' → 'pink bourbon honey';
// 'CERRO AZUL' → 'cerro azul'; 'Mliečna Čokoláda!' → 'mliecna cokolada'.
// Empty/whitespace-only input normalizes to '' — callers must treat '' as
// "no identity, never match" (the importers' existing `if (name)` skip).
export function normalizeProductName(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// normalizeRoastery — trim(s) when non-empty, else the `roasteries` table's
// is_default row's name (seeded 'Goriffee'). Matching and catalog storage always
// use the resolved name (resolved decision 3). Deliberately NOT case-folded and
// NOT run through normalizeProductName: the roastery is a display name and the
// existing `products.roastery` / `roasteries.name` values are stored verbatim.
export function normalizeRoastery(s) {
  const trimmed = typeof s === 'string' ? s.trim() : '';
  if (trimmed !== '') return trimmed;
  const row = db.get('SELECT name FROM roasteries WHERE is_default = 1 ORDER BY id LIMIT 1');
  return row ? row.name : 'Goriffee';
}

// FUZZY_THRESHOLD — a pair is a fuzzy near-miss when
// FUZZY_THRESHOLD ≤ similarity < 1. Exact (similarity = 1, i.e. equal normalized
// names) is never "fuzzy". Shipped as a sensible default, tunable from data
// (the brief's Decision-5 posture).
export const FUZZY_THRESHOLD = 0.75;

// Plain Levenshtein distance — in-repo, no fuzzy-string dependency
// (01-architecture). The candidate set is ~tens of rows, so O(n·m) is free.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// nameSimilarity — Levenshtein similarity over the two NORMALIZED names.
//
// ⚠ DELIBERATE DEVIATION from 12 §UC-PC-002's prose formula, recorded here and
// in catalog-foundation.spec.js: the spec writes
// `1 − distance / max(len_a, len_b)`, but that yields 0.667 for its own pinned
// fuzzy example ('pink bourbon' vs 'pink bourbon honey' — distance 6, max 18),
// BELOW the 0.75 threshold the same UC's acceptance criteria require that pair
// to clear. The acceptance examples are the contract UC-PC-003/008 build on, so
// the denominator is `len_a + len_b` (0.80 / 0.52 for the two pinned pairs;
// equal names still score exactly 1, disjoint names bottom out well below the
// band). Do not "fix" this back to max() without re-deriving the examples.
//
// Inputs are re-normalized defensively (the pipeline is idempotent, so
// already-normalized keys pass through unchanged). '' means "no identity, never
// match": any comparison involving an empty normalized name scores 0 — including
// '' vs '', which must never read as an exact match.
export function nameSimilarity(a, b) {
  const na = normalizeProductName(a);
  const nb = normalizeProductName(b);
  if (na === '' || nb === '') return 0;
  if (na === nb) return 1;
  return 1 - levenshtein(na, nb) / (na.length + nb.length);
}
