import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import db from '../db/schema.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Get all products for a cycle
router.get('/cycle/:cycleId', (req, res) => {
  const products = db.prepare(`
    SELECT * FROM products WHERE cycle_id = ? AND active = 1 ORDER BY purpose, name
  `).all(req.params.cycleId);
  res.json(products);
});

// Get single product
router.get('/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }
  res.json(product);
});

// Create single product (manual entry) - with optional image
router.post('/', upload.single('image'), (req, res) => {
  const { cycle_id, name, description1, description2, roast_type, purpose, price_150g, price_200g, price_250g, price_1kg, price_20pc5g } = req.body;

  if (!cycle_id || !name) {
    return res.status(400).json({ error: 'cycle_id a nazov su povinne' });
  }

  // Handle image - either from file upload or base64 in body
  let image = null;
  if (req.file) {
    const mimeType = req.file.mimetype;
    const base64 = req.file.buffer.toString('base64');
    image = `data:${mimeType};base64,${base64}`;
  } else if (req.body.image) {
    image = req.body.image;
  }

  const result = db.prepare(`
    INSERT INTO products (cycle_id, name, description1, description2, roast_type, purpose, price_150g, price_200g, price_250g, price_1kg, price_20pc5g, image)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cycle_id, name, description1, description2, roast_type, purpose, price_150g, price_200g, price_250g, price_1kg, price_20pc5g, image);

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(product);
});

// Import products from CSV
router.post('/import/:cycleId', upload.single('file'), (req, res) => {
  const cycleId = req.params.cycleId;

  // Check cycle exists
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Ziaden subor nebol nahrany' });
  }

  try {
    const csvContent = req.file.buffer.toString('utf-8');
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });

    // Map CSV columns to database fields
    const insertStmt = db.prepare(`
      INSERT INTO products (cycle_id, name, description1, description2, roast_type, purpose, price_250g, price_1kg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((products) => {
      const results = [];
      for (const p of products) {
        // Try to match common column names
        const name = p.Name || p.name || p.Nazov || p.nazov || '';
        const desc1 = p.Description1 || p.description1 || p.Popis1 || p.popis1 || '';
        const desc2 = p.Description2 || p.description2 || p.Popis2 || p.popis2 || p.ChutovyProfil || p['Chuťový profil'] || '';
        const roast = p.Roast || p.roast || p.Prazenie || p.prazenie || '';
        const purpose = p.Purpose || p.purpose || p.Ucel || p.ucel || '';

        // Parse prices - handle various formats
        const parsePrice = (val) => {
          if (!val) return null;
          const cleaned = String(val).replace(/[^\d.,]/g, '').replace(',', '.');
          const num = parseFloat(cleaned);
          return isNaN(num) ? null : num;
        };

        const price250g = parsePrice(p.Price250g || p.price250g || p.Cena250g || p.cena250g || p['250g']);
        const price1kg = parsePrice(p.Price1kg || p.price1kg || p.Cena1kg || p.cena1kg || p['1kg']);

        if (name) {
          const result = insertStmt.run(cycleId, name, desc1, desc2, roast, purpose, price250g, price1kg);
          results.push(result.lastInsertRowid);
        }
      }
      return results;
    });

    const insertedIds = insertMany(records);

    const products = db.prepare(`
      SELECT * FROM products WHERE id IN (${insertedIds.map(() => '?').join(',')})
    `).all(...insertedIds);

    res.status(201).json({
      message: `${products.length} produktov bolo importovanych`,
      products
    });
  } catch (error) {
    console.error('CSV parse error:', error);
    res.status(400).json({ error: 'Chyba pri parsovani CSV: ' + error.message });
  }
});

// Upload image for existing product
router.post('/:id/image', upload.single('image'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }

  let image = null;
  if (req.file) {
    const mimeType = req.file.mimetype;
    const base64 = req.file.buffer.toString('base64');
    image = `data:${mimeType};base64,${base64}`;
  } else if (req.body.image) {
    image = req.body.image;
  }

  db.prepare('UPDATE products SET image = ? WHERE id = ?').run(image, req.params.id);

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Upload image from URL (for drag & drop from external sites)
router.post('/:id/image-from-url', async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }

  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL obrazku je povinne' });
  }

  try {
    // Fetch image from URL
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(400).json({ error: 'Nepodarilo sa stiahnut obrazok z URL' });
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';

    // Validate it's an image
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'URL neobsahuje obrazok' });
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const image = `data:${contentType};base64,${base64}`;

    db.prepare('UPDATE products SET image = ? WHERE id = ?').run(image, req.params.id);

    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (error) {
    console.error('Image download error:', error);
    res.status(400).json({ error: 'Chyba pri stahivani obrazku: ' + error.message });
  }
});

