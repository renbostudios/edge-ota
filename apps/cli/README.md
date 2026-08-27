<p align="center">
  <img src="https://ota.renbo.site/og.png" alt="Edge OTA" width="100%">
</p>

<h1 align="center">EdgeOTA</h1>

<p align="center">
  <strong>Zero-SDK, self-hostable OTA update engine for Expo React Native</strong><br>
  Push cryptographically signed JS bundles to Cloudflare Edge or your own VPS with zero egress fees.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@renbostudios/edge-ota"><img src="https://img.shields.io/npm/v/@renbostudios/edge-ota?style=flat-square&color=81C784" alt="npm version"></a>
  <a href="https://github.com/renbostudios/edge-ota/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@renbostudios/edge-ota?style=flat-square&color=FFAA00" alt="license"></a>
  <a href="https://www.npmjs.com/package/@renbostudios/edge-ota"><img src="https://img.shields.io/npm/dm/@renbostudios/edge-ota?style=flat-square&color=81C784" alt="downloads"></a>
</p>

<p align="center">
  <a href="https://ota.renbo.site">Dashboard</a> · <a href="https://ota.renbo.site/docs">Documentation</a> · <a href="https://pd1mvpk7lt.ufs.sh/f/6uDGWrRxa3ipmhByNjc2TlHph0oA4dsWRFUuqZMan18Gwb7g">Video Tutorial</a> · <a href="https://github.com/renbostudios/edge-ota/issues">Issues</a>
</p>

---

```
 ╔══════════════════════════════════════════════════════════════════╗
 ║                                                                  ║
 ║   ┌─┐┌┬┐┌─┐┌─┐   ┌─┐┌┬┐┌─┐                                       ║
 ║   ├┤  │││ ┬├┤ ───│ │ │ ├─┤                                       ║
 ║   └─┘─┴┘└─┘└─┘   └─┘ ┴ ┴ ┴                                       ║
 ║                                                                  ║
 ║   Push signed OTA updates to the edge.                           ║
 ║   Zero SDK footprint. Zero egress fees. 100% Protocol v1.        ║
 ║                                                                  ║
 ╚══════════════════════════════════════════════════════════════════╝
```

---

## Quick Start

### 1. Install the CLI
```bash
npm install -g @renbostudios/edge-ota
```

### 2. Authenticate
```bash
edge-ota login
```

### 3. Initialize your Expo app
Generates an ECDSA P-256 key pair, registers your project, and configures `app.json`:
```bash
edge-ota init
```

### 4. Rebuild Native Binary (Required)
```bash
npx expo prebuild --clean
npx expo run:ios
npx expo run:android

# or via EAS Build
eas build --profile production
```

> **Important**: The `expo-updates` native module embeds the server URL at build time. Whenever `expo.updates.url` or `runtimeVersion` changes, you must run `prebuild` or make a new native build.

### 5. Publish an OTA Update
```bash
edge-ota push
```

---

## Video Walkthrough

<p align="center">
  <video src="https://pd1mvpk7lt.ufs.sh/f/6uDGWrRxa3ipmhByNjc2TlHph0oA4dsWRFUuqZMan18Gwb7g" controls width="100%" style="max-width: 640px; border: 1px solid #333333; border-radius: 4px; background: #000000;">
    Your browser does not support video playback.
  </video>
</p>

---

## CLI Command Reference

| Command | Description | Key Options |
| :--- | :--- | :--- |
| `edge-ota login` | Authenticate with your EdgeOTA account | `--server <url>` |
| `edge-ota logout` | Clear stored authentication credentials | — |
| `edge-ota init` | Configure `app.json`, register keys, & setup endpoint | `--server <url>` |
| `edge-ota push` | Export, sign, and publish an OTA update | `--channel <name>`, `--runtime <ver>`, `--platform <p>`, `--dry-run` |
| `edge-ota status` | Inspect recent releases & active deployments | `--limit <n>`, `--channel <name>` |
| `edge-ota keygen` | Generate a fresh ECDSA P-256 key pair to stdout | — |

### Multi-Runtime Matrix Updates
Hotfix multiple native runtime versions simultaneously in a single command:
```bash
edge-ota push --runtime 1.0.0,1.0.1,1.0.2 --channel production
```

