// The reusable branded e-mail template layer (08 §UC-EM-002) — ONE server-side
// renderer that turns structured content into `{ text, html }`, usable by ANY
// transactional mail. The credentials mail (routes/invitations.js) is the first
// consumer; module 09's magic-link mail is the second. ⚠ A needed capability becomes
// a NEW BLOCK TYPE, never a credentials- or link-specific special case — the layer
// carries no copy, no URLs and no register of its own (all three are the caller's).
//
// THE SEAM:  renderEmail({ text, blocks }) → { text, html }
//
//   text   — required non-empty string: the plain-text part, returned UNCHANGED (the
//            same string, `===` — no trim, no normalisation, no appended footer).
//            ⚠ This pass-through is the mechanism that preserves 07 §UC-IA-006/009's
//            clipboard/mail byte-identity contract: the renderer never generates or
//            rewrites the text part, so a caller whose text is a signed sentence
//            keeps it signed. Whitespace-only counts as EMPTY here even though the
//            mailer would treat it as present — a blank text part is a template bug
//            this layer must refuse, not hand onwards.
//   blocks — required non-empty ordered array from a small CLOSED vocabulary:
//            { type: 'paragraph', text }              — body paragraph
//            { type: 'kv', rows: [{ label, value }] } — label/value rows, values in
//                                                       the mono stack (credentials,
//                                                       references)
//            { type: 'button', url, label? }          — the CTA; `label` defaults to
//                                                       the URL itself (link text
//                                                       matching the href is a
//                                                       deliverability signal AND how
//                                                       this module avoids inventing
//                                                       unsigned Slovak copy). The URL
//                                                       also renders as a plain-text
//                                                       line under the button, so a
//                                                       client that mangles the button
//                                                       still shows a copyable address.
//            { type: 'small', text }                  — de-emphasised footer-size line
//
// PURE AND SYNCHRONOUS: plain template literals (the 01-architecture no-templating-
// engine rule) — no I/O, no env reads, no DB. THROWING IS ACCEPTABLE HERE, uniquely:
// every call site MUST sit inside its route's existing mail try/catch (the approve
// route's second layer degrades to `email:{sent:false,error:'network'}`), so a render
// bug degrades to "send it by hand", never to a failed request.
//
// THE HTML SHELL: full document, table layout, INLINE CSS ONLY — no <style>, no
// classes, no <link>, no @import, no url(...) (Gmail clips, Outlook renders with
// Word's engine; only inline style="" plus legacy bgcolor/width attributes survive).
// ⚠ ZERO REMOTE SUBRESOURCES — no images at all in this phase (the wordmark is TEXT),
// no webfonts, no remote CSS: the mail-side analogue of the RD-DS-6 self-hosted-CSP
// rule, and what keeps the mail from ever being "image-only" (a spam signal). Brand
// is APPROXIMATED from 02-design-system's tokens with carriers downgraded to what
// survives mail: the 3px ink border is the guaranteed carrier (box-shadow is stripped
// by Outlook and deliberately not attempted), system font stacks only.
//
// ⚠ SECURITY — EVERY interpolated value is HTML-escaped (& < > " '), ATTRIBUTE
// POSITIONS INCLUDED. Block content includes applicant-supplied strings (an
// invitation's name, a requested username): unescaped, an applicant could inject
// markup into an e-mail sent from our DKIM-verified domain — the same phishing class
// `resolveLoginUrl()`'s allowlist check exists to prevent. `button.url` values must
// be SERVER-DERIVED (`resolveLoginUrl()`, a server-minted token link) — never text
// from a request body; the escaping here is the second layer, not permission.

// Brand tokens (02-design-system, downgraded to mail-safe carriers).
const INK = '#0a0a0a';
const ACCENT = '#ff2d87';
const PAGE_BG = '#fff8f3';
const CARD_BG = '#ffffff';
// De-emphasis for labels/small print — an approximation (the canon's --ink-dim does
// not exist as a mail-safe token); dark enough to pass contrast on white.
const DIM = '#6b6459';
// System stacks ONLY — webfonts do not survive mail clients (§UC-EM-002).
const FONT_BODY = "-apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
const FONT_MONO = "'Courier New', Courier, monospace";

// Every interpolation goes through this — element content and attribute values alike.
// The five characters cover both positions: `&lt;`/`&gt;` neutralise tags, `&quot;`/
// `&#39;` stop an attribute breakout, `&amp;` first so the others survive.
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fail(reason) {
  throw new Error(`renderEmail: ${reason}`);
}

function requireString(value, what) {
  if (typeof value !== 'string') fail(`${what} must be a string`);
  return value;
}

// ── the four block renderers (the CLOSED vocabulary) ─────────────────────────

function renderParagraph(block) {
  const text = requireString(block.text, "a paragraph block's `text`");
  return `<p style="margin:0 0 16px 0; font-family:${FONT_BODY}; font-size:16px; line-height:1.5; color:${INK};">${escapeHtml(text)}</p>`;
}

