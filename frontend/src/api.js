const API_BASE = import.meta.env.VITE_API_URL || '/api'

// Store global friends password for authenticated requests
let friendsPassword = null

export function setFriendsPassword(password) {
  friendsPassword = password
}

export function getFriendsPassword() {
  return friendsPassword
}

export function clearFriendsPassword() {
  friendsPassword = null
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

  // Add friends password header if set (new global auth)
  if (friendsPassword) {
    config.headers['X-Friends-Password'] = friendsPassword
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
  createCycle: (name) => request('/cycles', { method: 'POST', body: { name } }),
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

  // Friends global auth (new system)
  authenticateFriends: (password, friendId) => request('/friends/auth', {
    method: 'POST',
    body: { password, friendId }
  }),
  getFriendsCycles: (friendId) => request(`/friends/cycles${friendId ? `?friendId=${friendId}` : ''}`),

  // Admin settings
  getAdminSettings: () => request('/admin/settings'),
  updateAdminSettings: (data) => request('/admin/settings', { method: 'PUT', body: data }),

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

  // Orders (password-protected, for friends)
  getOrderByFriend: (cycleId, friendId) => request(`/orders/cycle/${cycleId}/friend/${friendId}`),
  updateOrderByFriend: (cycleId, friendId, items) => request(`/orders/cycle/${cycleId}/friend/${friendId}`, {
    method: 'PUT',
    body: { items }
  }),
  submitOrderByFriend: (cycleId, friendId) => request(`/orders/cycle/${cycleId}/friend/${friendId}/submit`, {
    method: 'POST'
  }),

  // Orders (admin)
  getOrders: (cycleId) => request(`/orders/cycle/${cycleId}`),
  markPaid: (id, paid) => request(`/orders/${id}/paid`, { method: 'PATCH', body: { paid } }),
  togglePacked: (id) => request(`/orders/${id}/packed`, { method: 'PATCH' }),

  // Friends detail
  getFriendDetail: (id) => request(`/friends/${id}/detail`),
  getFriendBalance: (id) => request(`/friends/${id}/balance`),

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
}

export default api
