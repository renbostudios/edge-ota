# Changesets

Welcome! This directory contains configuration and changeset markdown files for `@renbostudios/edge-ota` and `@renbostudios/edge-ota-core`.

## Adding a Changeset

When you make a change that warrants an npm release:

1. Run `pnpm changeset` (or `npx changeset`) in your terminal.
2. Select the packages you changed (`@renbostudios/edge-ota` and/or `@renbostudios/edge-ota-core`).
3. Choose the semver bump type (patch, minor, or major).
4. Provide a clear, human-readable summary of what changed.
5. Commit the generated `.changeset/*.md` file and push to `main` (or open a PR).

## Automated Release Flow

When a pull request with a changeset is merged into `main`, GitHub Actions will:
1. Automatically create or update a "Version Packages" release PR.
2. When the release PR is merged, it will publish the updated packages to npm and create a GitHub Release tag.
