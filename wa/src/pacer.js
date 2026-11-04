// 21 §UC-WA-011 step 2 — pacing: a random gap between two sends
// (`WA_PACE_MIN_MS`…`WA_PACE_MAX_MS`) and a rolling-hour cap (`WA_HOURLY_MAX`).
//
// The ring holds the epoch-ms stamps of the bot's SUCCESSFUL sends in the last hour; it
// is SEEDED at boot from `notifications.sent_via = 'bot' AND sent_at > now − 1 h`, so a
// restart cannot reset the cap. A send is allowed at
//   max( lastAttempt + gap,  ring[len − max] + 1 h  when len ≥ max )
// — the second term is „sleep until the oldest expires", generalised to a ring that may
// hold MORE than `max` stamps after a seed (the spec's „≥ WA_HOURLY_MAX").
// The gap is drawn ONCE per attempt that REACHED the sender (failures included: a failed
// send still talked to WhatsApp; a row loop.js refuses before `send` is not an attempt) and
// applies before the NEXT one; a bot idle for longer than the gap sends at
// once. Pure: `now` and `random` are injectable.

export const HOUR_MS = 60 * 60 * 1000

export function createPacer({ minMs, maxMs, hourlyMax, seed = [], lastAttemptMs = null, random = Math.random }) {
  const ring = seed.filter(Number.isFinite).sort((a, b) => a - b)
  let notBefore = 0
  if (Number.isFinite(lastAttemptMs)) notBefore = lastAttemptMs + draw()

  function draw() {
    return minMs + Math.floor(random() * (maxMs - minMs + 1))
  }
  function prune(now) {
    while (ring.length && ring[0] <= now - HOUR_MS) ring.shift()
  }

  return {
    hourlySent(now = Date.now()) {
      prune(now)
      return ring.length
    },
    // ⇒ { at, capped }: the earliest instant the next send may happen, and whether the
    // hourly cap (not the gap) is what holds it.
    nextAllowed(now = Date.now()) {
      prune(now)
      const capAt = ring.length >= hourlyMax ? ring[ring.length - hourlyMax] + HOUR_MS : 0
      return { at: Math.max(notBefore, capAt), capped: capAt > now && capAt >= notBefore }
    },
    recordAttempt(now = Date.now(), { sent }) {
      if (sent) ring.push(now)
      notBefore = now + draw()
    },
  }
}
