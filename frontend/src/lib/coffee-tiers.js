// The roastery's volume tiers for the admin analytics views — a MIRROR of
// `backend/src/helpers/analytics.js TIER_THRESHOLDS` (PO 2026-10-04: the operator
// buys at 30 % off retail for 5–24.9 kg, 35 % for 25–49.9 kg, 40 % from 50 kg;
// friends always pay the 30 % price). Dependency-free so
// `e2e/tests/live-stats.spec.js` can import both files and pin them EQUAL — the
// views used to hard-code 26 / 51 kg in three places.
export const COFFEE_TIERS = [
  { minKg: 50, discount: 0.40, label: '40%' },
  { minKg: 25, discount: 0.35, label: '35%' },
  { minKg: 5, discount: 0.30, label: '30%' },
]

export const TIER_30_KG = 5
export const TIER_35_KG = 25
export const TIER_40_KG = 50
