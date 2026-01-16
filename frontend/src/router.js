import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    name: 'home',
    redirect: '/admin'
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
    path: '/admin/cycle/:id',
    name: 'cycle-detail',
    component: () => import('./views/CycleDetail.vue')
  },
  {
    path: '/admin/cycle/:id/distribution',
    name: 'distribution',
    component: () => import('./views/Distribution.vue')
  },
  {
    path: '/order/:token',
    name: 'friend-order',
    component: () => import('./views/FriendOrder.vue')
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
