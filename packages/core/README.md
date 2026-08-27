# `@edge-ota/core`

> Core manifest generation, ECDSA cryptography, and Expo Updates Protocol v1 utilities for the EdgeOTA platform.

This package is a **peer dependency** of `@edge-ota/cli` and `@edge-ota/server-node`. You typically don't need to install it directly unless you're building a custom EdgeOTA-compatible server.

## Install

```bash
npm install @edge-ota/core
```

## API

### Manifest

```ts
import { generateExpoManifest, createExpoHeaders, buildMultipartManifestBody } from '@edge-ota/core'

// Build an Expo Updates v1 manifest
const manifest = generateExpoManifest({
  updateId:       'uuid-here',
  createdAt:      new Date().toISOString(),
  runtimeVersion: '1.0.0',
  bundleUrl:      'https://your-server.com/api/assets/<hash>',
  bundleHash:     'sha256-hex-here',
  assets:         [],
  metadata:       { deployedBy: 'CLI' }
})

// Build response headers (optionally include ECDSA signature)
const headers = createExpoHeaders(signature)

// Build multipart/mixed body for expo-updates >= 0.18
const { body, boundary } = buildMultipartManifestBody(manifest, signature)
```

### Crypto

```ts
import { generateECDSAKeyPair, signPayload, verifyPayload, sha256Hex } from '@edge-ota/core'

// Generate a fresh key pair (PEM strings)
const { privateKey, publicKey } = await generateECDSAKeyPair()

// Sign a payload string
const signature = await signPayload(JSON.stringify(payload), privateKey)

// Verify a signature
const valid = await verifyPayload(JSON.stringify(payload), signature, publicKey)

// SHA-256 hash of an ArrayBuffer → hex string
const hash = await sha256Hex(fileBuffer)
```

## License

MIT
