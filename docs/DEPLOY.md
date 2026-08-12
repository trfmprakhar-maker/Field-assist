# Deployment notes

## Order of operations
1. Create the D1 database and apply `api/schema.sql`.
2. Set secrets (`AUTH_SECRET`, `ADMIN_KEY`, `PIN_SALT`).
3. `wrangler deploy` the Worker.
4. `wrangler pages deploy public` for the app.
5. Connect the office device, upload its data once, then bring phones online.

## Tighten CORS after the first deploy
`ALLOWED_ORIGIN = "*"` in wrangler.toml lets any site call the API with a valid
token. Once the Pages URL is known, set it to that exact origin and redeploy.

## Backups
D1 has time travel, but take your own too:

    wrangler d1 export sharda-field --remote --output backup-$(date +%F).sql

The app also writes a JSON backup from Reports -> Download backup.

## Adding a salesman
1. Add them in the app under Setup -> Salesmen, and let it sync.
2. Insert a login row:

    wrangler d1 execute sharda-field --remote --command \
      "INSERT INTO users (id,name,role,ref,title) VALUES ('u9','New Name','salesman','m4','SO - Area')"

3. Set their PIN through /api/admin/set-pin.

## If a phone's data looks wrong
Sign out of the server connection and back in, then Sync now. The device keeps
its local copy; pulling from watermark 0 refreshes it from the server.
Do NOT press "Upload everything on this device" from a phone -- that pushes that
phone's copy over everyone else's.
