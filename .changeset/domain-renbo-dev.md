---
"@renbostudios/edge-ota": minor
---

Point the CLI at the new `api.ota.renbo.dev` API and add a domain-migration notice.

- Default server is now `https://api.ota.renbo.dev` (was `https://api.ota.renbo.site`)
- Prints a migration notice when the saved config still targets the legacy host, and a
  once-per-day informational notice otherwise
- Warns during `edge-ota push` when `app.json` still uses the legacy server URL
- The legacy `api.ota.renbo.site` endpoint remains supported and keeps receiving updates
