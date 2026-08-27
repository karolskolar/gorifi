import { createRouter, createWebHistory } from 'vue-router'
import api from './api'

const routes = [
  {
    path: '/',
    name: 'friend-portal',
    component: () => import('./views/FriendPortal.vue')
  },
  {
    path: '/cycle/:cycleId',
    name: 'friend-order',
    component: () => import('./views/FriendOrder.vue')
  },
  // Public guest ordering — no auth guard by design: the URL token is the whole
  // credential (a colleague with the link has no account).
  {
    path: '/g/:token',
    name: 'guest-order',
    component: () => import('./views/GuestOrder.vue')
  },
  // The guest's personal status/edit page — CANONICAL form (14 §UC-GR-003). Public
  // for the same reason as `/g/:token`: the URL token is the whole credential, and
  // `order_token` alone is now a full one (14 §UC-GR-001, D2 — same generator and
  // entropy as the link token, SEC-S2).
  //
  // ⚠ No collision is possible with either neighbour, and it is asserted by
  // NAVIGATION in `guest-order-recovery.spec.js` rather than by reading this file:
  // `/g/:token` is 2 segments, this is 3, the legacy pair is 4. The literal segment
  // `o` can never be a token — `generateGuestToken()` emits 14 chars of the uppercase
  // `CODE_ALPHABET`.
  {
    path: '/g/o/:orderToken',
    name: 'guest-order-status',
    component: () => import('./views/GuestOrderStatus.vue')
  },
  // The LEGACY pair form. Kept registered FOREVER (14 §UC-GR-002): the URL sits in
  // the guests' messages and in `localStorage.gorifi_guest_orders`, and nobody
  // migrates either. The `:token` half is URL carriage only — the view reads just
  // `orderToken`, and after a successful load it `router.replace`s to the canonical
  // route (D7) so anything re-copied from the address bar converges. ⚠ Never on a
  // 404: the dead card is diagnostic and must keep the URL the guest followed.
  {
    path: '/g/:token/o/:orderToken',
    name: 'guest-order-status-legacy',
    component: () => import('./views/GuestOrderStatus.vue')
  },
  {
    path: '/invite/:code',
    name: 'invite-register',
    component: () => import('./views/InviteRegister.vue')
  },
  // Magic-link recovery (09 §UC-ML-005). Public for the same reason as `/g/:token`
  // and `/invite/:code`: the URL token is the whole credential, and this is the path
  // for someone who cannot log in. ⚠ The document GET is side-effect-free — the view
  // spends the token with an explicit POST on mount, because mail scanners and
  // prefetchers follow GET links.
  {
    path: '/magic/:token',
    name: 'magic-login',
    component: () => import('./views/MagicLogin.vue')
  },
  {
    path: '/onboard/:token',
    name: 'onboarding',
    component: () => import('./views/OnboardingPage.vue')
  },
  {
    path: '/admin',
    name: 'admin-login',
    component: () => import('./views/AdminLogin.vue')
  },
  {
    path: '/admin/dashboard',
    name: 'admin-dashboard',
    component: () => import('./views/AdminDashboard.vue')
  },
  {
    path: '/admin/settings',
    name: 'admin-settings',
    component: () => import('./views/AdminSettings.vue')
  },
  {
    path: '/admin/vouchers',
    name: 'admin-vouchers',
    component: () => import('./views/AdminVouchers.vue')
  },
  {
    path: '/admin/bakery-products',
    name: 'admin-bakery-products',
    component: () => import('./views/AdminBakeryProducts.vue')
  },
  // Coffee product catalog — module 12 (PC-T7): the "unified import tool in
  // the main menu" (12 §UC-PC-009).
  {
    path: '/admin/catalog',
    name: 'admin-catalog',
    component: () => import('./views/AdminCatalog.vue')
  },
  {
    path: '/admin/analytics/live',
    name: 'analytics-live',
    component: () => import('./views/LiveCycleDashboard.vue')
  },
  {
    path: '/admin/analytics/coffee',
    name: 'analytics-coffee',
    component: () => import('./views/CoffeeAnalytics.vue')
  },
  {
    path: '/admin/analytics/bakery',
    name: 'analytics-bakery',
    component: () => import('./views/BakeryAnalytics.vue')
  },
  {
    path: '/admin/analytics/rewards',
    name: 'analytics-rewards',
    component: () => import('./views/AdminRewardsReport.vue')
  },
  {
    path: '/admin/friend-groups',
    name: 'admin-friend-groups',
    component: () => import('./views/AdminFriendGroups.vue')
  },
  {
    path: '/admin/friends',
    name: 'admin-friends',
    component: () => import('./views/AdminFriends.vue')
  },
  {
    path: '/admin/invitations',
    name: 'admin-invitations',
    component: () => import('./views/AdminInvitations.vue')
  },
  {
    path: '/admin/friends/:id',
    name: 'friend-detail',
    component: () => import('./views/FriendDetail.vue')
  },
  {
    path: '/admin/cycle/:id',
    name: 'cycle-detail',
    component: () => import('./views/CycleDetail.vue')
  },
  {
    path: '/admin/cycle/:id/distribution',
    name: 'distribution',
    component: () => import('./views/Distribution.vue')
  },
  // Legacy route for backward compatibility
  {
    path: '/order/:cycleId',
    redirect: to => ({ path: `/cycle/${to.params.cycleId}` })
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// Guard every /admin/* route (except the login page at /admin). Requires a
// valid admin token, verified server-side. This is defence-in-depth: the API
// now enforces admin auth on its own, but the guard stops unauthenticated
// users from loading admin views and gives a clean redirect when a token is
// missing or expired.
router.beforeEach(async (to) => {
  const needsAdmin = to.path.startsWith('/admin') && to.name !== 'admin-login'
  if (!needsAdmin) return true

  const token = typeof localStorage !== 'undefined' && localStorage.getItem('adminToken')
  if (!token) {
    return { name: 'admin-login' }
  }

  try {
    const result = await api.verify(token)
    if (result && result.valid) return true
  } catch (e) {
    // verify() throws on 401 / network error — treat as unauthenticated
  }

  localStorage.removeItem('adminToken')
  return { name: 'admin-login' }
})

// After a deploy the old hashed chunk files are gone (rsync --delete), so a
// tab loaded before the deploy fails its next lazy route import and the click
// appears dead. Recover by hard-navigating to the target URL — the fresh
// index.html references chunks that exist. sessionStorage guards a loop if
// the target genuinely can't load.
router.onError((error, to) => {
  const msg = String(error?.message || '')
  if (msg.includes('Failed to fetch dynamically imported module') || msg.includes('Importing a module script failed')) {
    const key = `chunk-reload:${to.fullPath}`
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1')
      window.location.assign(to.fullPath)
    }
  }
})

export default router