### Dry Run / Skip Export
```bash
# Export and sign without uploading
edge-ota push --dry-run

# Upload existing pre-exported ./dist bundle
edge-ota push --skip-export
```

---

## Architecture & Data Flow

```
 Developer Workstation               EdgeOTA Backend                   User Device
 ─────────────────────               ───────────────                   ───────────

  edge-ota push ────────────────►   POST /api/updates
                                     (ECDSA verified)
                                     (stores bundle & assets)
                                                     ◄─────────────── GET /api/updates
                                                                       (expo-updates client)
                                                     ────────────────► Signed Multipart Manifest
                                                     ◄─────────────── GET /api/assets/:hash
                                                                       (downloads bundle)
                                                                       (app reloads silently)
```

1. **Local Signing**: `edge-ota push` exports the Hermes JS bundle, signs it locally with your private ECDSA P-256 key, and uploads static media assets (`.png`, `.jpg`, `.ttf`).
2. **Integrity Verification**: The backend validates the signature and SHA-256 asset hashes before accepting the update.
3. **Serving Manifests**: When devices check for updates, the server serves an official Expo Updates Protocol v1 multipart manifest.
4. **Silent Download**: The client downloads changed assets and applies the hotfix on next launch.

---

## Configuration (`app.json`)

`edge-ota init` automatically configures your `app.json`:

```json
{
  "expo": {
    "updates": {
      "url": "https://ota.renbo.site/api/projects/<projectId>/updates",
      "checkAutomatically": "ON_LOAD",
      "fallbackToCacheTimeout": 30000,
      "requestHeaders": {
        "expo-channel-name": "production"
      }
    },
    "runtimeVersion": "1.0.0",
    "extra": {
      "edgeOtaServer": "https://ota.renbo.site",
      "edgeOtaPublicKey": "-----BEGIN PUBLIC KEY-----\n..."
    }
  }
}
```

---

## Self-Hosting Options

EdgeOTA is open-core. You can self-host the entire backend stack on your own infrastructure for free:

### 1. Docker Compose (Node.js + SQLite/Postgres)
```bash
git clone https://github.com/renbostudios/edge-ota.git
cd edge-ota
docker compose up -d
```

### 2. Cloudflare Worker (Serverless Edge + D1 + R2)
Deploy globally with zero egress fees:
```bash
cd apps/worker-oss
npm install
npx wrangler d1 create edge-ota-db
npx wrangler r2 bucket create edge-ota-assets
npx wrangler deploy
```

---

## Security Model

- **ECDSA P-256 Code Signing**: Every JS bundle is signed with your private key before upload.
- **Client-Side Key Storage**: Private keys are stored locally at `~/.config/edge-ota/keys/` with `0600` permissions and never leave your machine.
- **Protocol Compliance**: Strictly compliant with the Expo Updates Protocol v1.

---

## Troubleshooting

<details>
<summary><strong>"Failed to check for update" on app launch</strong></summary>

<br>

The `expo-updates` native module cannot reach your update server because the configuration URL was not embedded in the native binary.

Run a clean native build:
```bash
npx expo prebuild --clean
npx expo run:ios
npx expo run:android
```
</details>

<details>
<summary><strong>Updates apply on iOS but not on Android</strong></summary>

<br>

Ensure `android/app/src/main/AndroidManifest.xml` has the `EXPO_UPDATE_URL` meta-data entry. If testing over a local network or USB, ensure cleartext traffic is permitted for `http://localhost`:

```xml
android:usesCleartextTraffic="true"
```
And route ports over ADB:
```bash
adb reverse tcp:3020 tcp:3020
```
</details>

<details>
<summary><strong>"No signing key found for project" during push</strong></summary>

<br>

Run `edge-ota init` in your project root to generate a key pair, or use `edge-ota keygen` to generate one manually.
</details>

---

## Repository Structure

```
edge-ota/
├── apps/
│   ├── cli/            → @renbostudios/edge-ota CLI (Published on npm)
│   ├── server-node/    → Self-hosted Express + SQLite/Postgres API
│   └── worker-oss/     → Cloudflare Worker serverless edge engine
└── packages/
    └── core/           → ECDSA P-256 signing & Expo manifest protocol
```

---

<p align="center">
  Built with care by <a href="https://renbostudios.com">Renbo Studios</a><br>
  <sub>MIT License · Open Source</sub>
</p>
