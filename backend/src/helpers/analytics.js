// Tier thresholds: kg → the discount off RETAIL the operator BUYS at.
//
// PO 2026-10-04 (supersedes 5→30 % / 26→35 % / 51→40 %): friends always buy at
// 30 % off retail (BUYER_DISCOUNT); the operator buys at 35 % from 5 kg and at
// 40 % from 50 kg („5–49,9 kg → 35 %, nad 50 kg → 40 %"). Below 5 kg there is no
// tier and no margin. ⚠ Mirrored for the views in `frontend/src/lib/coffee-tiers.js`
// — `live-stats.spec.js` pins the two EQUAL.
export const TIER_THRESHOLDS = [
  { minKg: 50, discount: 0.40, label: '40%' },
  { minKg: 5,  discount: 0.35, label: '35%' },
];

// Buyer discount rate (what friends pay relative to retail)
export const BUYER_DISCOUNT = 0.30;

// Pack variants that are NOT tier volume (PO 2026-10-04): capsules (20 × 5 g) and
// brew bags (8 × 12 g) are priced per pack, outside the roastery's kg tiers, so they
// neither count toward the tier nor earn the tier margin. `variantToKg()` keeps
// their PHYSICAL weight for everything else (rewards, catalog stats, distribution).
export const NON_VOLUME_VARIANTS = new Set(['20pc5g', '8pc12g']);

export function isVolumeVariant(variant) {
  return !NON_VOLUME_VARIANTS.has(variant);
}

/**
 * Tier VOLUME in kg — `variantToKg()` minus the pack variants above. The one
 * function every „objem" figure (tier, progress bar, cycle card, margin basis) uses.
 */
export function volumeKg(variant, quantity) {
  return isVolumeVariant(variant) ? variantToKg(variant, quantity) : 0;
}

/**
 * Compute weight in kg from order_items variant and quantity.
 */
export function variantToKg(variant, quantity) {
  const map = {
    '250g':   0.250,
    '500g':   0.500,
    '1kg':    1.000,
    '150g':   0.150,
    '200g':   0.200,
    '20pc5g': 0.100,
    '8pc12g': 0.096,
  };
  return (map[variant] || 0) * quantity;
}

/**
 * Determine which tier a given total kg falls into.
 */
export function getTier(totalKg) {
  for (const tier of TIER_THRESHOLDS) {
    if (totalKg >= tier.minKg) return tier;
  }
  return null;
}

/**
 * Compute operator margin for a cycle.
 * Formula: margin = totalOrderValue × (1 - (1 - tierDiscount) / (1 - BUYER_DISCOUNT))
 *
 * ⚠ PO 2026-10-04: `totalOrderValue` is the value FRIENDS paid (at 30 % off retail,
 * VAT included — the operator pays VAT too) for TIER-VOLUME coffee of the default
 * roastery only: no guests, no capsules/brew bags, no other roastery. Callers build
 * it with `isVolumeVariant()`; passing the whole cycle value (as both dashboards did
 * until this date) overstated October 2026 at 259.18 against a true 179.54.
 */
export function computeMargin(totalOrderValue, totalKg) {
  const tier = getTier(totalKg);
  if (!tier || tier.discount <= BUYER_DISCOUNT) return 0;
  return totalOrderValue * (1 - (1 - tier.discount) / (1 - BUYER_DISCOUNT));
}

/**
 * Get the next tier above current kg, or null if at max.
 */
export function getNextTier(totalKg) {
  for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
    if (totalKg < TIER_THRESHOLDS[i].minKg) {
      return TIER_THRESHOLDS[i];
    }
  }
  return null;
}

/**
 * Classify a friend into a segment based on their order history.
 */
export function classifyFriend(orderedCycleIds, lastNCycleIds, isActive, totalCoffeeCycles) {
  if (!isActive) return { segment: 'inactive', label: 'Neaktívny', color: 'gray' };

  const n = lastNCycleIds.length;
  if (n === 0) return { segment: 'new', label: 'Nový', color: 'purple' };

  const recentCount = orderedCycleIds.filter(id => lastNCycleIds.includes(id)).length;
  const totalParticipated = orderedCycleIds.length;

  if (totalParticipated <= 2 && totalCoffeeCycles > 2) {
    return { segment: 'new', label: 'Nový', color: 'purple' };
  }

  const last2 = lastNCycleIds.slice(-2);
  const recentCount2 = orderedCycleIds.filter(id => last2.includes(id)).length;
  if (recentCount2 === 0 && totalParticipated > 0) {
    return { segment: 'inactive', label: 'Neaktívny', color: 'gray' };
  }

  if (recentCount === n) {
    return { segment: 'core', label: 'Jadro', color: 'green' };
  }

  if (n >= 2 && recentCount >= n - 1) {
    return { segment: 'regular', label: 'Pravidelný', color: 'blue' };
  }

  if (recentCount >= 1) {
    return { segment: 'occasional', label: 'Občasný', color: 'amber' };
  }

  return { segment: 'inactive', label: 'Neaktívny', color: 'gray' };
}

/**
 * Compute consecutive streak of recent cycles a friend ordered in.
 */
export function computeStreak(orderedCycleIds, allCycleIds) {
  let streak = 0;
  for (let i = allCycleIds.length - 1; i >= 0; i--) {
    if (orderedCycleIds.includes(allCycleIds[i])) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Determine order trend: 'up', 'down', or 'flat'.
 */
export function computeTrend(orderKgByCycle) {
  if (orderKgByCycle.length < 2) return null;
  const last = orderKgByCycle[orderKgByCycle.length - 1];
  const prev = orderKgByCycle[orderKgByCycle.length - 2];
  if (last > prev * 1.05) return 'up';
  if (last < prev * 0.95) return 'down';
  return 'flat';
}
