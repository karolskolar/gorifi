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
  {
    path: '/invite/:code',
    name: 'invite-register',
    component: () => import('./views/InviteRegister.vue')
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

export default router
