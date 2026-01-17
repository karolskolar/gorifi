const API_BASE = import.meta.env.VITE_API_URL || '/api'

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`
  const config = {
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
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

  // Friends
  getFriends: (cycleId) => request(`/friends/cycle/${cycleId}`),
  getFriendByToken: (token) => request(`/friends/token/${token}`),
  createFriend: (data) => request('/friends', { method: 'POST', body: data }),
  updateFriend: (id, data) => request(`/friends/${id}`, { method: 'PATCH', body: data }),
  deleteFriend: (id) => request(`/friends/${id}`, { method: 'DELETE' }),
  regenerateToken: (id) => request(`/friends/${id}/regenerate-token`, { method: 'POST' }),

  // Orders
  getOrderByToken: (token) => request(`/orders/token/${token}`),
  updateOrder: (token, items) => request(`/orders/token/${token}`, { method: 'PUT', body: { items } }),
  submitOrder: (token) => request(`/orders/token/${token}/submit`, { method: 'POST' }),
  getOrders: (cycleId) => request(`/orders/cycle/${cycleId}`),
  markPaid: (id, paid) => request(`/orders/${id}/paid`, { method: 'PATCH', body: { paid } }),
}

export default api
