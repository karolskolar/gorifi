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

  // Attach the admin token whenever one is present in storage. The backend now
  // enforces admin auth server-side (requireAdmin), and many admin calls go
  // through the plain request() path, so the token must ride along on every
  // request. It only exists in storage on admin pages; friend/public endpoints
  // simply ignore the header. An explicit options.adminToken still overrides.
  const adminToken = options.adminToken || (typeof localStorage !== 'undefined' && localStorage.getItem('adminToken'))
  if (adminToken) {
    config.headers['X-Admin-Token'] = adminToken
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
    const err = new Error(error.error || 'Chyba servera')
    if (error.field) err.field = error.field
    // The workbench create-collision 409 names the existing row so the UI can
    // offer assign instead (12 §UC-PC-006).
    if (error.catalog_id) err.catalogId = error.catalog_id
    // 16 §UC-DP-006/012 — the bulk hand-over's all-or-nothing 409 NAMES every
    // offender in THREE lists, and the board highlights exactly those rows. The
    // message alone cannot say which bag refused, so the lists have to survive the
    // throw. ⚠ Carried under their wire names' camelCase, like `catalogId` above;
    // additive, and nothing else reads these fields today.
    if (error.reason) err.reason = error.reason
    if (Array.isArray(error.order_ids)) err.orderIds = error.order_ids
    if (Array.isArray(error.guest_order_ids)) err.guestOrderIds = error.guest_order_ids
    if (Array.isArray(error.cancelled_guest_order_ids)) {
      err.cancelledGuestOrderIds = error.cancelled_guest_order_ids
    }
    throw err
  }

  if (response.status === 204) {
    return null
  }

  return response.json()
}

// Public guest ordering (`/g/:token`). Deliberately NOT `request()`: the URL
// token is the whole credential, so these calls must carry no Authorization, no
// X-Friends-Password and no X-Admin-Token — a token left in localStorage by a
// previous admin session must not change what a guest sees or can do.
// The HTTP status is attached to the thrown error because the guest page has to
// tell 404 (no such link) from 410 (~~closed~~ deactivated — a closed cycle is a 200
// `page:'preopen'` since 19 §UC-GL-002) from 409 (locked while shopping).
// ONE HOME for the guest sub-order endpoint (14 §UC-GR-001/003). Three call sites
// (status GET, edit PUT, invite-request POST) reach the same order two ways, so the
// choice is made here rather than three times:
//
//   canonical  `/guest/o/:orderToken`                — no link token exists
//   legacy     `/guest/:token/orders/:orderToken`    — a pair URL the guest followed
//
// Both resolve by `order_token` alone server-side (the `:token` half is URL carriage
// only), so the legacy branch exists purely so a page loaded from a pair URL keeps
// speaking the URL form it was opened with until D7's `router.replace` lands.
// ⚠ A falsy `token` is the NORMAL case on `/g/o/:orderToken` — the route has no such
// param — not a bug to guard against with a throw.
const guestOrderPath = (token, orderToken) => (token
  ? `/guest/${encodeURIComponent(token)}/orders/${encodeURIComponent(orderToken)}`
  : `/guest/o/${encodeURIComponent(orderToken)}`)

