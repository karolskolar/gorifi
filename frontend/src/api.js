const API_BASE = import.meta.env.VITE_API_URL || '/api'

// Store global friends password, token, and info for authenticated requests
let friendsPassword = null
let friendsToken = null
let friendsAuthInfo = null // { friendId, friendName, friendUid }

export function setFriendsPassword(password) {
  friendsPassword = password
}

export function getFriendsPassword() {
  return friendsPassword
}

export function setFriendsToken(token) {
  friendsToken = token
}

export function getFriendsToken() {
  return friendsToken
}

export function clearFriendsPassword() {
  friendsPassword = null
  friendsToken = null
  friendsAuthInfo = null
}

export function setFriendsAuthInfo(info) {
  friendsAuthInfo = info
}

export function getFriendsAuthInfo() {
  return friendsAuthInfo
}

// Legacy aliases for backward compatibility
export function setCyclePassword(password) {
  friendsPassword = password
}

export function getCyclePassword() {
  return friendsPassword
}

export function clearCyclePassword() {
  friendsPassword = null
}

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`
  const config = {
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
  }

  // Add auth header: prefer Bearer token, fall back to shared password
  if (friendsToken) {
    config.headers['Authorization'] = `Bearer ${friendsToken}`
  } else if (friendsPassword) {
    config.headers['X-Friends-Password'] = friendsPassword
  }

  // Add admin token if provided (from adminRequest helper)
  if (options.adminToken) {
    config.headers['X-Admin-Token'] = options.adminToken
    delete config.adminToken
  }

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    config.body = JSON.stringify(options.body)
  }

  if (options.body instanceof FormData) {
    delete config.headers['Content-Type']
  }

  const response = await fetch(url, config)

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Chyba servera' }))
    throw new Error(error.error || 'Chyba servera')
  }

  if (response.status === 204) {
    return null
  }

  return response.json()
}

function adminRequest(endpoint, options = {}) {
  const adminToken = localStorage.getItem('adminToken')
  if (adminToken) {
    options.adminToken = adminToken
  }
  return request(endpoint, options)
}

export const api = {
  // Admin
  checkSetup: () => request('/admin/setup-status'),
  setup: (password) => request('/admin/setup', { method: 'POST', body: { password } }),
  login: (password) => request('/admin/login', { method: 'POST', body: { password } }),
  verify: (token) => request('/admin/verify', { method: 'POST', body: { token } }),
  logout: () => request('/admin/logout', { method: 'POST' }),

  // Cycles
  getCycles: () => request('/cycles'),
  getCycle: (id) => request(`/cycles/${id}`),
  createCycle: (data) => request('/cycles', { method: 'POST', body: typeof data === 'string' ? { name: data } : data }),
  updateCycle: (id, data) => request(`/cycles/${id}`, { method: 'PATCH', body: data }),
  deleteCycle: (id) => request(`/cycles/${id}`, { method: 'DELETE' }),
  getCycleSummary: (id) => request(`/cycles/${id}/summary`),
  getCycleDistribution: (id) => request(`/cycles/${id}/distribution`),

  // Cycle public endpoints (for friend ordering - legacy)
  getCyclePublic: (id) => request(`/cycles/${id}/public`),
  authenticateCycle: (id, password, friendId) => request(`/cycles/${id}/auth`, {
    method: 'POST',
    body: { password, friendId }
  }),

  // Friends auth
  getAuthMode: () => request('/friends/auth-mode'),
  authenticateFriends: (password, friendId) => request('/friends/auth', {
    method: 'POST',
    body: { password, friendId }
  }),
  authenticateFriendsPersonal: (username, password) => request('/friends/auth', {
    method: 'POST',
    body: { username, password }
  }),
  setupCredentials: (friendId, username, password) => request(`/friends/${friendId}/setup-credentials`, {
    method: 'POST',
    body: { username, password }
  }),
  changeFriendPassword: (friendId, currentPassword, newPassword) => request(`/friends/${friendId}/change-password`, {
    method: 'PUT',
    body: { currentPassword, newPassword }
  }),
  checkUsername: (username) => request(`/friends/check-username/${username}`),
  getFriendsCycles: (friendId) => request(`/friends/cycles${friendId ? `?friendId=${friendId}` : ''}`),

  // Admin settings
  getAdminSettings: () => request('/admin/settings'),
  updateAdminSettings: (data) => request('/admin/settings', { method: 'PUT', body: data }),
  getPaymentSettings: () => request('/admin/payment-settings'),

  // Products
  getProducts: (cycleId) => request(`/products/cycle/${cycleId}`),
  createProduct: (data) => request('/products', { method: 'POST', body: data }),
  updateProduct: (id, data) => request(`/products/${id}`, { method: 'PATCH', body: data }),
  deleteProduct: (id) => request(`/products/${id}`, { method: 'DELETE' }),
  importProducts: (cycleId, formData) => request(`/products/import/${cycleId}`, { method: 'POST', body: formData }),
  importFromGoogleSheets: (cycleId, url) => request(`/products/import-gsheet/${cycleId}`, { method: 'POST', body: { url } }),
  importFromGoogleSheetsMultirow: (cycleId, url) => request(`/products/import-gsheet-multirow/${cycleId}`, { method: 'POST', body: { url } }),
  uploadProductImage: (id, formData) => request(`/products/${id}/image`, { method: 'POST', body: formData }),
  uploadProductImageFromUrl: (id, imageUrl) => request(`/products/${id}/image-from-url`, { method: 'POST', body: { url: imageUrl } }),

  // Friends (global)
  getFriends: (activeOnly = false) => request(`/friends${activeOnly ? '?active=true' : ''}`),
  createFriend: (data) => request('/friends', { method: 'POST', body: data }),
  updateFriend: (id, data) => request(`/friends/${id}`, { method: 'PATCH', body: data }),
  deleteFriend: (id) => request(`/friends/${id}`, { method: 'DELETE' }),
  updateFriendProfile: (id, data) => request(`/friends/${id}/profile`, { method: 'PATCH', body: data }),
  adminResetFriendPassword: (id, password) => adminRequest(`/friends/${id}/reset-password`, { method: 'PUT', body: { password } }),
  adminSetFriendUsername: (id, username) => adminRequest(`/friends/${id}/admin-username`, { method: 'PUT', body: { username } }),

  // Orders (password-protected, for friends)
  getOrderByFriend: (cycleId, friendId) => request(`/orders/cycle/${cycleId}/friend/${friendId}`),
  updateOrderByFriend: (cycleId, friendId, items) => request(`/orders/cycle/${cycleId}/friend/${friendId}`, {
    method: 'PUT',
    body: { items }
  }),
  submitOrderByFriend: (cycleId, friendId, pickupData = {}) => request(`/orders/cycle/${cycleId}/friend/${friendId}/submit`, {
    method: 'POST',
    body: pickupData
  }),

  // Orders (admin)
  getOrders: (cycleId) => request(`/orders/cycle/${cycleId}`),
  markPaid: (id, paid) => request(`/orders/${id}/paid`, { method: 'PATCH', body: { paid } }),
  togglePacked: (id) => request(`/orders/${id}/packed`, { method: 'PATCH' }),

  // Friends detail
  getFriendDetail: (id) => request(`/friends/${id}/detail`),
  getFriendBalance: (id) => request(`/friends/${id}/balance`),

  // Pickup locations
  getPickupLocations: (type) => request(type ? `/pickup-locations?type=${type}` : '/pickup-locations'),
  getAllPickupLocations: () => request('/pickup-locations/all'),
  createPickupLocation: (data) => request('/pickup-locations', { method: 'POST', body: data }),
  updatePickupLocation: (id, data) => request(`/pickup-locations/${id}`, { method: 'PATCH', body: data }),
  deletePickupLocation: (id) => request(`/pickup-locations/${id}`, { method: 'DELETE' }),

  // Bakery products (catalog)
  getBakeryProducts: () => request('/bakery-products'),
  getAllBakeryProducts: () => request('/bakery-products/all'),
  createBakeryProduct: (data) => request('/bakery-products', { method: 'POST', body: data }),
  updateBakeryProduct: (id, data) => request(`/bakery-products/${id}`, { method: 'PATCH', body: data }),
  deleteBakeryProduct: (id) => request(`/bakery-products/${id}`, { method: 'DELETE' }),
  uploadBakeryProductImage: (id, formData) => request(`/bakery-products/${id}/image`, { method: 'POST', body: formData }),

  // Subscriptions
  getSubscriptions: (friendId) => request(`/subscriptions/friend/${friendId}`),
  updateSubscriptions: (friendId, types) => request(`/subscriptions/friend/${friendId}`, { method: 'PUT', body: { types } }),
  adminUpdateSubscriptions: (friendId, types) => request(`/subscriptions/admin/${friendId}`, { method: 'PUT', body: { types } }),

  // Transactions
  getTransactions: (friendId) => request(`/transactions/friend/${friendId}`),
  addPayment: (friend_id, order_id, amount, note, date) => request('/transactions/payment', {
    method: 'POST',
    body: { friend_id, order_id, amount, note, date }
  }),
  addAdjustment: (friend_id, order_id, amount, note) => request('/transactions/adjustment', {
    method: 'POST',
    body: { friend_id, order_id, amount, note }
  }),
  updateTransaction: (id, data) => request(`/transactions/${id}`, {
    method: 'PATCH',
    body: data
  }),
  deleteTransaction: (id) => request(`/transactions/${id}`, { method: 'DELETE' }),

  // Analytics
  getCoffeeAnalytics: () => adminRequest('/analytics/coffee'),
  getLiveCycle: () => adminRequest('/analytics/live-cycle'),

  // Friend groups
  getFriendGroups: () => adminRequest('/friend-groups'),
  setRootStatus: (id, isRoot, force = false) => adminRequest(`/friend-groups/${id}/root-status${force ? '?force=true' : ''}`, {
    method: 'PATCH', body: { isRoot }
  }),
  assignRoot: (id, rootFriendId) => adminRequest(`/friend-groups/${id}/assign-root`, {
    method: 'PATCH', body: { rootFriendId }
  }),
  batchAssignRoot: (friendIds, rootFriendId) => adminRequest('/friend-groups/batch-assign', {
    method: 'PATCH', body: { friendIds, rootFriendId }
  }),

  // Rewards report
  getRewardsReport: (limit) => adminRequest(`/analytics/rewards${limit ? `?limit=${limit}` : ''}`),

  // Vouchers
  generateVouchers: (data) => adminRequest('/vouchers/generate', { method: 'POST', body: data }),
  getVouchers: (params) => {
    const query = new URLSearchParams()
    if (params?.status) query.set('status', params.status)
    if (params?.source_cycle_id) query.set('source_cycle_id', params.source_cycle_id)
    const qs = query.toString()
    return adminRequest(`/vouchers${qs ? `?${qs}` : ''}`)
  },
  getVoucherCycleFriends: (cycleId) => adminRequest(`/vouchers/cycle/${cycleId}/friends`),
  getPendingVouchers: (friendId) => request(`/vouchers/pending${friendId ? `?friendId=${friendId}` : ''}`),
  resolveVoucher: (id, action) => request(`/vouchers/${id}/resolve`, { method: 'POST', body: { action } }),

  // Invitations (public)
  validateInviteCode: (code) => request(`/invitations/code/${code}`),
  submitInvitation: (data) => request('/invitations/register', { method: 'POST', body: data }),

  // Invitations (friend auth - Bearer token auto-included, friendId as fallback)
  getMyInviteCode: (friendId) => request(`/invitations/my-code${friendId ? `?friendId=${friendId}` : ''}`),

  // Invitations (admin)
  getInvitations: (status) => adminRequest(`/invitations${status ? `?status=${status}` : ''}`),
  updateInvitation: (id, data) => adminRequest(`/invitations/${id}`, { method: 'PATCH', body: data }),
  deleteInvitation: (id) => adminRequest(`/invitations/${id}`, { method: 'DELETE' }),
}

export default api
