-- Sharda Field — D1 schema
-- Apply with:  npx wrangler d1 execute sharda-field --remote --file=./schema.sql

DROP TABLE IF EXISTS docs;
CREATE TABLE docs (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL,              -- JSON document
  updated_at INTEGER NOT NULL,           -- ms since epoch, set by the server
  deleted    INTEGER NOT NULL DEFAULT 0,
  actor      TEXT                        -- user id that last wrote this
);
CREATE INDEX idx_docs_type    ON docs(type);
CREATE INDEX idx_docs_updated ON docs(updated_at);
CREATE INDEX idx_docs_live    ON docs(type, deleted);

DROP TABLE IF EXISTS users;
CREATE TABLE users (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  role  TEXT NOT NULL CHECK (role IN ('admin','asm','salesman','distributor')),
  ref   TEXT,                            -- salesman/distributor/asm id this login maps to
  title TEXT,
  pin   TEXT                             -- sha256(pin + PIN_SALT)
);

-- Default PIN for every seeded user is 1234 (salt "sharda").
-- CHANGE THESE before you let anyone in:
--   npx wrangler d1 execute sharda-field --remote \
--     --command "UPDATE users SET pin=NULL"        -- locks everyone out, then set per user
-- or POST /api/admin/set-pin with the X-Admin-Key header.
INSERT INTO users (id,name,role,ref,title,pin) VALUES
 ('u0','Prakhar','admin',NULL,'Business head','aba386643340b9d9e1c175f1f106127b5ceeb298dde295e030ae2554dd879fdb'),
 ('u1','Sanjay Dubey','asm','a1','ASM — Kanpur','aba386643340b9d9e1c175f1f106127b5ceeb298dde295e030ae2554dd879fdb'),
 ('u2','Rakesh Singh','asm','a2','ASM — Prayagraj','aba386643340b9d9e1c175f1f106127b5ceeb298dde295e030ae2554dd879fdb'),
 ('u3','Ramesh Yadav','salesman','m1','SO — Kanpur City','aba386643340b9d9e1c175f1f106127b5ceeb298dde295e030ae2554dd879fdb'),
 ('u4','Sunil Verma','salesman','m2','SO — Kanpur Dehat','aba386643340b9d9e1c175f1f106127b5ceeb298dde295e030ae2554dd879fdb'),
 ('u5','Ajay Mishra','salesman','m3','SO — Prayagraj','aba386643340b9d9e1c175f1f106127b5ceeb298dde295e030ae2554dd879fdb'),
 ('u6','Agarwal Traders','distributor','d1','Distributor — Kanpur City','aba386643340b9d9e1c175f1f106127b5ceeb298dde295e030ae2554dd879fdb'),
 ('u7','Shri Balaji Agency','distributor','d2','Distributor — Kanpur Dehat','aba386643340b9d9e1c175f1f106127b5ceeb298dde295e030ae2554dd879fdb'),
 ('u8','Prayag Distributors','distributor','d3','Distributor — Prayagraj','aba386643340b9d9e1c175f1f106127b5ceeb298dde295e030ae2554dd879fdb');

-- ---------- reporting views ----------
-- These make the JSON queryable with ordinary SQL, so you can run reports
-- straight against D1 without going through the app.

DROP VIEW IF EXISTS v_outlets;
CREATE VIEW v_outlets AS
SELECT id,
  json_extract(data,'$.name')        AS name,
  json_extract(data,'$.area')        AS market,
  json_extract(data,'$.type')        AS outlet_type,
  json_extract(data,'$.beat')        AS beat_day,
  json_extract(data,'$.distId')      AS distributor_id,
  json_extract(data,'$.salesmanId')  AS salesman_id,
  json_extract(data,'$.creditLimit') AS credit_limit,
  json_extract(data,'$.lat')         AS lat,
  json_extract(data,'$.lng')         AS lng
FROM docs WHERE type='outlet' AND deleted=0;

DROP VIEW IF EXISTS v_orders;
CREATE VIEW v_orders AS
SELECT id,
  json_extract(data,'$.date')       AS order_date,
  json_extract(data,'$.outletId')   AS outlet_id,
  json_extract(data,'$.distId')     AS distributor_id,
  json_extract(data,'$.salesmanId') AS salesman_id,
  json_extract(data,'$.gross')      AS gross,
  json_extract(data,'$.disc')       AS scheme_discount,
  json_extract(data,'$.total')      AS net_value
FROM docs WHERE type='order' AND deleted=0;

DROP VIEW IF EXISTS v_order_lines;
CREATE VIEW v_order_lines AS
SELECT d.id AS order_id,
  json_extract(d.data,'$.date')     AS order_date,
  json_extract(d.data,'$.outletId') AS outlet_id,
  json_extract(l.value,'$.skuId')   AS sku_id,
  json_extract(l.value,'$.qty')     AS qty,
  json_extract(l.value,'$.free')    AS free_qty,
  json_extract(l.value,'$.rate')    AS rate,
  json_extract(l.value,'$.disc')    AS line_discount,
  json_extract(l.value,'$.scheme')  AS scheme
FROM docs d, json_each(json_extract(d.data,'$.lines')) l
WHERE d.type='order' AND d.deleted=0;

DROP VIEW IF EXISTS v_invoices;
CREATE VIEW v_invoices AS
SELECT id,
  json_extract(data,'$.date')     AS invoice_date,
  json_extract(data,'$.due')      AS due_date,
  json_extract(data,'$.outletId') AS outlet_id,
  json_extract(data,'$.distId')   AS distributor_id,
  json_extract(data,'$.amount')   AS amount,
  json_extract(data,'$.paid')     AS paid,
  json_extract(data,'$.amount') - json_extract(data,'$.paid') AS balance
FROM docs WHERE type='invoice' AND deleted=0;

DROP VIEW IF EXISTS v_visits;
CREATE VIEW v_visits AS
SELECT id,
  json_extract(data,'$.date')       AS visit_date,
  json_extract(data,'$.outletId')   AS outlet_id,
  json_extract(data,'$.salesmanId') AS salesman_id,
  json_extract(data,'$.status')     AS status,
  json_extract(data,'$.lat')        AS lat,
  json_extract(data,'$.lng')        AS lng
FROM docs WHERE type='visit' AND deleted=0;

DROP VIEW IF EXISTS v_collections;
CREATE VIEW v_collections AS
SELECT id,
  json_extract(data,'$.date')       AS receipt_date,
  json_extract(data,'$.outletId')   AS outlet_id,
  json_extract(data,'$.invoiceId')  AS invoice_id,
  json_extract(data,'$.mode')       AS mode,
  json_extract(data,'$.salesmanId') AS salesman_id,
  json_extract(data,'$.amount')     AS amount
FROM docs WHERE type='collection' AND deleted=0;
