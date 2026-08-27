# Contributing to EdgeOTA

Thank you for your interest in contributing to **EdgeOTA**! We welcome bug reports, feature suggestions, documentation improvements, and pull requests.

---

## 🛠️ Local Development Setup

EdgeOTA is organized as a pnpm monorepo:

```
apps/
  cli/           → @renbostudios/edge-ota (Commander CLI)
  server-node/   → Self-hosted Express + SQLite/Postgres backend
  worker-oss/    → Cloudflare Worker serverless edge engine
packages/
  core/          → Shared ECDSA P-256 crypto and Expo protocol v1 logic
```

### Prerequisites
- **Node.js**: v20 or v24
- **pnpm**: v9 or v10 (`npm install -g pnpm`)

### 1. Clone and Install
```bash
git clone https://github.com/renbostudios/edge-ota.git
cd edge-ota
pnpm install
```

### 2. Build All Packages
```bash
pnpm run build
```

---

## 🧪 Testing Your Changes Locally

### Testing the CLI
You can test CLI commands directly against a local test Expo app:
```bash
# Build the CLI bundle
pnpm --filter @renbostudios/edge-ota build

# Run the local build with your flags
node apps/cli/dist/index.js --help
```

### Testing the Self-Hosted Server
```bash
pnpm --filter @edge-ota/server-node dev
# Server will listen on http://localhost:3000
```

### Testing the Cloudflare Worker
```bash
pnpm --filter @edge-ota/worker-oss dev
```

---

## 📦 Creating a Changeset for Releases

If your pull request introduces a bug fix or a new feature to `@renbostudios/edge-ota`:

1. Run the Changeset wizard:
   ```bash
   pnpm changeset
   ```
2. Select `@renbostudios/edge-ota` (press Space).
3. Select the bump type (`patch` for bug fixes, `minor` for new features).
4. Enter a concise description of your change.
5. Commit the generated `.changeset/*.md` file with your PR.

---

## 📝 Pull Request Guidelines

1. **Keep it focused**: One bug fix or feature per pull request.
2. **Type safety**: Ensure `pnpm run build` passes with zero TypeScript errors.
3. **Open an issue**: For large architectural changes or new protocol features, please open an issue first to discuss the design with maintainers.

Thank you for helping make OTA updates open, fast, and accessible to the Expo community!
