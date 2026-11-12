# @renbostudios/edge-ota

## 0.5.0

### Minor Changes

- 1ec67e9: Point the CLI at the new `api.ota.renbo.dev` API and add a domain-migration notice.
  
  - Default server is now `https://api.ota.renbo.dev` (was `https://api.ota.renbo.site`)
  - Prints a migration notice when the saved config still targets the legacy host, and a
    once-per-day informational notice otherwise
  - Warns during `edge-ota push` when `app.json` still uses the legacy server URL
  - The legacy `api.ota.renbo.site` endpoint remains supported and keeps receiving updates

## 0.4.3

### Patch Changes

- a46c96e: Update package repository URLs to renbostudios/edge-ota, overhaul README documentation, and refresh branding assets.

## 0.4.2

### Patch Changes

- 7e027db: feat: add automated static asset synchronization, multi-runtime matrix support, 3-part diagnostic error logs, network fault detection, and rich --help documentation across all commands

## 0.4.1

### Patch Changes

- 0ae1042: feat: initialize automated npm release pipeline with Changesets and GitHub Actions
  feat: enhance CLI with 3-part diagnostic error logs, network fault detection, and rich --help documentation across all commands
  feat: support multi-runtime matrix deployments (--runtime 1.0.0,1.0.1,2.0.0) and automated static asset synchronization
- Updated dependencies [0ae1042]
  - @renbostudios/edge-ota-core@0.1.1
