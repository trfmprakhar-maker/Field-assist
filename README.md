# Sharda Field

Sales force automation and distributor management for **Sharda Bhog** (Sharda Fresh Foods Pvt Ltd) — beat working, order booking, schemes, targets, outstanding and distributor stock, built for field use on phones with patchy signal.

- `public/index.html` — the whole app. One file, no build step, works offline.
- `api/` — Cloudflare Worker + D1 database that lets several phones share one set of data.

The app runs perfectly well with no server at all: everything is stored on the device. Connect the API when you need orders from every salesman to land in one place.

---

## What it does

**Field** — attendance punch in/out with location, beat plan by weekday, monthly journey plan with adherence and deviation tracking.

**Sales** — order booking with live scheme calculation, an order slip, scheme master (quantity slab, free goods, bill value, flat %), monthly targets by salesman and by SKU with run rate and projection.

**Finance** — invoices raised automatically from orders using each distributor's credit days, ageing in 0–15 / 16–30 / 31–60 / 60+ buckets, collections against specific bills, credit-limit warnings at booking, distributor scheme claims.

**Network** — outlet master with GPS or manually entered coordinates, distributor stock ledger showing primary in, secondary out, closing stock and days of cover.

**Roles** — admin, ASM, salesman and distributor. Each sees only its own slice; scoping is enforced on the server, not just hidden in the interface.

---

## Setting up the server

Needs Node 18+ and a Cloudflare account.

```bash
npm install -g wrangler
wrangler login

cd api
wrangler d1 create sharda-field          # copy the database_id it prints
# paste that id into wrangler.toml

wrangler d1 execute sharda-field --remote --file=./schema.sql

wrangler secret put AUTH_SECRET          # any long random string
wrangler secret put ADMIN_KEY            # your own admin password
wrangler secret put PIN_SALT             # use "sharda" to keep the seeded PINs working

wrangler deploy                          # prints your API address
```

Then publish the app itself:

```bash
cd ..
wrangler pages deploy public --project-name sharda-field
```

Open the Pages URL, go to **Reports → Connection and sync**, paste the API address, sign in, and — **from the office device that holds the real data, once only** — press *Upload everything on this device*. Every other phone then pulls from the server.

### Change the PINs before anyone uses it

Every seeded user starts with PIN `1234`. Change them:

```bash
curl -X POST https://YOUR-API/api/admin/set-pin \
  -H "x-admin-key: YOUR_ADMIN_KEY" -H "content-type: application/json" \
  -d '{"userId":"u3","pin":"7412"}'
```

---

## How syncing works

Every local change is written to the device first and appended to an outbox. The outbox is flushed to `POST /api/push` whenever a connection is available, then `GET /api/pull?since=<watermark>` brings back anything newer. A salesman can work a full beat with no signal; it uploads when he gets back to town.

Documents are keyed by an id generated on the device, so replaying the same operation is harmless. Conflicts resolve last-write-wins on the server's clock — fine for this shape of work, where two people rarely touch the same record. It is **not** suitable for anything needing strict consistency, like stock reservation.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| POST | `/api/login` | `{userId, pin}` → token |
| GET | `/api/pull?since=` | documents changed since a watermark, scoped to the role |
| POST | `/api/push` | apply a batch of document writes |
| POST | `/api/admin/set-pin` | set a user's PIN (needs `x-admin-key`) |
| POST | `/api/admin/import` | bulk load documents (needs `x-admin-key`) |

### Data model

One `docs` table holding JSON documents with a type and an `updated_at` stamp. Chosen so the schema can change without migrations while the app is still finding its shape. `schema.sql` also defines SQL views — `v_orders`, `v_order_lines`, `v_invoices`, `v_outlets`, `v_visits`, `v_collections` — so reports can be run straight against D1:

```sql
SELECT sku_id, SUM(qty) packs, SUM(qty*rate) value
FROM v_order_lines WHERE order_date >= '2026-08-01'
GROUP BY sku_id ORDER BY value DESC;
```

---

## Known limitations

- **Last-write-wins.** Two people editing the same outlet at once: the later save wins silently.
- **PINs, not passwords.** Fine for a field team on known devices; not for anything sensitive.
- **No image capture.** Shelf photos and planogram audits are not built.
- **No van sales.** Order booking only; no ready-stock loading or field invoicing.
- **Pull is capped at 5000 documents per call.** Enough for a few years at this scale; a busier network needs paging.
- **Geolocation needs https.** It will not work from a `file://` page — see the in-app check under Reports.

## Licence

Private. All rights reserved.


