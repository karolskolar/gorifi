# Catalog: product-image files + the multirow import (module 12)

## 2026-09-30 — production lost every product image file (restored)

**Symptom.** After a catalog import the PO saw no product photos anywhere in production.

**What was actually true.** Since PC-T10 the `image` columns hold `/api/images/<sha256[:32]>.<ext>`
URLs; the bytes live in `backend/src/db/uploads/` (sibling of the SQLite file). Production's
DB referenced **71** such files (141 `products` rows + 54 `coffee_products` rows) while the
directory was **empty** (mtime 2026-09-29 20:42 = the boot that re-created it with `mkdirSync`).
52 older `products` rows still carry inline `data:` URIs and were never affected.

**When.** The Drive backups date it (`rclone lsl gdrive:db-backups/ | grep uploads`):
`gorifi-uploads-…` was ~20 MB through the **2026-09-06 03:00** cron, then **absent** for every
run until 09-29 (`backup-db.sh` skips the tar when the directory does not exist), then 12 KB.
Two production deploys ran on 2026-09-06 at 12:33 and 12:36 and produced a DB backup but no
uploads tar. Most likely cause (not proven): a deploy from a checkout whose `deploy.sh` predates
PC-T10's `--exclude 'src/db/uploads'`, so `rsync --delete` removed the directory (and its older
`backup-db.sh` did not tar uploads either).

**Restore (what was run).**
```bash
W=/root/uploads-restore-20260930; mkdir -p $W && cd $W
runuser -u gorifi -- rclone cat gdrive:db-backups/gorifi-uploads-20260906-030001-cron.tar.age > u.tar.age
age -d -i /var/www/gorifi/secrets/backup-age-key.txt u.tar.age > u.tar && mkdir x && tar -xf u.tar -C x
# verify: every filename's hex == first 32 hex of sha256(content) — 72/72 matched
cp -n x/uploads/* /var/www/gorifi/backend/src/db/uploads/ && chown gorifi:gorifi /var/www/gorifi/backend/src/db/uploads/*
```
All 71 referenced files were in that backup (72 files; one orphan). No DB change, no restart:
`GET /api/images/:filename` reads the directory per request. Verified 71× HTTP 200 over
`https://podpultovka.biz/api/images/…`.

**Check next time.** `comm -23 <(sqlite3 … "SELECT image … LIKE '/api/images/%'" | sed 's#/api/images/##' | sort -u) <(ls uploads | sort)`
lists referenced-but-missing files. An uploads tar that suddenly shrinks (or disappears) in the
Drive listing is the early warning.

## 2026-09-30 — photos from the supplier Google Sheet

The sheet's CSV export carries no images, but the **XLSX export**
(`/export?format=xlsx`) embeds them under `xl/media/` with drawing anchors
(`xl/drawings/drawingN.xml`, `<xdr:from><xdr:row>`), so each picture maps to the product name in
column B of its anchor row. The `sk` tab held 24 product photos. There is no code path for this —
it was a one-off script; the photos were then uploaded through the admin catalog
(`POST /api/coffee-products/:id/image`).

## 2026-09-30 — multirow import: blocks that are not products are skipped (PO-sanctioned)

The 09-30 production import created „Nespresso kapsule" (a sub-section header row of the sheet)
as a price-less catalog product. `parseMultiRowProducts()` pushed any block with a name when a
separator arrived, even one with only its name row. Today's sheet would additionally have
produced 8 „products" named „4 EUR", „11 EUR", … from the delivery table under the products.

Second sanctioned amendment to the frozen parser (the first is PC-T12): `multiRowSkipReason()`
skips (a) a **one-row block** and (b) a block with **no variant label and no price**. They are
returned as `skipped: [{row, reason}]`, and `importRowsIntoCatalog(…, { skipped })` reports them
under `unparsed` (whose meaning — "nothing was written for this row" — is unchanged, so the report
shape contract holds). A LABELLED block that cannot be priced (unknown pack size) still imports
with a warning, as PC-T12 pinned. Against the live sheet: 20 products, 14 skips.
Note the one-cell-row-is-a-separator rule makes „Rozpustná káva" / „CAFEC drip filtre" one-row
blocks too; they are not catalog coffees, so skipping them is correct.
Pinned in `catalog-import.spec.js` („2026-09-30 — multirow blocks that are not products").

## 2026-09-30 — catalog clean-up on production

Via the app's own code paths, run as `gorifi` from `/var/www/gorifi/backend` after a backup:
- `mergeCatalogRows(57, 34)`: the old „Ethiopia Aricha Washed" (34) merged INTO today's
  „Ethiopia Aricha" (57). Direction chosen so the survivor carries the sheet's exact name (the next
  import matches it instead of re-creating a duplicate) and the current prices; 34's two cycle
  snapshots were repointed. Target wins entirely, so 57 has no image until one is uploaded.
- 59 „Nespresso kapsule" deleted with the `DELETE /api/coffee-products/:id` transaction
  (unlink snapshots, then delete; it had none).
