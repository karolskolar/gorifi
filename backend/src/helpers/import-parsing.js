import { parse } from 'csv-parse/sync';
import { safeFetch } from './safe-fetch.js';

// Sheet/CSV import parsing — 12 §UC-PC-003 "extract, never rewrite" (PC-T2).
//
// ⚠ THE ONE HOME for the importers' parsing and column mapping, moved VERBATIM
// out of routes/products.js. The column aliases, the price parsing and the
// multirow state machine are FROZEN — the catalog import (routes/
// coffee-products.js) and the legacy per-cycle importers (routes/products.js,
// until PC-T8 retires them) both consume exactly this code, which is what makes
// the CSV e2e coverage transfer to the gsheet endpoints (UC-PC-011 item 2).
// Do not "improve" the mapping here; a parsing change is out of scope for the
// whole of module 12.
//
// ⚠ This module deliberately imports NO db module — it is pure parsing plus the
// gsheet fetch. e2e imports it directly (catalog-import.spec.js), which is only
// safe while importing it cannot open or migrate a database.

// Parse prices - handle various formats.
// (Verbatim from products.js — it was defined inline, identically, in both the
// CSV and the gsheet column-mapping loops.)
// Exported for PC-T3 (12 §UC-PC-005): the manual POST's body prices arrive as
// admin-form strings and must become numbers for the catalog half — parsed by
// the SAME rules an imported price gets, never by a second parser.
export function parsePrice(val) {
  if (!val) return null;
  const cleaned = String(val).replace(/[^\d.,]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// The csv-parse options both columns-with-headers importers used, verbatim.
function parseCsvRecords(csvContent) {
  return parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true
  });
}

// Column mapping of POST /import/:cycleId (the CSV upload), verbatim.
// Returns EVERY record mapped — including nameless ones (name '') — so the
// catalog import can report skips; the legacy route keeps its own `if (name)`.
export function parseCsvProducts(csvContent) {
  const records = parseCsvRecords(csvContent);
  return records.map((p) => {
    // Try to match common column names
    const name = p.Name || p.name || p.Nazov || p.nazov || '';
    const desc1 = p.Description1 || p.description1 || p.Popis1 || p.popis1 || '';
    const desc2 = p.Description2 || p.description2 || p.Popis2 || p.popis2 || p.ChutovyProfil || p['Chuťový profil'] || '';
    const roast = p.Roast || p.roast || p.Prazenie || p.prazenie || '';
    const purpose = p.Purpose || p.purpose || p.Ucel || p.ucel || '';

    const price250g = parsePrice(p.Price250g || p.price250g || p.Cena250g || p.cena250g || p['250g']);
    const price1kg = parsePrice(p.Price1kg || p.price1kg || p.Cena1kg || p.cena1kg || p['1kg']);

    return {
      name,
      description1: desc1,
      description2: desc2,
      roast_type: roast,
      purpose,
      price_250g: price250g,
      price_1kg: price1kg,
    };
  });
}

// Column mapping of POST /import-gsheet/:cycleId, verbatim. ⚠ NOT the same
// alias set as parseCsvProducts: the gsheet copy additionally honours the
// diacritic-free `p['Chutovy profil']` header. The two legacy loops really did
// differ in exactly that one alias, and "byte-identical behavior" means the
// difference is preserved, not harmonised.
export function parseGsheetCsvProducts(csvContent) {
  const records = parseCsvRecords(csvContent);
  return records.map((p) => {
    // Try to match common column names (Slovak and English)
    const name = p.Name || p.name || p.Nazov || p.nazov || '';
    const desc1 = p.Description1 || p.description1 || p.Popis1 || p.popis1 || '';
    const desc2 = p.Description2 || p.description2 || p.Popis2 || p.popis2 || p.ChutovyProfil || p['Chuťový profil'] || p['Chutovy profil'] || '';
    const roast = p.Roast || p.roast || p.Prazenie || p.prazenie || '';
    const purpose = p.Purpose || p.purpose || p.Ucel || p.ucel || '';

    const price250g = parsePrice(p.Price250g || p.price250g || p.Cena250g || p.cena250g || p['250g']);
    const price1kg = parsePrice(p.Price1kg || p.price1kg || p.Cena1kg || p.cena1kg || p['1kg']);

    return {
      name,
      description1: desc1,
      description2: desc2,
      roast_type: roast,
      purpose,
      price_250g: price250g,
      price_1kg: price1kg,
    };
  });
}