// Update product
router.patch('/:id', (req, res) => {
  const { name, description1, description2, roast_type, purpose, price_150g, price_200g, price_250g, price_1kg, price_20pc5g, image, active } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);

  if (!product) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }

  const updates = [];
  const values = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (description1 !== undefined) { updates.push('description1 = ?'); values.push(description1); }
  if (description2 !== undefined) { updates.push('description2 = ?'); values.push(description2); }
  if (roast_type !== undefined) { updates.push('roast_type = ?'); values.push(roast_type); }
  if (purpose !== undefined) { updates.push('purpose = ?'); values.push(purpose); }
  if (price_150g !== undefined) { updates.push('price_150g = ?'); values.push(price_150g); }
  if (price_200g !== undefined) { updates.push('price_200g = ?'); values.push(price_200g); }
  if (price_250g !== undefined) { updates.push('price_250g = ?'); values.push(price_250g); }
  if (price_1kg !== undefined) { updates.push('price_1kg = ?'); values.push(price_1kg); }
  if (price_20pc5g !== undefined) { updates.push('price_20pc5g = ?'); values.push(price_20pc5g); }
  if (image !== undefined) { updates.push('image = ?'); values.push(image); }
  if (active !== undefined) { updates.push('active = ?'); values.push(active ? 1 : 0); }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete product (soft delete - set active = 0)
router.delete('/:id', (req, res) => {
  const result = db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Produkt nebol najdeny' });
  }
  res.status(204).send();
});

// Import products from Google Sheets URL
router.post('/import-gsheet/:cycleId', async (req, res) => {
  const cycleId = req.params.cycleId;
  const { url } = req.body;

  // Check cycle exists
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }

  if (!url) {
    return res.status(400).json({ error: 'URL je povinne' });
  }

  try {
    // Extract sheet ID and gid from URL
    // Formats:
    // https://docs.google.com/spreadsheets/d/SHEET_ID/edit#gid=TAB_ID
    // https://docs.google.com/spreadsheets/d/SHEET_ID/edit?gid=TAB_ID
    const sheetIdMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) {
      return res.status(400).json({ error: 'Neplatna Google Sheets URL' });
    }
    const sheetId = sheetIdMatch[1];

    // Extract gid (tab ID), default to 0 if not found
    // Only include gid if explicitly provided in URL
    const gidMatch = url.match(/[#?&]gid=(\d+)/);
    const gidParam = gidMatch ? `&gid=${gidMatch[1]}` : '';

    // Fetch CSV from Google Sheets
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gidParam}`;
    const response = await fetch(csvUrl);

    if (!response.ok) {
      return res.status(400).json({ error: 'Nepodarilo sa nacitat Google Sheet. Skontrolujte ci je sheet verejny.' });
    }

    const csvContent = await response.text();

    // Parse CSV (reusing existing logic)
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });

    // Map CSV columns to database fields
    const insertStmt = db.prepare(`
      INSERT INTO products (cycle_id, name, description1, description2, roast_type, purpose, price_250g, price_1kg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((products) => {
      const results = [];
      for (const p of products) {
        // Try to match common column names (Slovak and English)
        const name = p.Name || p.name || p.Nazov || p.nazov || '';
        const desc1 = p.Description1 || p.description1 || p.Popis1 || p.popis1 || '';
        const desc2 = p.Description2 || p.description2 || p.Popis2 || p.popis2 || p.ChutovyProfil || p['Chuťový profil'] || p['Chutovy profil'] || '';
        const roast = p.Roast || p.roast || p.Prazenie || p.prazenie || '';
        const purpose = p.Purpose || p.purpose || p.Ucel || p.ucel || '';

        // Parse prices - handle various formats
        const parsePrice = (val) => {
          if (!val) return null;
          const cleaned = String(val).replace(/[^\d.,]/g, '').replace(',', '.');
          const num = parseFloat(cleaned);
          return isNaN(num) ? null : num;
        };

        const price250g = parsePrice(p.Price250g || p.price250g || p.Cena250g || p.cena250g || p['250g']);
        const price1kg = parsePrice(p.Price1kg || p.price1kg || p.Cena1kg || p.cena1kg || p['1kg']);

        if (name) {
          const result = insertStmt.run(cycleId, name, desc1, desc2, roast, purpose, price250g, price1kg);
          results.push(result.lastInsertRowid);
        }
      }
      return results;
    });

    const insertedIds = insertMany(records);

    if (insertedIds.length === 0) {
      return res.status(400).json({ error: 'Ziadne produkty neboli najdene. Skontrolujte nazvy stlpcov.' });
    }

    const products = db.prepare(`
      SELECT * FROM products WHERE id IN (${insertedIds.map(() => '?').join(',')})
    `).all(...insertedIds);

    res.status(201).json({
      message: `${products.length} produktov bolo importovanych z Google Sheets`,
      products
    });
  } catch (error) {
    console.error('Google Sheets import error:', error);
    res.status(400).json({ error: 'Chyba pri importe: ' + error.message });
  }
});

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