async function guestRequest(endpoint, options = {}) {
  const config = {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  }
  if (options.body && typeof options.body === 'object') {
    config.body = JSON.stringify(options.body)
  }

  const response = await fetch(`${API_BASE}${endpoint}`, config)

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    const err = new Error(payload.error || 'Chyba servera')
    err.status = response.status
    if (payload.reason) err.reason = payload.reason
    if (payload.field) err.field = payload.field
    if (payload.details) err.details = payload.details
    throw err
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

  // 10 §UC-GA-011 — the admin logs in with Google. ⚠ PUBLIC, exactly like
  // `login()` above: the endpoint carries no admin guard (an anonymous caller has to
  // reach it or nobody could ever log in with it), and its response is the SAME
  // `{ token }` the password login returns, stored in the same `localStorage.adminToken`.
  // ⚠ There is exactly ONE admin token app-wide, so this REPLACES any token a password
  // login minted earlier — known behaviour (§UC-GA-011), not a bug.
  adminGoogleLogin: (idToken) => request('/admin/google-login', {
    method: 'POST',
    body: { id_token: idToken }
  }),

  // 10 §UC-GA-010 — the admin Google allowlist. All three are `requireAdmin`.
  // ⚠ The GET never carries a `sub`; the e-mail is both the display value and the
  // deletion handle, which is why `removeAdminGoogleAccount` takes one.
  // ⚠ Adding requires an ID TOKEN, never a typed address: the admin proves possession
  // of the account being added (01's "e-mails confirmed at link time").
  getAdminGoogleAllowlist: () => adminRequest('/admin/google-allowlist'),
  addAdminGoogleAccount: (idToken) => adminRequest('/admin/google-allowlist', {
    method: 'POST',
    body: { id_token: idToken }
  }),
  removeAdminGoogleAccount: (email) => adminRequest('/admin/google-allowlist', {
    method: 'DELETE',
    body: { email }
  }),

  // Cycles
  getCycles: () => request('/cycles'),
  getCycle: (id) => request(`/cycles/${id}`),
  createCycle: (data) => request('/cycles', { method: 'POST', body: typeof data === 'string' ? { name: data } : data }),
  updateCycle: (id, data) => request(`/cycles/${id}`, { method: 'PATCH', body: data }),
  deleteCycle: (id) => request(`/cycles/${id}`, { method: 'DELETE' }),
  getCycleSummary: (id, roastery) => request(`/cycles/${id}/summary${roastery ? `?roastery=${encodeURIComponent(roastery)}` : ''}`),
  getCycleDistribution: (id) => request(`/cycles/${id}/distribution`),
  // Print-ready rows for the A4 8-up label sheet. A sibling of the distribution
  // read, not a flag on it: this one carries contact details and NO money.
  getCycleLabels: (id) => request(`/cycles/${id}/labels`),
  // 16 §UC-DP-006/013 — „Odovzdať zabalené (n)": a whole group in ONE all-or-nothing
  // transaction. BOTH arrays are required (an empty one is fine, but at least one id
  // overall), every element a positive integer, ≤ 500 each. A guest whose host is in
  // the same batch is deduplicated server-side — send both ids without thinking.
  // Answers `{ handed_over, already_handed, guests_inherited, queued_notifications,
  // cycle_stage, handed_over_at }` — `handed_over_at` is the stamp the bags handed
  // over BY THIS CALL took (null when it stamped none). ⚠ A colleague who ordered
  // after their host's bag went out inherits that BAG's original stamp instead, so
  // re-fetch rather than painting this one onto every row. 409 `reason:
  // 'not_packed'` / `'cancelled'` NAMES
  // the offenders in `order_ids` / `guest_order_ids` / `cancelled_guest_order_ids`
  // and writes NOTHING, so the board highlights those rows and re-fetches.
  // ⚠ Ledger-neutral, like the per-bag routes. ⚠ There is NO bulk reversal (Phase 2)
  // — take a hand-over back one bag at a time with `setOrderHandedOver`.
  handOverDistributionBatch: (cycleId, orderIds = [], guestOrderIds = []) =>
    request(`/cycles/${cycleId}/distribution/hand-over`, {
      method: 'POST',
      body: { order_ids: orderIds, guest_order_ids: guestOrderIds },
    }),

  // Cycle public endpoints (for friend ordering - legacy)
  getCyclePublic: (id) => request(`/cycles/${id}/public`),
  authenticateCycle: (id, password, friendId) => request(`/cycles/${id}/auth`, {
    method: 'POST',
    body: { password, friendId }
  }),

  // Friends auth
  getAuthMode: () => request('/friends/auth-mode'),
  // ⚠ 09 §UC-ML-007 (ML-T4): `remember` is what buys the 60-day session; without it
  // the server issues its 24 h default (`createFriendSession`, ML-T1). BOTH branches
  // carry it — the legacy shared-password card has the same checkbox as the modern
  // one, and a friend who ticks it there must get the same horizon.
  // `=== true` keeps the wire value a real boolean, which also makes `remember`
  // strictly assertable in the e2e request interception.
  // ⚠ It is NOT the load-bearing check — the server's strict test is (ML-T1,
  // `createFriendSession`), and normalising a stray truthy to `false` here produces
  // the same 24 h outcome the server would produce anyway. Both call sites pass
  // `rememberMe.value`, which `NeoCheckbox` and native `v-model` guarantee is already
  // a boolean, so **deleting this `=== true` leaves the entire suite green**. Do not
  // read it as an invariant the way ML-T1's server-side pair should be read.
  authenticateFriends: (password, friendId, remember) => request('/friends/auth', {
    method: 'POST',
    body: { password, friendId, remember: remember === true }
  }),
  authenticateFriendsPersonal: (username, password, remember) => request('/friends/auth', {
    method: 'POST',
    body: { username, password, remember: remember === true }
  }),
  // 10 §UC-GA-003 / §UC-GA-005 — the GIS callback's credential goes straight here.
  //
  // ⚠ Same `request()` transport as the two login methods above, deliberately. The
  // endpoint is PUBLIC and ignores every auth header, so this is not the guest
  // surface's problem (`guestRequest` exists because a stray admin token there would
  // change what a guest is ALLOWED to do). Using `request()` keeps all three login
  // paths on one transport, which is what makes the response handling in
  // `FriendPortal.vue` identical for all three — the error message a failed Google
  // login shows is the server's own sentence, including the `not_linked` hint.
  //
  // ⚠ NO `remember` flag — product decision 2026-08-20: a Google login is always
  // remembered (the server mints the 60-day horizon unconditionally on this
  // route). The checkbox on the login card belongs to the PASSWORD group only;
  // it used to ride along here too, but nobody tapping the Google button below
  // the "alebo" divider ever ticked it, so Google logins always got 24 h.
  authenticateFriendsGoogle: (idToken) => request('/friends/auth/google', {
    method: 'POST',
    body: { id_token: idToken }
  }),
  setupCredentials: (friendId, username, password) => request(`/friends/${friendId}/setup-credentials`, {
    method: 'POST',
    body: { username, password }
  }),
  // GA-T11 (10 §UC-GA-004's security model, §UC-GA-007's surface) — the FIRST password
  // for a friend who has none. A separate endpoint from both neighbours on purpose:
  // `change-password` 400s without an existing password, and `setup-credentials` serves
  // the transition-mode flow and therefore cannot carry this route's modern-mode guard.
  // ⚠ `username` travels ONLY when the caller has one to offer — the server honours it
  // while `friends.username` is NULL and ignores it otherwise (never a rename).
  setFirstPassword: (friendId, password, username = null) => request(`/friends/${friendId}/set-password`, {
    method: 'POST',
    body: username ? { username, password } : { password }
  }),
  changeFriendPassword: (friendId, currentPassword, newPassword) => request(`/friends/${friendId}/change-password`, {
    method: 'PUT',
    body: { currentPassword, newPassword }
  }),
  checkUsername: (username) => request(`/friends/check-username/${username}`),

  // Magic-link recovery (09 §UC-ML-003 / §UC-ML-005). Both go through the standard
  // `request()`: the endpoints are public and anonymous, and an ambient Bearer header
  // is harmless on either — `/redeem` in particular is REACHED by someone who may
  // already be signed in as a DIFFERENT friend, and the server ignores the header
  // entirely (the URL token is the whole credential).
  // ⚠ The raw token travels in the BODY of a POST, never as a GET side effect: mail
  // scanners and link-prefetchers follow GET links, and a burned token would make the
  // human's own click land on "already used".
  requestMagicLink: (identifier) => request('/magic-link/request', {
    method: 'POST',
    body: { identifier }
  }),
  redeemMagicLink: (token) => request('/magic-link/redeem', {
    method: 'POST',
    body: { token }
  }),
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
  // (The three per-cycle importers retired in PC-T8 — 12 §UC-PC-013. Imports
  // target the catalog: importCatalogCSV / importCatalogGsheet* below.)
  uploadProductImage: (id, formData) => request(`/products/${id}/image`, { method: 'POST', body: formData }),
  uploadProductImageFromUrl: (id, imageUrl) => request(`/products/${id}/image-from-url`, { method: 'POST', body: { url: imageUrl } }),

  // Friends (global)
  getFriends: (activeOnly = false) => request(`/friends${activeOnly ? '?active=true' : ''}`),
  // Public minimal list (id + name + hasCredentials) for the legacy/transition login dropdown
  getFriendsLoginList: () => request('/friends/login-list'),
  // Own profile (owner token required) — hydrates the portal after login/restore
  getFriendProfile: (friendId) => request(`/friends/${friendId}/profile`),
  createFriend: (data) => request('/friends', { method: 'POST', body: data }),
  updateFriend: (id, data) => request(`/friends/${id}`, { method: 'PATCH', body: data }),
  deleteFriend: (id) => request(`/friends/${id}`, { method: 'DELETE' }),
  updateFriendProfile: (id, data) => request(`/friends/${id}/profile`, { method: 'PATCH', body: data }),
  adminResetFriendPassword: (id, password) => adminRequest(`/friends/${id}/reset-password`, { method: 'PUT', body: { password } }),
  adminSetFriendUsername: (id, username) => adminRequest(`/friends/${id}/admin-username`, { method: 'PUT', body: { username } }),
  // 11 §UC-FC-006 — admin severs a friend's Google link. ⚠ Deliberately a different
  // path from module 10's friend-owned `/friends/:id/google-link`; never merge them.
  // No body: the route names its two columns itself and ignores anything sent.
  adminUnlinkFriendGoogle: (id) => adminRequest(`/friends/${id}/google`, { method: 'DELETE' }),
  // 19 PO 2026-09-19 — the ADMIN half of a host's standing guest link (read mints
  // lazily, like the host's own; regenerate rotates only the standing token). Same
  // payload shapes as `getStandingGuestLink` / `regenerateStandingGuestLink`.
  adminGetFriendStandingLink: (id) => adminRequest(`/friends/${id}/guest-link/standing`),
  adminRegenerateFriendStandingLink: (id) =>
    adminRequest(`/friends/${id}/guest-link/standing/regenerate`, { method: 'POST' }),

  // 10 §UC-GA-004 — the FRIEND-OWNED half, called from the §UC-GA-006 post-login
  // prompt (and, from GA-T7, the profile modal). ⚠ Not `adminRequest`: both routes are
  // `requireFriendOwner`-guarded, so they need the friend's Bearer token, which
  // `request()` attaches. The 409s (`field:'google'` collision, `field:'auth_mode'`
  // legacy) arrive as a thrown Error whose message is the server's own Slovak
  // sentence — §UC-GA-006 renders it verbatim, so nothing here may rewrite it.
  linkFriendGoogle: (friendId, idToken) => request(`/friends/${friendId}/google-link`, {
    method: 'PUT',
    body: { id_token: idToken }
  }),
  // GA-T7 (§UC-GA-007) — the friend severs their OWN link from the profile modal.
  // ⚠ Deliberately NOT `adminUnlinkFriendGoogle` above: that one is `DELETE
  // /friends/:id/google` under `requireAdmin` (11 §UC-FC-006). Two paths, two guards,
  // never multiplexed — §UC-GA-004's path note. Idempotent 200 on an already-unlinked
  // friend, and the body carries `warning: 'no_password'` when the friend has no
  // password left to log in with, which §UC-GA-007 renders.
  unlinkFriendGoogle: (friendId) => request(`/friends/${friendId}/google-link`, {
    method: 'DELETE'
  }),
  // "Už sa nepýtať". No body, and no Google dependency — it answers on an
  // unconfigured deployment too. ("Teraz nie" has NO counterpart here on purpose:
  // §UC-GA-006 makes it client-side only.)
  dismissGooglePrompt: (friendId) => request(`/friends/${friendId}/google-prompt-dismissed`, {
    method: 'POST'
  }),
  // 18 §UC-PI-013 — „Už mi to neukazovať" on the first-login explainer gate. No body;
  // the server stamps `friends.explainer_seen_at` with `COALESCE`, so calling it twice
  // is a no-op rather than a fresh timestamp. Every caller is FIRE-AND-FORGET: the
  // friend is on their way to the shop and a failed stamp costs them one extra
  // explainer at their next login, which is not worth blocking a login over.
  markExplainerSeen: (friendId) => request(`/friends/${friendId}/explainer-seen`, {
    method: 'POST'
  }),

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
  // The admin's correction of a party's pickup point, keyed on (cycle, friend) rather
  // than on an order id — a host whose only stake is a colleague's bags has NO order
  // row and must still be addressable (PO decision, 2026-09-03). The server picks the
  // store (`orders`, else the share link); EXACTLY ONE of `{ pickup_location_id }` /
  // `{ pickup_location_note }` — both and neither are a 400. Returns the uniform
  // `{ pickup_location_id, pickup_location_note, pickup_location_name, stored_on,
  // cleared_parcel, parcel_fee_removed }`.
  setPartyPickup: (cycleId, friendId, data) =>
    request(`/orders/cycle/${cycleId}/friend/${friendId}/pickup`, { method: 'PATCH', body: data }),
  // 16 §UC-DP-004/013 — STAGE 3: „the bag left my hands". ⚠ ALWAYS an EXPLICIT
  // boolean, never a toggle like `togglePacked` above: a hand-over queues messages,
  // so the intent is stated and a double click converges instead of flipping back.
  // Answers `{ order: { …, stage }, guests: [{ id, handed_over_at, stage }],
  // queued_notifications, dequeued_notifications, cycle_stage }` — enough for the
  // board to patch its rows in place. 409 `reason: 'not_packed'` when the bag is not
  // packed yet; the reversal is always allowed.
  // ⚠ Ledger-neutral: unlike `togglePacked`, this writes NO balance transaction.
  setOrderHandedOver: (id, handedOver) =>
    request(`/orders/${id}/handed-over`, { method: 'PATCH', body: { handed_over: handedOver } }),
  toggleItemPacked: (itemId) => request(`/order-items/${itemId}/packed`, { method: 'PATCH' }),
  // GSO-T7: the same per-item Distribution checkbox for a guest bag. Separate
  // endpoint because the item lives in `guest_order_items`; the response carries the
  // same `order_packed` field, since unchecking a bag un-packs the HOST's order.
  toggleGuestItemPacked: (itemId) => request(`/guest-order-items/${itemId}/packed`, { method: 'PATCH' }),

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

  // Public onboarding (bakery self-signup)
  getOnboardingLink: (token) => request(`/onboarding/${token}`),
  checkOnboardingUsername: (token, username) =>
    request(`/onboarding/${token}/check-username?u=${encodeURIComponent(username)}`),
  submitOnboarding: (token, data) =>
    request(`/onboarding/${token}`, { method: 'POST', body: data }),

  // Invitations (friend auth - Bearer token auto-included, friendId as fallback)
  getMyInviteCode: (friendId) => request(`/invitations/my-code${friendId ? `?friendId=${friendId}` : ''}`),

  // Invitations (admin)
  getInvitations: (status) => adminRequest(`/invitations${status ? `?status=${status}` : ''}`),
  updateInvitation: (id, data) => adminRequest(`/invitations/${id}`, { method: 'PATCH', body: data }),
  deleteInvitation: (id) => adminRequest(`/invitations/${id}`, { method: 'DELETE' }),
  // 07 §UC-IA-006. The 201 body carries a PLAINTEXT temp password that exists in this
  // one response and nowhere else — never persisted, never logged, returned by no
  // other endpoint. The only caller is the approval dialog in AdminInvitations.vue;
  // nothing here may store or log it. `data` is `{ username, note }`.
  approveInvitation: (id, data) => adminRequest(`/invitations/${id}/approve`, { method: 'POST', body: data }),

  // Admin onboarding links
  getOnboardingLinks: () => adminRequest('/onboarding-links'),
  createOnboardingLink: (note) =>
    adminRequest('/onboarding-links', { method: 'POST', body: { note } }),
  updateOnboardingLink: (id, data) =>
    adminRequest(`/onboarding-links/${id}`, { method: 'PATCH', body: data }),
  regenerateOnboardingLink: (id) =>
    adminRequest(`/onboarding-links/${id}/regenerate`, { method: 'POST' }),
  deleteOnboardingLink: (id) =>
    adminRequest(`/onboarding-links/${id}`, { method: 'DELETE' }),

  // Public guest ordering (no auth headers — the URL token is the credential)
  getGuestOrderPage: (token) => guestRequest(`/guest/${encodeURIComponent(token)}`),
  submitGuestOrder: (token, data) => guestRequest(`/guest/${encodeURIComponent(token)}/orders`, {
    method: 'POST',
    body: data
  }),
  // The guest's personal status/edit URL. `order_token` alone is the credential
  // (14 §UC-GR-001/002, D2): it is a path segment and is never sent as a header.
  getGuestOrderStatus: (token, orderToken) => guestRequest(guestOrderPath(token, orderToken)),
  updateGuestOrder: (token, orderToken, data) =>
    guestRequest(guestOrderPath(token, orderToken), {
      method: 'PUT',
      body: data
    }),
  // GSO-T10 (§Lead Capture): "Chcete si nabudúce objednať sami?" — creates an
  // `invitations` row credited to the host. Same token pair, same lack of headers;
  // the host is derived from the link server-side, so no referral code is published
  // into the guest payload. A 409 means this phone already has a pending request.
  requestGuestAccount: (token, orderToken, data) =>
    guestRequest(`${guestOrderPath(token, orderToken)}/invite-request`, {
      method: 'POST',
      body: data
    }),
  // 19 §UC-GL-004 — „Dajte mi vedieť" on the pre-open page. `{ name, phone,
  // whatsapp_opt_in }`; no auth headers (the URL token is the credential). Answers
  // `{ success: true }` for a new signup AND a repeat one alike (no oracle); 409
  // `reason:'open'` when a round is open (order instead). GL-T5 builds the form.
  joinGuestWaitlist: (token, data) => guestRequest(`/guest/${encodeURIComponent(token)}/waitlist`, {
    method: 'POST',
    body: data
  }),

  // Guest share links (host = the authenticated friend; Bearer token required)
  getGuestLink: (cycleId) => request(`/guest-links/cycle/${cycleId}`),
  createGuestLink: (cycleId) => request(`/guest-links/cycle/${cycleId}`, { method: 'POST' }),
  setGuestLinkActive: (id, active) => request(`/guest-links/${id}`, { method: 'PATCH', body: { active } }),
  // 19 §UC-GL-001 — the host's STANDING link (one cycle-independent `/g/:token`).
  // The GET mints it on first call (`standing.created` is true only then) and answers
  // `{ standing: { token, url_path, created }, waiting_count, current }`; the POST
  // rotates it and answers `{ standing: { token, url_path }, regenerated, waiting_count }`.
  // `waiting_count` is a COUNT only — the payload carries no waitlist names or phones.
  getStandingGuestLink: () => request('/guest-links/standing'),
  regenerateStandingGuestLink: () => request('/guest-links/standing/regenerate', { method: 'POST' }),

  // Guest sub-orders, host side. `delivered` is the HOST's flag (the hand-over
  // checklist); `paid` is the ADMIN's and the host only ever reads it, so there
  // is deliberately no client method for it here.
  // "Deleting" a sub-order is a soft cancel server-side: the guest's status URL
  // then shows it as cancelled and its stock is released.
  setGuestOrderDelivered: (id, delivered) =>
    request(`/guest-orders/${id}/delivered`, { method: 'PATCH', body: { delivered } }),
  deleteGuestOrder: (id) => request(`/guest-orders/${id}`, { method: 'DELETE' }),

  // Guest sub-orders, ADMIN side (same `/guest-orders` prefix, requireAdmin-gated
  // server-side — the router is mixed-auth on purpose). `paid` is the admin's flag:
  // the admin is the money recipient, so this is the only place it is written, and
  // it creates NO balance transaction (guests have no balance account).
  // `delivered` is the host's tick and the admin only reads it.
  markGuestOrderPaid: (id, paid) =>
    adminRequest(`/guest-orders/${id}/paid`, { method: 'PATCH', body: { paid } }),
  // Who still owes for this cycle — name, amount, payment reference, host, contact
  // — plus the refund queue (paid but cancelled).
  getGuestUnpaid: (cycleId) => adminRequest(`/guest-orders/cycle/${cycleId}/unpaid`),

  // 16 §UC-DP-005/013 — STAGE 3 for ONE guest bag. ADMIN-only, exactly as `paid` is
  // and unlike `setGuestOrderDelivered` above: `handed_over_at` is the admin letting
  // the bag go, `delivered` is the host confirming the colleague took it. Two
  // columns, two events, opposite guards on the same mixed router.
  // ⚠ It never touches the host's own order — a per-bag correction is a correction
  // of one bag. Used for a host with NO own order (their party IS their guest bags),
  // for a module-20 Packeta guest, and for one withheld bag under a handed-over host.
  setGuestOrderHandedOver: (id, handedOver) =>
    adminRequest(`/guest-orders/${id}/handed-over`, { method: 'PATCH', body: { handed_over: handedOver } }),

  // Guest share links, ADMIN side (14 §UC-GR-004). The `/guest-links` router is
  // MIXED-auth: the three host routes above ride the friend Bearer token, these
  // ride X-Admin-Token.
  //
  // ⚠ Read + create + REGENERATE. D3 was AMENDED (PO decision, 2026-08-31): the
  // admin regenerate exists because the HOST's own regenerate now refuses while live
  // sub-orders exist (409 `reason:'has_orders'`) and the dialog escalates to the
  // admin. Deactivate/reactivate are STILL host-only and there is deliberately no
  // admin method for either — `active` is never written by an admin route.
  //
  // ⚠ THE TWO POSTs ON THIS PREFIX ANSWER DIFFERENT SHAPES. This one returns
  // `{ link, created }`; the HOST's own `createGuestLink` above returns
  // `{ link, regenerated, guest_orders, totals }`. That asymmetry is why this is its
  // own method rather than a parameter on the existing one — a client written
  // against "the POST on /guest-links" would read `regenerated` off a body that
  // never has it. A 409 `inactive_host` carries NO `link`: the gate runs before the
  // existing-link lookup, so this route is not a token-retrieval path for a
  // deactivated host — `getGuestLinksForCycle` is the complete source of tokens.
  getGuestLinksForCycle: (cycleId) => adminRequest(`/guest-links/cycle/${cycleId}/all`),
  createGuestLinkForHost: (cycleId, friendId) =>
    adminRequest(`/guest-links/cycle/${cycleId}/host/${friendId}`, { method: 'POST' }),
  // Rotates the token on the EXISTING row — the old `/g/:token` stops taking new
  // orders, and every guest order already placed keeps working (they resolve by
  // `order_token` alone, §UC-GR-001/002). Answers `{ link, regenerated: true }` and
  // never writes `active`, so a revoked link stays revoked.
  regenerateGuestLinkForHost: (cycleId, friendId) =>
    adminRequest(`/guest-links/cycle/${cycleId}/host/${friendId}/regenerate`, { method: 'POST' }),

  // The admin's own cancel of a guest sub-order (14 §UC-GR-005) — the capability the
  // host's DELETE points at when it refuses a PAID one. NOT the same route: this one
  // has no paid blockade, and a paid + cancelled sub-order lands in the refund queue
  // above on purpose (D4). Soft cancel server-side; the item rows are kept.
  cancelGuestOrderAdmin: (id) => adminRequest(`/guest-orders/${id}/cancel`, { method: 'POST' }),
  // 20 §UC-GP-009 (GP-T5) — the admin corrects a guest's delivery back to „cez {host}".
  // ADMIN-only; the body is EXACTLY `{ method: 'via_host' }` (v1 cannot set a Packeta
  // point for a guest — PO). Ledger-neutral; answers `{ guest_order, totals,
  // cleared_parcel, parcel_fee_removed }`.
  switchGuestDelivery: (id) =>
    adminRequest(`/guest-orders/${id}/delivery`, { method: 'PATCH', body: { method: 'via_host' } }),

  // 19 §UC-GL-009 — the guest waitlist, ADMIN side (the whole `/guest-waitlist` mount
  // is requireAdmin). `getGuestWaitlist({ host_friend_id })` → `{ rows: [...] }` in
  // full (names + phones — the admin's view only; the host sees a COUNT). There is no
  // admin create and no admin write of `notified_at` (module 21 owns it).
  getGuestWaitlist: (params = {}) => {
    const query = new URLSearchParams()
    if (Number.isInteger(params?.host_friend_id) && params.host_friend_id > 0) {
      query.set('host_friend_id', String(params.host_friend_id))
    }
    const qs = query.toString()
    return adminRequest(`/guest-waitlist${qs ? `?${qs}` : ''}`)
  },
  deleteGuestWaitlistRow: (id) => adminRequest(`/guest-waitlist/${id}`, { method: 'DELETE' }),

  // Coffee product catalog (admin) — module 12. The whole /coffee-products
  // mount is requireAdmin server-side; all calls ride X-Admin-Token.
  getCatalogProducts: (params = {}) => {
    const query = new URLSearchParams()
    for (const key of ['status', 'purpose', 'roastery', 'q']) {
      if (params[key]) query.set(key, params[key])
    }
    const qs = query.toString()
    return adminRequest(`/coffee-products${qs ? `?${qs}` : ''}`)
  },
  getCatalogProduct: (id) => adminRequest(`/coffee-products/${id}`),
  // PC-T13: manual catalog product creation — a coffee that is neither in the
  // current sheet nor in history can now exist in the catalog.
  createCatalogProduct: (data) => adminRequest('/coffee-products', { method: 'POST', body: data }),
  updateCatalogProduct: (id, data) => adminRequest(`/coffee-products/${id}`, { method: 'PATCH', body: data }),
  // PC-T13: "Odpojiť od katalógu" — the history returns to the workbench, the
  // catalog row (photo, curation) survives.
  unlinkCatalogProduct: (id) => adminRequest(`/coffee-products/${id}/unlink`, { method: 'POST' }),
  // PC-T13: split rules (one sheet row → N catalog products).
  getCatalogProductSplits: (id) => adminRequest(`/coffee-products/${id}/splits`),
  addCatalogProductSplit: (id, sheetName) =>
    adminRequest(`/coffee-products/${id}/splits`, { method: 'POST', body: { sheet_name: sheetName } }),
  deleteCatalogProductSplit: (id, splitId) =>
    adminRequest(`/coffee-products/${id}/splits/${splitId}`, { method: 'DELETE' }),
  deleteCatalogProduct: (id) => adminRequest(`/coffee-products/${id}`, { method: 'DELETE' }),
  uploadCatalogProductImage: (id, formData) => adminRequest(`/coffee-products/${id}/image`, { method: 'POST', body: formData }),
  importCatalogCSV: (formData) => adminRequest('/coffee-products/import', { method: 'POST', body: formData }),
  importCatalogGsheet: (url, roastery) => adminRequest('/coffee-products/import-gsheet', { method: 'POST', body: { url, roastery: roastery || null } }),
  importCatalogGsheetMultirow: (url, roastery) => adminRequest('/coffee-products/import-gsheet-multirow', { method: 'POST', body: { url, roastery: roastery || null } }),
  // Migration workbench (module 12, PC-T9 — the manual assignment flow that
  // replaced POST /migrate per resolved decision 14).
  // Reconcile a cycle's catalog product selection (PM 2026-08-23) — the creation
  // picker, reopenable while the cycle is editable.
  setCycleCatalogProducts: (cycleId, coffeeProductIds) =>
    adminRequest(`/cycles/${cycleId}/catalog-products`, { method: 'PUT', body: { coffee_product_ids: coffeeProductIds } }),
  getMigrationPending: () => adminRequest('/coffee-products/migration/pending'),
  assignMigrationGroups: (groups, catalogId) =>
    adminRequest('/coffee-products/migration/assign', { method: 'POST', body: { groups, catalog_id: catalogId } }),
  createMigrationProduct: (groups) =>
    adminRequest('/coffee-products/migration/create', { method: 'POST', body: { groups } }),
  // PC-T13: explicit dismissal of junk pending groups (+ review and undo).
  ignoreMigrationGroups: (groups) =>
    adminRequest('/coffee-products/migration/ignore', { method: 'POST', body: { groups } }),
  unignoreMigrationGroups: (groups) =>
    adminRequest('/coffee-products/migration/unignore', { method: 'POST', body: { groups } }),
  getMigrationIgnored: () => adminRequest('/coffee-products/migration/ignored'),
  // PC-T10 (12 §UC-PC-014): one-time conversion of legacy base64 images to files.
  convertCatalogImages: () => adminRequest('/coffee-products/convert-images', { method: 'POST' }),
  getCatalogDuplicates: () => adminRequest('/coffee-products/duplicates'),
  mergeCatalogProduct: (targetId, sourceId) => adminRequest(`/coffee-products/${targetId}/merge`, { method: 'POST', body: { source_id: sourceId } }),
  // ⚠ `last_n_cycles` is OMITTED for all time, never sent empty — the route
  // 400s on an empty value by design (see the comment at the route).
  getCatalogStats: ({ purpose, lastNCycles } = {}) => {
    const query = new URLSearchParams()
    if (purpose) query.set('purpose', purpose)
    if (Number.isInteger(lastNCycles) && lastNCycles > 0) query.set('last_n_cycles', String(lastNCycles))
    const qs = query.toString()
    return adminRequest(`/coffee-products/stats${qs ? `?${qs}` : ''}`)
  },
  getCatalogProductStats: (id) => adminRequest(`/coffee-products/${id}/stats`),

  // Roasteries
  getRoasteries: () => request('/roasteries'),
  createRoastery: (data) => request('/roasteries', { method: 'POST', body: data }),
  updateRoastery: (id, data) => request(`/roasteries/${id}`, { method: 'PATCH', body: data }),
  deleteRoastery: (id) => request(`/roasteries/${id}`, { method: 'DELETE' }),

  // Product availability (stock limits)
  getProductAvailability: (cycleId, excludeFriendId) => request(`/products/cycle/${cycleId}/availability${excludeFriendId ? `?excludeFriendId=${excludeFriendId}` : ''}`),
}

export default api