// Google Sheets URL → published-CSV fetch, verbatim from both gsheet routes
// (sheet-id/gid extraction + safeFetch). Error mapping stays at the call sites
// so the legacy routes keep their exact Slovak messages:
//   { error: 'invalid_url' }  — the URL carries no /spreadsheets/d/<id>
//   { error: 'fetch_failed' } — the export URL answered non-OK
//   { csvContent }            — success
// A safeFetch THROW (SSRF refusal, timeout, network) propagates — the legacy
// routes' own try/catch handled that case and must keep doing so unchanged.
export async function fetchGsheetCsv(url) {
  // Extract sheet ID and gid from URL
  // Formats:
  // https://docs.google.com/spreadsheets/d/SHEET_ID/edit#gid=TAB_ID
  // https://docs.google.com/spreadsheets/d/SHEET_ID/edit?gid=TAB_ID
  const sheetIdMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!sheetIdMatch) {
    return { error: 'invalid_url' };
  }
  const sheetId = sheetIdMatch[1];

  // Extract gid (tab ID), default to 0 if not found
  // Only include gid if explicitly provided in URL
  const gidMatch = url.match(/[#?&]gid=(\d+)/);
  const gidParam = gidMatch ? `&gid=${gidMatch[1]}` : '';

  // Fetch CSV from Google Sheets
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gidParam}`;
  const response = await safeFetch(csvUrl, { allowRedirects: true });

  if (!response.ok) {
    return { error: 'fetch_failed' };
  }

  return { csvContent: await response.text() };
}

// ── Multi-row (3-rows-per-product) format — moved verbatim from products.js ──

// Helper functions for multi-row import
function isSeparatorRow(row) {
  // Separator row: mostly empty (≤1 non-empty cells)
  const nonEmptyCells = row.filter(cell => cell && cell.trim()).length;
  return nonEmptyCells <= 1;
}

function isProductSectionHeader(row) {
  // Check if row is the products section header (contains "Praženie", "VOC 5-25 kg", "Zrnková káva")
  // Be specific to avoid matching words like "ovocie" which contains "voc"
  const rowText = row.join(' ').toLowerCase();
  return rowText.includes('praženie') || rowText.includes('prazenie') ||
         rowText.includes('voc 5') || rowText.includes('voc 26') ||  // VOC price columns
         rowText.includes('zrnková káva');
}

function parsePriceString(priceStr, variantLabel = '') {
  const result = { price150g: null, price200g: null, price250g: null, price1kg: null, error: null };
  if (!priceStr || !priceStr.trim()) return result;

  const normalized = priceStr.replace(/\s+/g, ' ').trim();
  const labelLower = variantLabel.toLowerCase();

  // Detect variant types from label
  const has150g = labelLower.includes('150');
  const has200g = labelLower.includes('200');
  const has250g = labelLower.includes('250');
  const has1kg = labelLower.includes('1kg') || labelLower.includes('1 kg');

  // Try to split by common separators: " / ", "/", " - ", "-"
  const separators = [' / ', '/', ' - ', '-'];
  let parts = null;

  for (const sep of separators) {
    if (normalized.includes(sep)) {
      parts = normalized.split(sep).map(p => p.trim()).filter(p => p);
      if (parts.length === 2) break;
    }
  }

  const parsePrice = (val) => {
    if (!val) return null;
    const cleaned = String(val).replace(/[^\d.,]/g, '').replace(',', '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  };

  if (!parts || parts.length !== 2) {
    // Single price - determine variant from label
    const singlePrice = parsePrice(normalized);
    if (singlePrice !== null) {
      if (has150g) {
        result.price150g = singlePrice;
      } else if (has200g) {
        result.price200g = singlePrice;
      } else {
        result.price250g = singlePrice;
        result.error = 'Single price found, assumed 250g';
      }
    }
    return result;
  }

  // Two prices - assign based on label
  const price1 = parsePrice(parts[0]);
  const price2 = parsePrice(parts[1]);

  if (has150g && has1kg) {
    result.price150g = price1;
    result.price1kg = price2;
  } else if (has200g && has1kg) {
    result.price200g = price1;
    result.price1kg = price2;
  } else {
    // Default: 250g / 1kg
    result.price250g = price1;
    result.price1kg = price2;
  }

  // Sanity check: 1kg should be more expensive than smaller variants
  const smallPrice = result.price150g || result.price200g || result.price250g;
  if (smallPrice && result.price1kg && result.price1kg < smallPrice) {
    // Swap them
    if (result.price150g) {
      [result.price150g, result.price1kg] = [result.price1kg, result.price150g];
    } else if (result.price200g) {
      [result.price200g, result.price1kg] = [result.price1kg, result.price200g];
    } else {
      [result.price250g, result.price1kg] = [result.price1kg, result.price250g];
    }
    result.error = 'Prices were swapped (small variant was larger than 1kg)';
  }

  return result;
}

export function parseMultiRowProducts(csvContent) {
  const records = parse(csvContent, {
    columns: false,      // Keep as arrays, don't auto-detect headers
    skip_empty_lines: false,  // Need to detect separator rows
    trim: true,
    bom: true,
    relax_column_count: true  // Handle rows with varying column counts
  });

  const products = [];
  const warnings = [];
  let currentProduct = null;
  let rowInProduct = 0;
  let productIndex = 0;
  let inProductSection = false;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];

    // Skip header rows (first ~10 rows until we hit a separator followed by product)
    if (!inProductSection) {
      if (isSeparatorRow(row)) {
        inProductSection = true;  // Next non-separator row starts products
      }
      continue;
    }

    // Skip product section header row (e.g., "Zrnková káva | Praženie | VOC...")
    if (isProductSectionHeader(row)) {
      continue;
    }

    // Detect separator row
    if (isSeparatorRow(row)) {
      // Finalize current product if we have one
      if (currentProduct && currentProduct.name) {
        products.push(currentProduct);
        productIndex++;
      }
      currentProduct = null;
      rowInProduct = 0;
      continue;
    }

    // Process product rows based on actual Goriffee sheet structure:
    // Row 1: B=name, H=purpose (Filter/Espresso), I=price format label (250g / 1kg)
    // Row 2: B=description, I=actual price "8,9 / 35,3 EUR"
    // Row 3: B=flavor profile, H=roast level (Light roast/Medium roast)

    if (rowInProduct === 0) {
      // Row 1: Name (B=1), Purpose (H=7), Variant label (I=8)
      currentProduct = {
        name: (row[1] || '').trim(),
        description1: '',
        description2: '',
        purpose: (row[7] || '').trim(),  // Filter, Espresso, etc.
        roast_type: '',
        price_150g: null,
        price_200g: null,
        price_250g: null,
        price_1kg: null,
        _variantLabel: (row[8] || '').trim(),  // e.g., "150g", "200g / 1kg", "250g / 1kg"
        _rowStart: i + 1
      };
      rowInProduct = 1;
    } else if (rowInProduct === 1) {
      // Row 2: Description (B=1), Price (I=8)
      currentProduct.description1 = (row[1] || '').trim();

      // Parse price from column I (index 8) using variant label from row 1
      const priceResult = parsePriceString(row[8] || '', currentProduct._variantLabel);
      currentProduct.price_150g = priceResult.price150g;
      currentProduct.price_200g = priceResult.price200g;
      currentProduct.price_250g = priceResult.price250g;
      currentProduct.price_1kg = priceResult.price1kg;
      if (priceResult.error) {
        warnings.push(`"${currentProduct.name}": ${priceResult.error}`);
      }

      rowInProduct = 2;
    } else if (rowInProduct === 2) {
      // Row 3: Flavor profile (B=1), Roast type (H=7)
      currentProduct.description2 = (row[1] || '').trim();
      currentProduct.roast_type = (row[7] || '').trim();  // Light roast, Medium roast, etc.

      // Product complete - add it
      if (currentProduct.name) {
        products.push(currentProduct);
        productIndex++;
      }

      currentProduct = null;
      rowInProduct = 0;
    }
  }

  // Handle last product if file doesn't end with separator
  if (currentProduct && currentProduct.name) {
    products.push(currentProduct);
  }

  return { products, warnings };
}
