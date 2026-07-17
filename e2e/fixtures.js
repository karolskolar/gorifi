// Shared test credentials / seed constants. Defaults match seed.mjs so the
// suite is self-contained against a freshly seeded local backend. Override via
// env when running against an environment seeded differently (e.g. staging).
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'e2e-admin-pass-9271'
export const FRIENDS_PASSWORD = process.env.FRIENDS_PASSWORD || 'e2e-friends-pass'
export const FRIEND_NAME = process.env.FRIEND_NAME || 'E2ETester'
export const CYCLE_NAME = process.env.CYCLE_NAME || 'E2E Test Cycle'