function renderKv(block) {
  if (!Array.isArray(block.rows) || block.rows.length === 0) {
    fail("a kv block's `rows` must be a non-empty array");
  }
  const rows = block.rows
    .map((row) => {
      if (!row || typeof row !== 'object') fail('a kv row must be an object');
      const label = requireString(row.label, "a kv row's `label`");
      if (row.value === undefined || row.value === null) fail("a kv row's `value` is required");
      return `<tr>
<td style="padding:4px 12px 4px 0; font-family:${FONT_BODY}; font-size:13px; text-transform:uppercase; letter-spacing:0.05em; color:${DIM}; white-space:nowrap;">${escapeHtml(label)}</td>
<td style="padding:4px 0; font-family:${FONT_MONO}; font-size:16px; font-weight:bold; color:${INK};">${escapeHtml(row.value)}</td>
</tr>`;
    })
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
${rows}
</table>`;
}

function renderButton(block) {
  const url = requireString(block.url, "a button block's `url`");
  if (url.trim() === '') fail("a button block's `url` must be non-empty");
  if (block.label !== undefined) requireString(block.label, "a button block's `label`");
  // Label defaults to the URL itself — link text matching the href is a
  // deliverability signal AND the way unsigned button copy is avoided (the
  // §UC-EM-003 OPEN item; any real label is the caller's signed copy).
  const label = block.label !== undefined && block.label !== '' ? block.label : url;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;">
<tr><td bgcolor="${ACCENT}" style="background-color:${ACCENT}; border:3px solid ${INK}; border-radius:8px;">
<a href="${escapeHtml(url)}" style="display:inline-block; padding:12px 24px; font-family:${FONT_BODY}; font-size:16px; font-weight:bold; color:#ffffff; text-decoration:none;">${escapeHtml(label)}</a>
</td></tr>
</table>
<p style="margin:0 0 16px 0; font-family:${FONT_MONO}; font-size:13px; line-height:1.5; color:${DIM}; word-break:break-all;">${escapeHtml(url)}</p>`;
}

function renderSmall(block) {
  const text = requireString(block.text, "a small block's `text`");
  return `<p style="margin:0 0 8px 0; font-family:${FONT_BODY}; font-size:13px; line-height:1.5; color:${DIM};">${escapeHtml(text)}</p>`;
}

const BLOCK_RENDERERS = {
  paragraph: renderParagraph,
  kv: renderKv,
  button: renderButton,
  small: renderSmall,
};

function renderBlock(block, index) {
  if (!block || typeof block !== 'object') fail(`blocks[${index}] must be an object`);
  const renderer = Object.prototype.hasOwnProperty.call(BLOCK_RENDERERS, block.type)
    ? BLOCK_RENDERERS[block.type]
    : null;
  if (!renderer) fail(`unknown block type ${JSON.stringify(block.type)} at blocks[${index}] — the vocabulary is closed: paragraph | kv | button | small`);
  return renderer(block);
}

// ── the shell ─────────────────────────────────────────────────────────────────
// Single column, content table width="560" (attribute for Outlook) with
// max-width:100% for fluid-below, ≥16px base font — readable on phones without a
// viewport meta. The wordmark is TEXT: POD**PULT**OVKA, PULT in the accent.
function shell(blocksHtml) {
  return `<!DOCTYPE html>
<html lang="sk">
<head>
<meta charset="utf-8">
</head>
<body style="margin:0; padding:0; background-color:${PAGE_BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="background-color:${PAGE_BG};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px; max-width:100%;">
<tr><td style="padding:0 0 14px 4px; font-family:${FONT_BODY}; font-size:22px; font-weight:800; letter-spacing:0.06em; color:${INK};">POD<span style="color:${ACCENT}">PULT</span>OVKA</td></tr>
<tr><td bgcolor="${CARD_BG}" style="background-color:${CARD_BG}; border:3px solid ${INK}; border-radius:12px; padding:24px;">
${blocksHtml}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function renderEmail({ text, blocks } = {}) {
  // ⚠ Whitespace-only is refused HERE, deliberately: the mailer counts '   ' as a
  // present text part (EM-T1 review note), so this check is the only thing standing
  // between a template bug and a multipart message whose deliverability baseline is
  // blank.
  if (typeof text !== 'string' || text.trim() === '') {
    fail('`text` must be a non-empty string — the plain-text part is the deliverability baseline');
  }
  if (!Array.isArray(blocks) || blocks.length === 0) {
    fail('`blocks` must be a non-empty array');
  }
  const html = shell(blocks.map(renderBlock).join('\n'));
  // ⚠ `text` is returned by REFERENCE — the `===` pass-through the byte-identity
  // contract rides on. Never trim, normalise or append here.
  return { text, html };
}
