import { createRouter, createWebHistory } from 'vue-router'

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
    path: '/admin/friends',
    name: 'admin-friends',
    component: () => import('./views/AdminFriends.vue')
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

export default router