function parseMultiRowProducts(csvContent) {
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

// Import products from Google Sheets with multi-row format (3 rows per product)
router.post('/import-gsheet-multirow/:cycleId', async (req, res) => {
  const cycleId = req.params.cycleId;
  const { url } = req.body;

  // Check cycle exists
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }

  if (!url) {
    return res.status(400).json({ error: 'URL je povinne' });
  }

  try {
    // Extract sheet ID and gid from URL
    const sheetIdMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) {
      return res.status(400).json({ error: 'Neplatna Google Sheets URL' });
    }
    const sheetId = sheetIdMatch[1];

    // Only include gid if explicitly provided in URL
    const gidMatch = url.match(/[#?&]gid=(\d+)/);
    const gidParam = gidMatch ? `&gid=${gidMatch[1]}` : '';

    // Fetch CSV from Google Sheets
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gidParam}`;
    const response = await fetch(csvUrl);

    if (!response.ok) {
      return res.status(400).json({
        error: 'Nepodarilo sa nacitat Google Sheet. Skontrolujte ci je sheet verejny.'
      });
    }

    const csvContent = await response.text();

    // Parse with multi-row logic
    const { products, warnings } = parseMultiRowProducts(csvContent);

    if (products.length === 0) {
      return res.status(400).json({
        error: 'Ziadne produkty neboli najdene. Skontrolujte format sheetu (3 riadky na produkt, oddelene prazdnym riadkom).'
      });
    }

    // Insert products into database (without transaction wrapper to avoid sql.js issues)
    const insertedIds = [];
    for (const p of products) {
      if (p.name) {
        const result = db.prepare(`
          INSERT INTO products (cycle_id, name, description1, description2, roast_type, purpose, price_150g, price_200g, price_250g, price_1kg)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(cycleId, p.name, p.description1, p.description2, p.roast_type, p.purpose, p.price_150g, p.price_200g, p.price_250g, p.price_1kg);
        insertedIds.push(result.lastInsertRowid);
      }
    }

    if (insertedIds.length === 0) {
      return res.status(400).json({
        error: 'Ziadne produkty neboli importovane. Skontrolujte format sheetu.'
      });
    }

    const insertedProducts = db.prepare(`
      SELECT * FROM products WHERE id IN (${insertedIds.map(() => '?').join(',')})
    `).all(...insertedIds);

    res.status(201).json({
      message: `${insertedProducts.length} produktov bolo importovanych z Google Sheets`,
      products: insertedProducts,
      warnings: warnings
    });

  } catch (error) {
    console.error('Google Sheets multi-row import error:', error);
    res.status(400).json({ error: 'Chyba pri importe: ' + error.message });
  }
});

export default router;
