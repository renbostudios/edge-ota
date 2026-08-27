import { generateExpoManifest, createExpoHeaders, buildMultipartManifestBody, verifyPayload, signPayload } from "@renbostudios/edge-ota-core";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** ECDSA P-256 PEM public key — used to verify CLI upload signatures */
  PUBLIC_KEY: string;
  /** ECDSA P-256 PEM private key — used to sign manifests served to devices */
  PRIVATE_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── CORS preflight ───────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, expo-platform, expo-runtime-version, expo-channel-name, expo-expect-signature"
        }
      });
    }

    if (url.pathname === "/api/updates" && request.method === "GET") {
      return handleGetManifest(request, env);
    }

    if (url.pathname === "/api/updates" && request.method === "POST") {
      return handlePostUpdate(request, env);
    }

    if (url.pathname.startsWith("/api/assets/")) {
      return handleGetAsset(request, env);
    }

    return new Response("Not Found", { status: 404 });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 & 3: Client Handshake + Manifest Response
// ─────────────────────────────────────────────────────────────────────────────
//
// The Expo SDK sends:
//   GET /api/updates
//   expo-platform: ios | android
//   expo-runtime-version: <semver>     ← must match a stored update
//   expo-channel-name: production      ← selects the deployment channel
//   expo-expect-signature: true        ← client wants a signed manifest
//
// We respond with the Expo Updates v1 manifest, signed with our ECDSA
// private key if the client has code-signing enabled.
// ─────────────────────────────────────────────────────────────────────────────
async function handleGetManifest(request: Request, env: Env): Promise<Response> {
  const platform       = request.headers.get("expo-platform");
  const runtimeVersion = request.headers.get("expo-runtime-version");
  const channel        = request.headers.get("expo-channel-name") || "production";

  if (!platform || !runtimeVersion) {
    return new Response(
      JSON.stringify({ error: "Missing required Expo headers: expo-platform, expo-runtime-version" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  // ── 1. Resolve channel config ─────────────────────────────────────────────
  const channelRow = await env.DB.prepare(
    "SELECT * FROM channels WHERE id = ?"
  ).bind(channel).first<{
    id: string;
    runtime: string;
    rollout: number;
    active_release_id: string;
    target_platform: string;
    status: string;
  }>();

  // Progressive rollout check — use IP hash for deterministic bucketing
  if (channelRow && channelRow.rollout < 100) {
    const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
    const bucket = djb2Bucket(ip);
    if (bucket >= channelRow.rollout) {
      return new Response("No update available (rollout excluded)", { status: 204 });
    }
  }

  // ── 2. Fetch the update record ────────────────────────────────────────────
  let update: {
    id: string;
    created_at: string;
    runtime_version: string;
    bundle_hash: string;
    platform: string;
    metadata: string;
  } | null = null;

  if (channelRow?.active_release_id) {
    // Channel pinned to a specific release
    update = await env.DB.prepare(
      "SELECT * FROM updates WHERE id = ?"
    ).bind(channelRow.active_release_id).first();
    // Fallback if platform or runtime mismatch
    if (update && (update.platform !== "all" && update.platform !== platform.toLowerCase() || update.runtime_version !== runtimeVersion)) {
      update = await env.DB.prepare(
        "SELECT * FROM updates WHERE runtime_version = ? AND channel = ? AND (platform = ? OR platform = 'all') ORDER BY created_at DESC LIMIT 1"
      ).bind(runtimeVersion, channel, platform.toLowerCase()).first();
    }
  } else {
    // Latest matching runtime
    update = await env.DB.prepare(
      "SELECT * FROM updates WHERE runtime_version = ? AND channel = ? AND (platform = ? OR platform = 'all') ORDER BY created_at DESC LIMIT 1"
    ).bind(runtimeVersion, channel, platform.toLowerCase()).first();
  }

  if (!update) {
    return new Response("No update available", { status: 204 });
  }

  // ── 3. Runtime version guard ──────────────────────────────────────────────
  // Hard requirement from the Expo protocol: the runtimeVersion in the
  // manifest must EXACTLY match the one the client sent. If it doesn't, the
  // SDK will discard the update silently (or throw in strict mode).
  if (update.runtime_version !== runtimeVersion) {
    return new Response(
      `Runtime version mismatch: client=${runtimeVersion}, update=${update.runtime_version}`,
      { status: 204 }
    );
  }

  // ── 4. Build the manifest ─────────────────────────────────────────────────
  const origin = new URL(request.url).origin;
  const manifest = generateExpoManifest({
    updateId:       update.id,
    createdAt:      update.created_at,
    runtimeVersion: update.runtime_version,
    bundleUrl:      `${origin}/api/assets/${update.bundle_hash}`,
    bundleHash:     update.bundle_hash,
    assets:         [],
    metadata:       JSON.parse(update.metadata || "{}")
  });

  // ── 5. Sign the manifest ──────────────────────────────────────────────────
  let manifestSignature: string | undefined;
  const wantsSignature = request.headers.get("expo-expect-signature") === "true";

  if (env.PRIVATE_KEY && wantsSignature) {
    try {
      const manifestJson = JSON.stringify(manifest);
      manifestSignature = await signPayload(manifestJson, env.PRIVATE_KEY);
    } catch (err) {
      console.error("[Worker] Manifest signing failed:", err);
    }
  }

  const headers = createExpoHeaders(manifestSignature);

  // ── 6. Multipart or plain JSON response ──────────────────────────────────
  const acceptHeader = request.headers.get("accept") || "";
  if (acceptHeader.includes("multipart/mixed")) {
    const { body, boundary } = buildMultipartManifestBody(manifest, manifestSignature);
    return new Response(body, {
      headers: {
        ...headers,
        "content-type": `multipart/mixed; boundary="${boundary}"`,
        "access-control-allow-origin": "*"
      }
    });
  }

  return new Response(JSON.stringify(manifest), {
    headers: {
      ...headers,
      "access-control-allow-origin": "*"
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: CLI Upload Handler
// ─────────────────────────────────────────────────────────────────────────────
async function handlePostUpdate(request: Request, env: Env): Promise<Response> {
  try {
    const formData = await request.formData();
    const bundleFile    = formData.get("bundle")    as File | null;
    const payloadString = formData.get("payload")   as string | null;
    const signature     = formData.get("signature") as string | null;
    const platform      = formData.get("platform")  as string | null;

    if (!bundleFile || !payloadString || !signature) {
      return new Response(
        "Missing parameters: bundle, payload, and signature are required",
        { status: 400 }
      );
    }

    // ── Verify ECDSA signature ─────────────────────────────────────────────
    if (env.PUBLIC_KEY) {
      const isValid = await verifyPayload(payloadString, signature, env.PUBLIC_KEY);
      if (!isValid) {
        return new Response("Invalid signature — ECDSA verification failed", { status: 401 });
      }
    }

    const payload = JSON.parse(payloadString) as {
      channel:        string;
      runtimeVersion: string;
      platform?:      string;
      bundleHash:     string;
      timestamp:      number;
      assetCount?:    number;
    };

    if (typeof payload.runtimeVersion !== "string") {
      return new Response("Invalid runtimeVersion: must be a string. Please upgrade your CLI to the latest version of @renbostudios/edge-ota.", { status: 400 });
    }

    const updatePlatform = platform || payload.platform || "all";
    const bundleHash     = payload.bundleHash;

    // ── Store bundle in R2 (content-addressed) ─────────────────────────────
    const bundleArrayBuffer = await bundleFile.arrayBuffer();
    const r2Key = `assets/${bundleHash}`;

    // Only store if not already present (deduplication)
    const existing = await env.BUCKET.head(r2Key);
    if (!existing) {
      await env.BUCKET.put(r2Key, bundleArrayBuffer, {
        httpMetadata: {
          contentType:  "application/zip",
          cacheControl: "public, max-age=31536000, immutable"
        },
        customMetadata: {
          channel:        payload.channel,
          runtimeVersion: payload.runtimeVersion,
          platform:       updatePlatform,
          uploadedAt:     new Date().toISOString()
        }
      });
    }

    // ── Insert update record into D1 ───────────────────────────────────────
    const updateId  = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await env.DB.prepare(
      "INSERT INTO updates (id, created_at, runtime_version, channel, bundle_hash, platform, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      updateId,
      createdAt,
      payload.runtimeVersion,
      payload.channel,
      bundleHash,
      updatePlatform,
      JSON.stringify({
        deployedBy: "CLI",
        platform:   updatePlatform,
        assetCount: payload.assetCount ?? 0,
        uploadedAt: createdAt
      })
    ).run();

    // ── Auto-create / update channel record ────────────────────────────────
    const channelRow = await env.DB.prepare(
      "SELECT id FROM channels WHERE id = ?"
    ).bind(payload.channel).first();

    if (!channelRow) {
      const envLabel =
        payload.channel === "production" ? "Production" :
        payload.channel === "staging"    ? "Staging" :
        "Development";

      await env.DB.prepare(
        "INSERT INTO channels (id, env, status, rollout, runtime, active_release_id, target_platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        payload.channel, envLabel, "Active", 100,
        payload.runtimeVersion, updateId, updatePlatform, createdAt
      ).run();
    } else {
      await env.DB.prepare(
        "UPDATE channels SET active_release_id = ?, runtime = ? WHERE id = ?"
      ).bind(updateId, payload.runtimeVersion, payload.channel).run();
    }

    return new Response(
      JSON.stringify({ updateId, channel: payload.channel, runtimeVersion: payload.runtimeVersion, bundleHash, createdAt }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return new Response(message, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset Delivery — serves bundles from R2
// ─────────────────────────────────────────────────────────────────────────────
async function handleGetAsset(request: Request, env: Env): Promise<Response> {
  const url  = new URL(request.url);
  const hash = url.pathname.split("/").pop();

  if (!hash) {
    return new Response("Hash missing", { status: 400 });
  }

  const object = await env.BUCKET.get(`assets/${hash}`);
  if (!object) {
    return new Response("Asset not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag",          object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("access-control-allow-origin", "*");

  return new Response(object.body, { headers });
}

// ─────────────────────────────────────────────────────────────────────────────
// djb2 hash → 0-99 bucket (deterministic rollout without MD5)
// ─────────────────────────────────────────────────────────────────────────────
function djb2Bucket(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return hash % 100;
}
