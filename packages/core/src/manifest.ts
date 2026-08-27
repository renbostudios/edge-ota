/**
 * EdgeOTA Core - Expo Updates Protocol v1 Manifest Engine
 *
 * Implements the exact wire format consumed by expo-updates SDK,
 * matching the official expo/custom-expo-updates-server reference:
 * - EAS Update-compatible manifest structure
 * - Multipart/mixed response body with FormData-compatible boundary
 * - expo-signature header for ECDSA bundle verification
 * - fileExtension on launchAsset and assets
 * - extra.expoClient config passthrough
 */

export interface ExpoAsset {
  hash: string;       // SHA-256 base64url of the asset bytes
  key: string;        // MD5 hex of the asset content (used as filename on device)
  fileExtension: string; // e.g. ".bundle", ".png", ".ttf" — REQUIRED by expo-updates
  contentType: string;
  url: string;        // Absolute URL the client will fetch from
}

export interface ExpoManifest {
  id: string;              // Stable UUID for this update
  createdAt: string;       // ISO 8601
  runtimeVersion: string;  // Must exactly match the app's runtimeVersion
  launchAsset: ExpoAsset;
  assets: ExpoAsset[];
  metadata?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface ManifestResponse {
  manifest: ExpoManifest;
  headers: Record<string, string>;
}

/** Parameters required to build a manifest */
export interface ManifestParams {
  updateId: string;
  createdAt: string;
  runtimeVersion: string;
  /** Public-facing HTTPS URL for the JS bundle */
  bundleUrl: string;
  /** SHA-256 hex digest of the raw bundle bytes */
  bundleHash: string;
  /** MD5 hex of the bundle bytes — used as the `key` field (device filename) */
  bundleKey?: string;
  assets: ExpoAsset[];
  metadata?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/**
 * Convert a hex SHA-256 hash to base64url encoding.
 * expo-updates verifies downloaded assets by computing SHA-256, base64url-encoding it,
 * and comparing against the manifest `hash` field.
 */
function hexToBase64Url(hex: string): string {
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return hex;
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(hex, "hex").toString("base64url");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  let binString = "";
  for (let i = 0; i < bytes.length; i++) {
    binString += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binString);
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Build the Expo Updates v1 manifest object.
 * Matches the format produced by expo/custom-expo-updates-server.
 */
export function generateExpoManifest(params: ManifestParams): ExpoManifest {
  return {
    id: params.updateId,
    createdAt: params.createdAt,
    runtimeVersion: params.runtimeVersion,
    launchAsset: {
      hash: hexToBase64Url(params.bundleHash),
      key: params.bundleKey || params.bundleHash.slice(0, 32),
      fileExtension: ".bundle",
      contentType: "application/javascript",
      url: params.bundleUrl
    },
    assets: params.assets.map(asset => ({
      ...asset,
      hash: hexToBase64Url(asset.hash)
    })),
    metadata: params.metadata ?? {},
    extra: params.extra ?? {}
  };
}

/**
 * Build the response headers required by the Expo Updates protocol.
 *
 * expo-protocol-version: "1"  — Signals v1 manifest format
 * expo-sfv-version: "0"       — Structured Fields version
 * cache-control               — Updates must never be stale; client always revalidates
 * expo-signature              — ECDSA P-256 + SHA-256 signature over the manifest JSON
 */
export function createExpoHeaders(signature?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "expo-protocol-version": "1",
    "expo-sfv-version": "0",
    "cache-control": "private, max-age=0",
  };

  if (signature) {
    headers["expo-signature"] = `sig="${signature}", keyid="root", alg="ecdsa-p256-sha256"`;
  }

  return headers;
}

/**
 * Build the multipart/mixed response body required by expo-updates protocol v1.
 * Uses FormData-compatible boundary formatting matching the official Expo server.
 *
 * The expo-updates native client parses this multipart body to extract the manifest
 * from the part named "manifest".
 */
export function buildMultipartManifestBody(
  manifest: ExpoManifest,
  signature?: string
): { body: string; boundary: string; contentType: string } {
  const boundary = "ota" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const manifestJson = JSON.stringify(manifest);

  // Build the manifest part headers exactly as FormData would
  let manifestPart = `--${boundary}\r\n`;
  manifestPart += `Content-Disposition: form-data; name="manifest"\r\n`;
  manifestPart += `Content-Type: application/json; charset=utf-8\r\n`;
  if (signature) {
    manifestPart += `expo-signature: sig="${signature}", keyid="root", alg="ecdsa-p256-sha256"\r\n`;
  }
  manifestPart += `\r\n`;
  manifestPart += manifestJson;
  manifestPart += `\r\n`;

  // Build the extensions part (included by official Expo server)
  const extensions = { assetRequestHeaders: {} };
  let extensionsPart = `--${boundary}\r\n`;
  extensionsPart += `Content-Disposition: form-data; name="extensions"\r\n`;
  extensionsPart += `Content-Type: application/json\r\n`;
  extensionsPart += `\r\n`;
  extensionsPart += JSON.stringify(extensions);
  extensionsPart += `\r\n`;

  const body = manifestPart + extensionsPart + `--${boundary}--\r\n`;

  return { body, boundary, contentType: `multipart/mixed; boundary=${boundary}` };
}

