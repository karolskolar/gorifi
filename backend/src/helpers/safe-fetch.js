import dns from 'dns/promises';
import net from 'net';

// SSRF protection (SEC-H1, audit §H6). The server fetches client-supplied URLs
// (product image-from-url). Without guards an attacker could point it at
// internal services or the cloud metadata endpoint (169.254.169.254). We reject
// non-public destinations and any URL that resolves to a private/loopback/
// link-local range, cap time and size, and refuse redirects (a redirect could
// otherwise bounce a public host to an internal one).

function isPrivateIpv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 127) return true;              // this-host / loopback
  if (a === 10) return true;                          // private
  if (a === 172 && b >= 16 && b <= 31) return true;   // private
  if (a === 192 && b === 168) return true;            // private
  if (a === 169 && b === 254) return true;            // link-local (incl. cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  if (a >= 224) return true;                          // multicast / reserved
  return false;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true;        // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
    if (lower.startsWith('::ffff:')) return isPrivateIpv4(lower.slice('::ffff:'.length)); // IPv4-mapped
    return false;
  }
  return true; // unparseable → treat as unsafe
}

// Validate that a URL is http(s) and does not resolve to a private address.
// Returns the parsed URL. Throws (message is safe to surface) otherwise.
export async function assertPublicHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('Neplatná URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('URL musí byť http alebo https');
  }

  let addresses;
  if (net.isIP(u.hostname)) {
    addresses = [u.hostname];
  } else {
    try {
      addresses = (await dns.lookup(u.hostname, { all: true })).map((r) => r.address);
    } catch {
      throw new Error('Nepodarilo sa preložiť hostiteľa');
    }
  }
  if (!addresses.length || addresses.some(isPrivateIp)) {
    throw new Error('Prístup na internú adresu je zakázaný');
  }
  return u;
}

// fetch() a client URL with SSRF validation, a timeout, no redirects, and a
// response-size cap (checked via Content-Length; the caller still shouldn't
// buffer unbounded, but our uses are small images).
export async function safeFetch(rawUrl, { timeoutMs = 8000, maxBytes = 5 * 1024 * 1024, allowRedirects = false, ...opts } = {}) {
  await assertPublicHttpUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // redirect:'error' by default so a public host can't bounce to an internal
    // one. allowRedirects is only for URLs we construct against a trusted host
    // (e.g. the fixed docs.google.com export endpoint, which 3xx's to Google's CDN).
    const res = await fetch(rawUrl, { ...opts, signal: controller.signal, redirect: allowRedirects ? 'follow' : 'error' });
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > maxBytes) {
      throw new Error('Súbor je príliš veľký');
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}
