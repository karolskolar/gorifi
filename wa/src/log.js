// The `[wa]` log prefix (21 §UC-WA-011 „Log lines"). ⚠ PII-FREE: callers pass row IDS,
// state words, fixed error CODES — never a message body, never a recipient's number
// (the bot's OWN number is the one number that may appear), never the pairing QR.

export function log(message) {
  console.log(`[wa] ${message}`)
}

export function logError(message) {
  console.error(`[wa] ${message}`)
}

// Europe/Bratislava wall-clock `HH:MM` of an epoch-ms instant (the hourly-cap line).
export function clockOf(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms))
}
