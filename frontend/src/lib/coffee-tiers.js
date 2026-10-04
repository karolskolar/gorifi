// The roastery's volume tiers for the admin analytics views — a MIRROR of
// `backend/src/helpers/analytics.js TIER_THRESHOLDS` (PO 2026-10-04: the operator
// buys at 35 % off retail from 5 kg and at 40 % from 50 kg; friends always pay the
// 30 % price). Dependency-free so `e2e/tests/live-stats.spec.js` can import both
// files and pin them EQUAL — the views used to hard-code 26 / 51 kg in two places.
export const COFFEE_TIERS = [
  { minKg: 50, discount: 0.40, label: '40%' },
  { minKg: 5, discount: 0.35, label: '35%' },
]

export const TIER_35_KG = 5
export const TIER_40_KG = 50
