import express from "express";
import multer from "multer";
import Database from "better-sqlite3";
import pg from "pg";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { generateExpoManifest, createExpoHeaders, verifyPayload } from "@renbostudios/edge-ota-core";

// Conduit Mail Service Configuration
const CONDUIT_API_BASE = process.env.CONDUIT_API_BASE || "https://api.conduit.renbo.site";
const CONDUIT_API_KEY = process.env.CONDUIT_API_KEY || "";
const CONDUIT_CHANNEL_ID = process.env.CONDUIT_CHANNEL_ID || "bceb1d1b-8a03-4f56-a68f-2e1f91e613d0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_DIR = path.resolve(__dirname, "../uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Database Connection & Engine Setup
const DATABASE_URL = process.env.DATABASE_URL || "";
const isPostgres = DATABASE_URL.startsWith("postgres://") || DATABASE_URL.startsWith("postgresql://");

let pgPool: pg.Pool | null = null;
let sqliteDb: Database.Database | null = null;
let usePostgres = isPostgres;

if (isPostgres) {
  const host = new URL(DATABASE_URL).host;
  console.log(`[Database] Connecting to Postgres host: ${host} (Treating as PRODUCTION/LIVE)`);
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: DATABASE_URL.includes("sslmode=require") ? { rejectUnauthorized: false } : false
  });

  try {
    // Test connection on startup
    const client = await pool.connect();
    client.release();
    pgPool = pool;
  } catch (err: any) {
    console.warn(`[Database] Postgres connection failed: ${err.message}`);
    console.warn(`[Database] Falling back to local SQLite database (updates.db)`);
    await pool.end().catch(() => {});
    sqliteDb = new Database(path.resolve(__dirname, "../updates.db"));
    usePostgres = false;
  }
} else {
  console.log(`[Database] Connecting to local SQLite database (updates.db)`);
  sqliteDb = new Database(path.resolve(__dirname, "../updates.db"));
}

async function queryOne(sql: string, params: any[] = []): Promise<any> {
  if (usePostgres) {
    let index = 1;
    const pgSql = sql.replace(/\?/g, () => `$${index++}`);
    const res = await pgPool!.query(pgSql, params);
    return res.rows[0];
  } else {
    return sqliteDb!.prepare(sql).get(...params);
  }
}

async function queryAll(sql: string, params: any[] = []): Promise<any[]> {
  if (usePostgres) {
    let index = 1;
    const pgSql = sql.replace(/\?/g, () => `$${index++}`);
    const res = await pgPool!.query(pgSql, params);
    return res.rows;
  } else {
    return sqliteDb!.prepare(sql).all(...params) as any[];
  }
}

async function runCommand(sql: string, params: any[] = []): Promise<void> {
  if (usePostgres) {
    let index = 1;
    const pgSql = sql.replace(/\?/g, () => `$${index++}`);
    await pgPool!.query(pgSql, params);
  } else {
    sqliteDb!.prepare(sql).run(...params);
  }
}

async function execBatch(sql: string): Promise<void> {
  if (usePostgres) {
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      try {
        await pgPool!.query(stmt);
      } catch (err: any) {
        console.warn(`[Database] Statement failed (non-fatal): ${err.message}`);
      }
    }
  } else {
    sqliteDb!.exec(sql);
  }
}

// Create Schema Tables
await execBatch(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS updates (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    created_at TEXT NOT NULL,
    runtime_version TEXT NOT NULL,
    channel TEXT NOT NULL,
    bundle_hash TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'all',
    metadata TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_updates_runtime_channel ON updates (project_id, runtime_version, channel, created_at DESC);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_logs (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    created_at TEXT NOT NULL,
    runtime_version TEXT NOT NULL,
    channel TEXT NOT NULL,
    platform TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default-project',
    env TEXT NOT NULL,
    status TEXT NOT NULL,
    rollout INTEGER NOT NULL DEFAULT 100,
    runtime TEXT NOT NULL DEFAULT '',
    active_release_id TEXT,
    target_platform TEXT NOT NULL DEFAULT 'all',
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, project_id)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL,
    prefix TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Safe migrations to add columns to sync_logs and updates/channels
try {
  await runCommand("ALTER TABLE sync_logs ADD COLUMN ip TEXT");
} catch (e) {
  // Ignored if column already exists
}
try {
  await runCommand("ALTER TABLE sync_logs ADD COLUMN status TEXT");
} catch (e) {
  // Ignored if column already exists
}
try {
  await runCommand("ALTER TABLE sync_logs ADD COLUMN update_id TEXT");
} catch (e) {
  // Ignored if column already exists
}
try {
  await runCommand("ALTER TABLE updates ADD COLUMN project_id TEXT");
} catch (e) {}
try {
  await runCommand("ALTER TABLE updates ADD COLUMN platform TEXT DEFAULT 'all'");
} catch (e) {}
try {
  await runCommand("ALTER TABLE channels ADD COLUMN project_id TEXT DEFAULT 'default-project'");
} catch (e) {}
try {
  await runCommand("ALTER TABLE sync_logs ADD COLUMN project_id TEXT");
} catch (e) {}

// OTP email verification migrations
try {
  await runCommand("ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0");
} catch (e) {}

await execBatch(`
  CREATE TABLE IF NOT EXISTS otps (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'developer',
    status TEXT NOT NULL DEFAULT 'pending',
    invite_token TEXT,
    invited_at TEXT NOT NULL,
    accepted_at TEXT
  );
`);

// Safe migration to upgrade SQLite channels table to composite primary key (id, project_id)
if (!usePostgres) {
  try {
    const tableInfo = await queryAll("PRAGMA table_info(channels)");
    const pkColumns = tableInfo.filter(c => c.pk > 0);
    if (pkColumns.length === 1 && pkColumns[0].name === "id") {
      console.log("[Migration] Upgrading SQLite 'channels' table to composite primary key (id, project_id)...");
      await runCommand("ALTER TABLE channels RENAME TO channels_old");
      await runCommand(`
        CREATE TABLE channels (
          id TEXT NOT NULL,
          project_id TEXT NOT NULL DEFAULT 'default-project',
          env TEXT NOT NULL,
          status TEXT NOT NULL,
          rollout INTEGER NOT NULL DEFAULT 100,
          runtime TEXT NOT NULL DEFAULT '',
          active_release_id TEXT,
          target_platform TEXT NOT NULL DEFAULT 'all',
          created_at TEXT NOT NULL,
          PRIMARY KEY (id, project_id)
        )
      `);
      await runCommand(`
        INSERT INTO channels (id, project_id, env, status, rollout, runtime, active_release_id, target_platform, created_at)
        SELECT id, COALESCE(project_id, 'default-project'), env, status, rollout, runtime, active_release_id, target_platform, created_at
        FROM channels_old
      `);
      await runCommand("DROP TABLE channels_old");
      console.log("[Migration] Upgrading SQLite 'channels' table completed successfully.");
    }
  } catch (err) {
    console.error("[Migration] SQLite channels table composite PK migration failed:", err);
  }
}

// Add performance indexes
try {
  await execBatch(`
    CREATE INDEX IF NOT EXISTS idx_sync_logs_project_created ON sync_logs (project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_api_keys_secret_hash ON api_keys (secret_hash);
    CREATE INDEX IF NOT EXISTS idx_team_members_project_email ON team_members (project_id, email);
    CREATE INDEX IF NOT EXISTS idx_updates_proj_chan_plat ON updates (project_id, channel, platform, created_at DESC);
  `);
} catch (e: any) {
  console.warn("[Database] Index creation warning:", e.message);
}

// Secure password hashing using scrypt with random salt
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  // Handle legacy unsalted SHA-256 hashes
  if (stored.length === 64 && !stored.includes(":")) {
    const computed = crypto.createHash("sha256").update(password).digest("hex");
    const storedBuf = Buffer.from(stored, "hex");
    const computedBuf = Buffer.from(computed, "hex");
    if (storedBuf.length !== computedBuf.length) return false;
    return crypto.timingSafeEqual(storedBuf, computedBuf);
  }
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const computed = crypto.scryptSync(password, salt, 64).toString("hex");
  const storedBuf = Buffer.from(hash, "hex");
  const computedBuf = Buffer.from(computed, "hex");
  if (storedBuf.length !== computedBuf.length) return false;
  return crypto.timingSafeEqual(storedBuf, computedBuf);
}

// OTP Generation & Conduit Email Functions
function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

async function storeOtp(email: string, code: string): Promise<void> {
  // Delete any existing OTPs for this email
  await runCommand("DELETE FROM otps WHERE email = ?", [email]);
  const otpId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // 10 minutes
  await runCommand(
    "INSERT INTO otps (id, email, code, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    [otpId, email, code, expiresAt, now.toISOString()]
  );
}

async function verifyOtp(email: string, code: string): Promise<boolean> {
  const otp = await queryOne(
    "SELECT * FROM otps WHERE email = ? AND code = ?",
    [email, code]
  );
  if (!otp) return false;
  const expiresAt = new Date(otp.expires_at).getTime();
  if (Date.now() > expiresAt) {
    await runCommand("DELETE FROM otps WHERE id = ?", [otp.id]);
    return false;
  }
  // OTP valid — delete it (single-use)
  await runCommand("DELETE FROM otps WHERE id = ?", [otp.id]);
  return true;
}

async function sendOtpEmail(email: string, code: string): Promise<boolean> {
  if (!CONDUIT_API_KEY) {
    console.warn("[OTP] No CONDUIT_API_KEY configured — skipping email send");
    return false;
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#000000;font-family:'Courier New',Courier,monospace;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#000000;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background-color:#0A0A0A;border:1px solid #333333;">
          <!-- Header -->
          <tr>
            <td style="padding:32px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:'Courier New',Courier,monospace;font-size:14px;color:#FFFFFF;font-weight:bold;letter-spacing:1px;">
                    &#9618; Edge-OTA
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:16px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-top:1px solid #333333;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Title -->
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#555555;text-transform:uppercase;letter-spacing:2px;">
                    EMAIL VERIFICATION
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Message -->
          <tr>
            <td style="padding:16px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:'Courier New',Courier,monospace;font-size:13px;color:#FFFFFF;line-height:20px;">
                    A verification code was requested for your account.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- OTP Code Box -->
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background-color:#000000;border:1px solid #333333;padding:20px 24px;text-align:center;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#555555;text-transform:uppercase;letter-spacing:2px;text-align:center;padding-bottom:12px;">
                          YOUR CODE
                        </td>
                      </tr>
                      <tr>
                        <td style="font-family:'Courier New',Courier,monospace;font-size:32px;color:#FFFFFF;letter-spacing:8px;text-align:center;font-weight:bold;">
                          ${code}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Expiry Note -->
          <tr>
            <td style="padding:16px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:'Courier New',Courier,monospace;font-size:11px;color:#555555;line-height:18px;">
                    This code expires in 10 minutes.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-top:1px solid #333333;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px 32px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#555555;line-height:16px;">
                    If you did not request this, you can safely ignore this email.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const response = await fetch(`${CONDUIT_API_BASE}/api/v1/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CONDUIT_API_KEY}`,
      },
      body: JSON.stringify({
        to: email,
        channel: "email",
        subject: "Verify your email — Edge-OTA",
        message: html,
        sessionId: CONDUIT_CHANNEL_ID,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[OTP] Conduit API error: ${response.status} — ${text}`);
      return false;
    }
    console.log(`[OTP] Verification email sent to ${email}`);
    return true;
  } catch (err: any) {
    console.error(`[OTP] Failed to send email: ${err.message}`);
    return false;
  }
}

async function sendInviteEmail(email: string, inviterEmail: string, projectName: string, inviteToken: string): Promise<boolean> {
  if (!CONDUIT_API_KEY) {
    console.warn("[Invite] No CONDUIT_API_KEY configured — skipping invite email send");
    return false;
  }

  const acceptUrl = `${process.env.DASHBOARD_URL || "https://ota.renbo.site"}/team/accept?token=${inviteToken}`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#000000;font-family:'Courier New',Courier,monospace;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#000000;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background-color:#0A0A0A;border:1px solid #333333;">
          <tr>
            <td style="padding:32px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:'Courier New',Courier,monospace;font-size:14px;color:#FFFFFF;font-weight:bold;letter-spacing:1px;">
                    &#9618; Edge-OTA
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td style="border-top:1px solid #333333;font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#555555;text-transform:uppercase;letter-spacing:2px;">
                    TEAM INVITATION
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:'Courier New',Courier,monospace;font-size:13px;color:#FFFFFF;line-height:20px;">
                    <strong style="color:#81C784;">${inviterEmail}</strong> has invited you to join the project <strong style="color:#FFAA00;">${projectName}</strong> on Edge-OTA.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="background-color:#81C784;padding:14px 24px;">
                    <a href="${acceptUrl}" style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#000000;text-decoration:none;font-weight:bold;letter-spacing:1px;display:block;">
                      ACCEPT INVITATION
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:'Courier New',Courier,monospace;font-size:11px;color:#555555;line-height:18px;">
                    Or copy this link: <span style="color:#81C784;word-break:break-all;">${acceptUrl}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td style="border-top:1px solid #333333;font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 32px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#555555;line-height:16px;">
                    This invitation expires in 7 days. If you did not expect this, you can safely ignore this email.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const response = await fetch(`${CONDUIT_API_BASE}/api/v1/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CONDUIT_API_KEY}`,
      },
      body: JSON.stringify({
        to: email,
        channel: "email",
        subject: `You're invited to ${projectName} — Edge-OTA`,
        message: html,
        sessionId: CONDUIT_CHANNEL_ID,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[Invite] Conduit API error: ${response.status} — ${text}`);
      return false;
    }
    console.log(`[Invite] Invitation email sent to ${email}`);
    return true;
  } catch (err: any) {
    console.error(`[Invite] Failed to send email: ${err.message}`);
    return false;
  }
}

// Simple in-memory rate limiter
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, maxAttempts: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxAttempts) return false;
  entry.count++;
  return true;
}

// Periodic cleanup to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(key);
  }
}, 60_000);

function isValidEmail(email: string): boolean {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// Seed admin user — always mark as verified so admin can log in
const adminEmail = process.env.ADMIN_EMAIL || "admin@edge-ota.local";
const adminPassword = process.env.ADMIN_PASSWORD || "password123";
const adminPasswordHash = hashPassword(adminPassword);

let adminUserId = crypto.randomUUID();
const existingUser = await queryOne("SELECT * FROM users WHERE email = ?", [adminEmail]);
if (!existingUser) {
  await runCommand("INSERT INTO users (id, email, password_hash, email_verified) VALUES (?, ?, ?, 1)", [adminUserId, adminEmail, adminPasswordHash]);
  console.log(`[Seed] Created default user: ${adminEmail} / ${adminPassword}`);
} else {
  adminUserId = existingUser.id;
  await runCommand("UPDATE users SET password_hash = ?, email_verified = 1 WHERE email = ?", [adminPasswordHash, adminEmail]);
  // Invalidate all existing sessions for the admin user to prevent stale token abuse
  await runCommand("DELETE FROM sessions WHERE user_id = ?", [adminUserId]);
}

// Seed default project if empty
const defaultProjectId = "default-project";
const existingDefaultProject = await queryOne("SELECT id FROM projects WHERE id = ?", [defaultProjectId]);
const PUBLIC_KEY = process.env.PUBLIC_KEY || "";
if (!existingDefaultProject) {
  await runCommand(
    "INSERT INTO projects (id, user_id, name, public_key, created_at) VALUES (?, ?, ?, ?, ?)",
    [defaultProjectId, adminUserId, "Default Project", PUBLIC_KEY, new Date().toISOString()]
  );
  console.log(`[Seed] Created default project: ${defaultProjectId}`);
}

// Migrate existing null/empty project_ids to default-project
await runCommand("UPDATE updates SET project_id = ? WHERE project_id IS NULL OR project_id = ''", [defaultProjectId]);
await runCommand("UPDATE channels SET project_id = ? WHERE project_id IS NULL OR project_id = ''", [defaultProjectId]);
await runCommand("UPDATE sync_logs SET project_id = ? WHERE project_id IS NULL OR project_id = ''", [defaultProjectId]);

// Seed default channels if empty
const channelsCountRow = await queryOne("SELECT COUNT(*) as count FROM channels");
const channelsCount = channelsCountRow ? parseInt(channelsCountRow.count) : 0;
if (channelsCount === 0) {
  console.log("[Seed] Seeding default channels...");
  const now = new Date().toISOString();
  await runCommand(
    "INSERT INTO channels (id, project_id, env, status, rollout, runtime, active_release_id, target_platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["production", defaultProjectId, "Production", "Active", 100, "3.2.0", "", "all", now]
  );
  await runCommand(
    "INSERT INTO channels (id, project_id, env, status, rollout, runtime, active_release_id, target_platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["staging", defaultProjectId, "Staging", "Active", 100, "3.2.0", "", "all", now]
  );
  await runCommand(
    "INSERT INTO channels (id, project_id, env, status, rollout, runtime, active_release_id, target_platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["experimental", defaultProjectId, "Staging", "Testing", 10, "3.1.0", "", "all", now]
  );
  console.log("[Seed] Completed channels seeding.");
}

// Seed default key if empty
const keysCountRow = await queryOne("SELECT COUNT(*) as count FROM api_keys");
const keysCount = keysCountRow ? parseInt(keysCountRow.count) : 0;
if (keysCount === 0) {
  console.log("[Seed] Seeding default API deploy key...");
  const keyId = crypto.randomUUID();
  const token = "eota_prod_" + crypto.randomBytes(16).toString("hex");
  const secretHash = crypto.createHash("sha256").update(token).digest("hex");
  await runCommand(
    "INSERT INTO api_keys (id, user_id, label, prefix, secret_hash, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [keyId, adminUserId, "Primary CLI Token", token.substring(0, 14) + "...", secretHash, "push_updates", new Date().toISOString()]
  );
  console.log("[Seed] Completed API key seeding.");
}

// Seed analytics sync logs if empty
const syncLogsCountRow = await queryOne("SELECT COUNT(*) as count FROM sync_logs");
const logsCount = syncLogsCountRow ? parseInt(syncLogsCountRow.count) : 0;
if (logsCount === 0) {
  console.log("[Seed] Populating historical sync logs for analytics...");
  const platforms = ["ios", "android"];
  const channelsList = ["production", "staging", "experimental"];
  const runtimes = ["3.2.0", "3.1.0", "3.0.0"];
  
  for (let i = 0; i < 168; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dayOfWeek = date.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    
    let numSyncs = 0;
    const random = Math.random();
    if (isWeekend) {
      if (random > 0.85) numSyncs = Math.floor(Math.random() * 3) + 1;
    } else {
      if (random > 0.4) {
        numSyncs = Math.floor(Math.random() * 8) + 1;
        if (random > 0.9) numSyncs += Math.floor(Math.random() * 6);
      }
    }
    
    for (let s = 0; s < numSyncs; s++) {
      const logId = crypto.randomUUID();
      const logDate = new Date(date);
      logDate.setHours(Math.floor(Math.random() * 24));
      logDate.setMinutes(Math.floor(Math.random() * 60));
      logDate.setSeconds(Math.floor(Math.random() * 60));
      
      const randomIp = `${Math.floor(Math.random() * 200) + 10}.${Math.floor(Math.random() * 200) + 10}.${Math.floor(Math.random() * 200) + 10}.${Math.floor(Math.random() * 200) + 10}`;
      const randomStatus = Math.random() > 0.05 ? "Success" : "Bypassed (Mismatch)";

      await runCommand(
        "INSERT INTO sync_logs (id, created_at, runtime_version, channel, platform, ip, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          logId,
          logDate.toISOString(),
          runtimes[Math.floor(Math.random() * runtimes.length)],
          channelsList[Math.floor(Math.random() * channelsList.length)],
          platforms[Math.floor(Math.random() * platforms.length)],
          randomIp,
          randomStatus
        ]
      );
    }
  }
  console.log("[Seed] Completed historical sync logs seeding.");
}

const app = express();
app.use(express.json());

// CORS config middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : [];
  
  if (
    origin && (
      origin.startsWith("http://localhost:") ||
      origin.startsWith("http://127.0.0.1:") ||
      origin.endsWith(".renbo.site") ||
      origin === "https://renbo.site" ||
      allowedOrigins.includes(origin)
    )
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, expo-platform, expo-runtime-version, expo-channel-name, x-project-id");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

const upload = multer({ dest: UPLOADS_DIR });

// Middleware to authenticate sessions
async function authenticateSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).send("Unauthorized: Missing or invalid token format");
    return;
  }

  const token = authHeader.substring(7);
  try {
    // API keys are a separate trust chain — they skip email_verified check
    if (token.startsWith("eota_prod_")) {
      const secretHash = crypto.createHash("sha256").update(token).digest("hex");
      const keyRow = await queryOne("SELECT * FROM api_keys WHERE secret_hash = ?", [secretHash]);
      if (!keyRow) {
        res.status(401).send("Unauthorized: Invalid deploy key");
        return;
      }
      (req as any).user = { id: keyRow.user_id };
      return next();
    }

    const session = await queryOne("SELECT * FROM sessions WHERE token = ?", [token]);
    if (!session) {
      res.status(401).send("Unauthorized: Invalid session");
      return;
    }

    const expiresAt = new Date(session.expires_at).getTime();
    if (Date.now() > expiresAt) {
      await runCommand("DELETE FROM sessions WHERE token = ?", [token]);
      res.status(401).send("Unauthorized: Session expired");
      return;
    }

    // Verify the user's email is verified
    const user = await queryOne("SELECT email_verified FROM users WHERE id = ?", [session.user_id]);
    if (!user || user.email_verified === 0) {
      res.status(403).json({ error: "Email not verified", requiresVerification: true });
      return;
    }

    (req as any).user = { id: session.user_id };
    next();
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
}

// Helper to validate and fetch correct projectId for authenticated sessions (owner or team member)
async function getValidatedProjectId(req: express.Request): Promise<string> {
  const projectIdHeader = (req.headers["x-project-id"] as string) || (req.query.projectId as string);
  const userId = (req as any).user?.id;
  
  if (projectIdHeader) {
    const user = await queryOne("SELECT email FROM users WHERE id = ?", [userId]);
    const userEmail = user?.email || "";
    const proj = await queryOne(
      `SELECT p.id FROM projects p 
       LEFT JOIN team_members tm ON tm.project_id = p.id 
       WHERE p.id = ? AND (p.user_id = ? OR (tm.email = ? AND tm.status = 'accepted'))
       LIMIT 1`,
      [projectIdHeader, userId, userEmail]
    );
    if (proj) {
      return proj.id;
    }
  }
  
  const user = await queryOne("SELECT email FROM users WHERE id = ?", [userId]);
  const userEmail = user?.email || "";
  const firstProj = await queryOne(
    `SELECT p.id FROM projects p 
     LEFT JOIN team_members tm ON tm.project_id = p.id 
     WHERE p.user_id = ? OR (tm.email = ? AND tm.status = 'accepted')
     ORDER BY p.created_at ASC LIMIT 1`,
    [userId, userEmail]
  );
  if (firstProj) {
    return firstProj.id;
  }
  
  return "00000000-0000-0000-0000-000000000000";
}

// Session TTL: 90 days
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// Authentication API Endpoints
app.post("/api/auth/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).send("Email and password are required");
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).send("Invalid email format");
    return;
  }

  if (typeof password !== "string" || password.length < 8) {
    res.status(400).send("Password must be at least 8 characters");
    return;
  }

  // Rate limit: 5 signups per IP per 10 minutes
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(`signup:${ip}`, 5, 10 * 60 * 1000)) {
    res.status(429).send("Too many signup attempts. Please try again later.");
    return;
  }

  try {
    const existingUser = await queryOne("SELECT * FROM users WHERE email = ?", [email]);
    if (existingUser) {
      res.status(400).send("Email is already registered");
      return;
    }

    const userId = crypto.randomUUID();
    const passwordHash = hashPassword(password);
    await runCommand("INSERT INTO users (id, email, password_hash, email_verified) VALUES (?, ?, ?, 0)", [userId, email, passwordHash]);

    // Generate and send OTP
    const otpCode = generateOtp();
    await storeOtp(email, otpCode);
    const sent = await sendOtpEmail(email, otpCode);

    if (!sent) {
      console.warn(`[Auth] OTP email failed to send for ${email} — continuing anyway (check server logs)`);
    }

    res.json({ message: "Verification code sent to your email", email, requiresVerification: true });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).send("Email and password are required");
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).send("Invalid email format");
    return;
  }

  // Rate limit: 10 login attempts per IP per 10 minutes
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(`login:${ip}`, 10, 10 * 60 * 1000)) {
    res.status(429).send("Too many login attempts. Please try again later.");
    return;
  }

  // Per-email rate limit: 5 failed attempts per 10 minutes
  if (!checkRateLimit(`login:${email}`, 5, 10 * 60 * 1000)) {
    res.status(429).send("Too many login attempts for this email. Please try again later.");
    return;
  }

  try {
    const user = await queryOne("SELECT * FROM users WHERE email = ?", [email]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).send("Invalid credentials");
      return;
    }

    // Check if email is verified
    if (user.email_verified === 0) {
      // Rate limit OTP resends: 1 per email per 2 minutes
      if (!checkRateLimit(`otp:${email}`, 1, 2 * 60 * 1000)) {
        res.status(403).json({ error: "Email not verified", requiresVerification: true, email, otpSent: false });
        return;
      }
      const otpCode = generateOtp();
      await storeOtp(email, otpCode);
      await sendOtpEmail(email, otpCode);
      res.status(403).json({ error: "Email not verified", requiresVerification: true, email, otpSent: true });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    await runCommand("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [token, user.id, new Date().toISOString(), expiresAt]);

    res.json({ token, email: user.email });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    await runCommand("DELETE FROM sessions WHERE token = ?", [token]);
  }
  res.status(200).send("Logged out");
});

app.post("/api/auth/verify-otp", async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    res.status(400).send("Email and verification code are required");
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).send("Invalid email format");
    return;
  }

  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    res.status(400).send("Invalid verification code format");
    return;
  }

  // Rate limit: 10 verify attempts per email per 10 minutes
  if (!checkRateLimit(`verify:${email}`, 10, 10 * 60 * 1000)) {
    res.status(429).send("Too many verification attempts. Please request a new code.");
    return;
  }

  try {
    const valid = await verifyOtp(email, code);
    if (!valid) {
      res.status(400).send("Invalid or expired verification code");
      return;
    }

    // Mark email as verified
    await runCommand("UPDATE users SET email_verified = 1 WHERE email = ?", [email]);

    // Issue session token
    const user = await queryOne("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      res.status(404).send("User not found");
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await runCommand("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [token, user.id, new Date().toISOString(), expiresAt]);

    res.json({ token, email: user.email, verified: true });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/auth/resend-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).send("Email is required");
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).send("Invalid email format");
    return;
  }

  // Rate limit: 1 resend per email per 2 minutes
  if (!checkRateLimit(`otp:${email}`, 1, 2 * 60 * 1000)) {
    res.status(429).send("Please wait before requesting a new code.");
    return;
  }

  try {
    const user = await queryOne("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      res.status(404).send("No account found with this email");
      return;
    }
    if (user.email_verified === 1) {
      res.status(400).send("Email is already verified");
      return;
    }

    const otpCode = generateOtp();
    await storeOtp(email, otpCode);
    const sent = await sendOtpEmail(email, otpCode);

    if (!sent) {
      res.status(500).send("Failed to send verification email");
      return;
    }

    res.json({ message: "Verification code resent" });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.get("/api/auth/me", authenticateSession, async (req, res) => {
  try {
    const user = await queryOne("SELECT email, email_verified FROM users WHERE id = ?", [(req as any).user.id]);
    if (!user) {
      res.status(404).send("User not found");
      return;
    }
    res.json({ email: user.email, emailVerified: user.email_verified === 1 });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

// Projects API Endpoints
app.get("/api/projects", authenticateSession, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const projects = await queryAll(
      "SELECT id, name, public_key, created_at FROM projects WHERE user_id = ? ORDER BY created_at DESC",
      [userId]
    );
    res.json(projects);
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/projects", authenticateSession, async (req, res) => {
  const { name, publicKey } = req.body;
  if (!name) {
    res.status(400).send("Project name is required");
    return;
  }

  try {
    const projectId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await runCommand(
      "INSERT INTO projects (id, user_id, name, public_key, created_at) VALUES (?, ?, ?, ?, ?)",
      [projectId, (req as any).user.id, name, publicKey || "", createdAt]
    );
    res.status(201).json({ id: projectId, name, publicKey: publicKey || "", created_at: createdAt });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.put("/api/projects/:id", authenticateSession, async (req, res) => {
  const { id } = req.params;
  const { name, publicKey } = req.body;
  if (!name) {
    res.status(400).send("Project name is required");
    return;
  }

  try {
    const existing = await queryOne("SELECT id FROM projects WHERE id = ? AND user_id = ?", [id, (req as any).user.id]);
    if (!existing) {
      res.status(404).send("Project not found or unauthorized");
      return;
    }

    await runCommand(
      "UPDATE projects SET name = ?, public_key = ? WHERE id = ?",
      [name, publicKey || "", id]
    );
    res.json({ message: "Project updated successfully" });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

// Releases API Endpoints
app.get("/api/releases", authenticateSession, async (req, res) => {
  const projectId = await getValidatedProjectId(req);
  try {
    const rows = await queryAll("SELECT * FROM updates WHERE project_id = ? ORDER BY created_at DESC", [projectId]);
    
    const releases = await Promise.all(rows.map(async (row) => {
      const latestActive = await queryOne(
        "SELECT id FROM updates WHERE runtime_version = ? AND channel = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1",
        [row.runtime_version, row.channel, projectId]
      );
      
      const isActive = latestActive && latestActive.id === row.id;
 
      let metadataInfo = { deployedBy: "CLI" };
      try {
        metadataInfo = JSON.parse(row.metadata);
      } catch (e) {}
 
      return {
        id: row.id,
        runtime: row.runtime_version,
        size: "3.42 MB",
        env: row.channel === "production" ? "Production" : row.channel === "staging" ? "Staging" : "Development",
        published: new Date(row.created_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }),
        channel: row.channel,
        publisher: (metadataInfo as any).deployedBy || "Developer",
        egress: "0 GB",
        status: isActive ? "Active" : "Inactive"
      };
    }));
 
    res.json(releases);
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});
 
app.post("/api/releases/:id/rollback", authenticateSession, async (req, res) => {
  const { id } = req.params;
  const projectId = await getValidatedProjectId(req);
  try {
    const target = await queryOne("SELECT * FROM updates WHERE id = ? AND project_id = ?", [id, projectId]);
    if (!target) {
      res.status(404).send("Release not found");
      return;
    }
 
    const nextId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const targetMetadata = typeof target.metadata === "string" ? JSON.parse(target.metadata || "{}") : (target.metadata || {});

    await runCommand(
      "INSERT INTO updates (id, project_id, created_at, runtime_version, channel, bundle_hash, platform, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        nextId,
        projectId,
        createdAt,
        target.runtime_version,
        target.channel,
        target.bundle_hash,
        target.platform || "all",
        JSON.stringify({
          deployedBy: "Console Rollback",
          rolledBackFrom: id,
          platform: target.platform || "all",
          assets: targetMetadata.assets || []
        })
      ]
    );

    await runCommand(
      "UPDATE channels SET active_release_id = ? WHERE id = ? AND project_id = ?",
      [nextId, target.channel, projectId]
    );

    res.json({ id: nextId, status: "success" });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});
 
app.get("/api/analytics/dashboard", authenticateSession, async (req, res) => {
  const projectId = await getValidatedProjectId(req);
  try {
    const totalSyncsRow = await queryOne("SELECT COUNT(*) as count FROM sync_logs WHERE project_id = ?", [projectId]);
    const updatesServed = totalSyncsRow ? parseInt(totalSyncsRow.count) : 0;
    
    const activeUpdates = await queryAll("SELECT DISTINCT runtime_version, channel FROM updates WHERE project_id = ?", [projectId]);
    const activeRollouts = activeUpdates.length;
    
    const egressSavedGb = ((updatesServed * 3.42) / 1024).toFixed(1);
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 168);
    const logs = await queryAll(
      "SELECT created_at FROM sync_logs WHERE project_id = ? AND created_at >= ? ORDER BY created_at ASC",
      [projectId, cutoffDate.toISOString()]
    );
    
    res.json({
      updatesServed,
      activeRollouts,
      egressSavedGb,
      syncLogs: logs.map(l => l.created_at)
    });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

// Channels API Endpoints
app.get("/api/channels", authenticateSession, async (req, res) => {
  const projectId = await getValidatedProjectId(req);
  try {
    const channels = await queryAll("SELECT * FROM channels WHERE project_id = ? ORDER BY id ASC", [projectId]);
    const result = await Promise.all(channels.map(async (c) => {
      // Count syncs to compute egress usage
      const syncsCountRow = await queryOne("SELECT COUNT(*) as count FROM sync_logs WHERE channel = ? AND project_id = ?", [c.id, projectId]);
      const syncsCount = syncsCountRow ? parseInt(syncsCountRow.count) : 0;
      const bandwidthGb = ((syncsCount * 3.42) / 1024);
      const bandwidthStr = bandwidthGb >= 1.0 ? `${bandwidthGb.toFixed(1)} GB` : `${(bandwidthGb * 1024).toFixed(0)} MB`;
      
      // Find active release ID
      let activeRelease = c.active_release_id;
      if (!activeRelease) {
        const latestUpdate = await queryOne("SELECT id FROM updates WHERE channel = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1", [c.id, projectId]);
        activeRelease = latestUpdate ? latestUpdate.id : "None";
      }

      // Runtime constraint
      let runtime = c.runtime;
      if (!runtime) {
        const latestUpdate = await queryOne("SELECT runtime_version FROM updates WHERE channel = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1", [c.id, projectId]);
        runtime = latestUpdate ? latestUpdate.runtime_version : "3.2.0";
      }

      return {
        id: c.id,
        env: c.env,
        rollout: c.rollout,
        status: c.status,
        activeRelease,
        runtime,
        bandwidth: bandwidthStr
      };
    }));
    res.json(result);
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/channels", authenticateSession, async (req, res) => {
  const { id, env } = req.body;
  const projectId = await getValidatedProjectId(req);
  if (!id || !env) {
    res.status(400).send("Channel ID and environment type are required");
    return;
  }

  const channelId = id.toLowerCase().replace(/\s+/g, "-");

  try {
    const existing = await queryOne("SELECT id FROM channels WHERE id = ? AND project_id = ?", [channelId, projectId]);
    if (existing) {
      res.status(400).send("Channel already exists");
      return;
    }

    await runCommand(
      "INSERT INTO channels (id, project_id, env, status, rollout, runtime, active_release_id, target_platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [channelId, projectId, env, "Draft", 100, "", "", "all", new Date().toISOString()]
    );

    res.status(201).json({ id: channelId, env, status: "Draft", rollout: 100 });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.get("/api/channels/:id", authenticateSession, async (req, res) => {
  const { id } = req.params;
  const projectId = await getValidatedProjectId(req);
  try {
    const channel = await queryOne("SELECT * FROM channels WHERE id = ? AND project_id = ?", [id, projectId]);
    if (!channel) {
      res.status(404).send("Channel not found");
      return;
    }
    res.json(channel);
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.put("/api/channels/:id", authenticateSession, async (req, res) => {
  const { id } = req.params;
  const { rollout, runtime, active_release_id, target_platform, status, env } = req.body;
  const projectId = await getValidatedProjectId(req);

  try {
    const channel = await queryOne("SELECT id FROM channels WHERE id = ? AND project_id = ?", [id, projectId]);
    if (!channel) {
      res.status(404).send("Channel not found");
      return;
    }

    await runCommand(
      "UPDATE channels SET rollout = ?, runtime = ?, active_release_id = ?, target_platform = ?, status = ?, env = ? WHERE id = ? AND project_id = ?",
      [
        rollout !== undefined ? rollout : 100,
        runtime !== undefined ? runtime : "",
        active_release_id !== undefined ? active_release_id : "",
        target_platform !== undefined ? target_platform : "all",
        status !== undefined ? status : "Active",
        env !== undefined ? env : "Production",
        id,
        projectId
      ]
    );

    res.json({ message: "Channel updated successfully" });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

// Devices API Endpoint
app.get("/api/devices", authenticateSession, async (req, res) => {
  const projectId = await getValidatedProjectId(req);
  try {
    // Recent 50 client logs
    const logs = await queryAll(
      "SELECT * FROM sync_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50",
      [projectId]
    );

    const formattedLogs = logs.map(log => {
      // format date nicely
      let timeStr = new Date(log.created_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "numeric" });
      const diffMs = Date.now() - new Date(log.created_at).getTime();
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 60) {
        timeStr = diffMins <= 0 ? "Just now" : `${diffMins} min${diffMins > 1 ? "s" : ""} ago`;
      } else {
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) {
          timeStr = `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
        } else {
          timeStr = new Date(log.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        }
      }

      return {
        ip: log.ip || "127.0.0.1",
        platform: log.platform === "ios" ? "iOS" : log.platform === "android" ? "Android" : log.platform,
        runtime: log.runtime_version,
        channel: log.channel,
        version: log.update_id ? log.update_id.substring(0, 8) : "None",
        status: log.status && log.status.startsWith("Success") ? "Success" : log.status || "Bypassed",
        time: timeStr
      };
    });

    // Platform distribution counts
    const iosCountRow = await queryOne("SELECT COUNT(*) as count FROM sync_logs WHERE LOWER(platform) = 'ios' AND project_id = ?", [projectId]);
    const androidCountRow = await queryOne("SELECT COUNT(*) as count FROM sync_logs WHERE LOWER(platform) = 'android' AND project_id = ?", [projectId]);
    const platforms = {
      ios: iosCountRow ? parseInt(iosCountRow.count) : 0,
      android: androidCountRow ? parseInt(androidCountRow.count) : 0
    };

    // Runtime versions statistics
    const runtimesRows = await queryAll(
      "SELECT runtime_version, COUNT(*) as count FROM sync_logs WHERE project_id = ? GROUP BY runtime_version ORDER BY count DESC",
      [projectId]
    );
    const totalRuntimesCountRow = await queryOne("SELECT COUNT(*) as count FROM sync_logs WHERE project_id = ?", [projectId]);
    const totalRuntimesCount = totalRuntimesCountRow ? parseInt(totalRuntimesCountRow.count) : 0;

    const runtimes = runtimesRows.map(row => {
      const count = parseInt(row.count);
      const percent = totalRuntimesCount > 0 ? Math.round((count / totalRuntimesCount) * 100) : 0;
      const sdkName = row.runtime_version.startsWith("3.") ? ` (SDK 51)` : row.runtime_version.startsWith("2.") ? ` (SDK 50)` : ` (SDK 49)`;
      return {
        version: `${row.runtime_version}${sdkName}`,
        count,
        percent
      };
    });

    // OTA sync health (success rate)
    const totalSyncs = totalRuntimesCount;
    const successSyncsRow = await queryOne("SELECT COUNT(*) as count FROM sync_logs WHERE status = 'Success' AND project_id = ?", [projectId]);
    const successSyncs = successSyncsRow ? parseInt(successSyncsRow.count) : 0;
    const healthRate = totalSyncs > 0 ? ((successSyncs / totalSyncs) * 100).toFixed(2) + "%" : "100.00%";

    res.json({
      platforms,
      runtimes,
      healthRate,
      clientLog: formattedLogs
    });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

// Keys API Endpoints
app.get("/api/keys", authenticateSession, async (req, res) => {
  try {
    const keys = await queryAll("SELECT id, label, prefix, scope, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC", [(req as any).user.id]);
    res.json(keys);
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/keys", authenticateSession, async (req, res) => {
  const { label, scope } = req.body;
  if (!label) {
    res.status(400).send("Key label is required");
    return;
  }

  try {
    const keyId = crypto.randomUUID();
    const token = "eota_prod_" + crypto.randomBytes(16).toString("hex");
    const secretHash = crypto.createHash("sha256").update(token).digest("hex");
    const prefix = token.substring(0, 14) + "...";
    const createdAt = new Date().toISOString();

    await runCommand(
      "INSERT INTO api_keys (id, user_id, label, prefix, secret_hash, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [keyId, (req as any).user.id, label, prefix, secretHash, scope || "push_updates", createdAt]
    );

    res.status(201).json({
      id: keyId,
      label,
      prefix,
      scope: scope || "push_updates",
      created_at: createdAt,
      key: token
    });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.delete("/api/keys/:id", authenticateSession, async (req, res) => {
  const { id } = req.params;
  try {
    const key = await queryOne("SELECT * FROM api_keys WHERE id = ? AND user_id = ?", [id, (req as any).user.id]);
    if (!key) {
      res.status(404).send("API key not found");
      return;
    }

    await runCommand("DELETE FROM api_keys WHERE id = ?", [id]);
    res.json({ message: "API key revoked successfully" });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

// Team Members API Endpoints
app.get("/api/team/members", authenticateSession, async (req, res) => {
  const projectId = await getValidatedProjectId(req);
  try {
    const members = await queryAll(
      "SELECT id, email, role, status, invited_at, accepted_at FROM team_members WHERE project_id = ? AND owner_user_id = ? ORDER BY invited_at DESC",
      [projectId, (req as any).user.id]
    );
    // Prepend the owner as the first member
    const owner = await queryOne("SELECT email FROM users WHERE id = ?", [(req as any).user.id]);
    const result = [
      { id: "owner", email: owner?.email || "", role: "Owner", status: "Active", invited_at: null, accepted_at: null },
      ...members
    ];
    res.json(result);
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/team/invite", authenticateSession, async (req, res) => {
  const { email, role } = req.body;
  if (!email || !email.includes("@")) {
    res.status(400).send("Valid email address is required");
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).send("Invalid email format");
    return;
  }

  const projectId = await getValidatedProjectId(req);
  const userId = (req as any).user.id;

  // Rate limit: 10 invites per user per hour
  if (!checkRateLimit(`invite:${userId}`, 10, 60 * 60 * 1000)) {
    res.status(429).send("Too many invites. Please try again later.");
    return;
  }

  try {
    // Check if already invited
    const existing = await queryOne(
      "SELECT id FROM team_members WHERE project_id = ? AND email = ? AND status = 'pending'",
      [projectId, email]
    );
    if (existing) {
      res.status(400).send("This email has already been invited");
      return;
    }

    // Check if already an accepted member
    const alreadyMember = await queryOne(
      "SELECT id FROM team_members WHERE project_id = ? AND email = ? AND status = 'accepted'",
      [projectId, email]
    );
    if (alreadyMember) {
      res.status(400).send("This user is already a team member");
      return;
    }

    // Clean up old pending invite for this email if any
    await runCommand(
      "DELETE FROM team_members WHERE project_id = ? AND email = ? AND status = 'pending'",
      [projectId, email]
    );

    const memberId = crypto.randomUUID();
    const inviteToken = crypto.randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    const assignedRole = role === "viewer" ? "viewer" : "developer";

    await runCommand(
      "INSERT INTO team_members (id, project_id, owner_user_id, email, role, status, invite_token, invited_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
      [memberId, projectId, userId, email, assignedRole, inviteToken, now]
    );

    // Get project name and inviter email for the email
    const project = await queryOne("SELECT name FROM projects WHERE id = ?", [projectId]);
    const inviter = await queryOne("SELECT email FROM users WHERE id = ?", [userId]);

    const sent = await sendInviteEmail(email, inviter?.email || "a team member", project?.name || "your project", inviteToken);

    if (!sent) {
      console.warn(`[Invite] Email failed to send to ${email} — invite created but email not delivered`);
    }

    res.status(201).json({ id: memberId, email, role: assignedRole, status: "pending", invited_at: now });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.post("/api/team/accept-invite", async (req, res) => {
  const { token, email, password } = req.body;
  if (!token || !email || !password) {
    res.status(400).send("Token, email, and password are required");
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).send("Invalid email format");
    return;
  }

  if (typeof token !== "string" || token.length !== 64) {
    res.status(400).send("Invalid invitation token");
    return;
  }

  if (typeof password !== "string" || password.length < 8) {
    res.status(400).send("Password must be at least 8 characters");
    return;
  }

  try {
    const invite = await queryOne(
      "SELECT * FROM team_members WHERE invite_token = ? AND email = ? AND status = 'pending'",
      [token, email]
    );
    if (!invite) {
      res.status(404).send("Invalid or expired invitation");
      return;
    }

    // Check if invitation expired (7 days)
    const invitedAt = new Date(invite.invited_at).getTime();
    if (Date.now() > invitedAt + 7 * 24 * 60 * 60 * 1000) {
      await runCommand("DELETE FROM team_members WHERE id = ?", [invite.id]);
      res.status(400).send("This invitation has expired");
      return;
    }

    // Check if user exists, if not create account
    let user = await queryOne("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      const userId = crypto.randomUUID();
      const passwordHash = hashPassword(password);
      await runCommand("INSERT INTO users (id, email, password_hash, email_verified) VALUES (?, ?, ?, 1)", [userId, email, passwordHash]);
      user = { id: userId, email, email_verified: 1 };
    } else {
      // Verify password
      if (!verifyPassword(password, user.password_hash)) {
        res.status(401).send("Invalid password for existing account");
        return;
      }
    }

    // Mark invite as accepted
    await runCommand(
      "UPDATE team_members SET status = 'accepted', accepted_at = ? WHERE id = ?",
      [new Date().toISOString(), invite.id]
    );

    res.json({ message: "Invitation accepted", projectId: invite.project_id });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

app.delete("/api/team/members/:id", authenticateSession, async (req, res) => {
  const { id } = req.params;
  const projectId = await getValidatedProjectId(req);
  const userId = (req as any).user.id;

  try {
    const member = await queryOne(
      "SELECT id FROM team_members WHERE id = ? AND project_id = ? AND owner_user_id = ?",
      [id, projectId, userId]
    );
    if (!member) {
      res.status(404).send("Team member not found or unauthorized");
      return;
    }
    await runCommand("DELETE FROM team_members WHERE id = ?", [id]);
    res.json({ message: "Team member removed" });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

// Infrastructure & Analytics API Endpoint
app.get("/api/analytics", authenticateSession, async (req, res) => {
  try {
    const projectId = await getValidatedProjectId(req);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const mauRow = await queryOne("SELECT COUNT(DISTINCT ip) as count FROM sync_logs WHERE project_id = ? AND created_at >= ?", [projectId, thirtyDaysAgo.toISOString()]);
    const mauCount = mauRow ? parseInt(mauRow.count) : 0;

    const totalRow = await queryOne("SELECT COUNT(*) as count FROM sync_logs WHERE project_id = ?", [projectId]);
    const totalRequests = totalRow ? parseInt(totalRow.count) : 0;

    const bandwidthGb = ((totalRequests * 3.42) / 1024);
    
    let r2EgressSaved = "0 GB";
    if (bandwidthGb >= 1024) {
      r2EgressSaved = `${(bandwidthGb / 1024).toFixed(2)} TB`;
    } else {
      r2EgressSaved = `${bandwidthGb.toFixed(1)} GB`;
    }

    res.json({
      totalRequests: totalRequests.toLocaleString(),
      mauCount,
      bandwidthCount: Math.round(bandwidthGb),
      r2EgressSaved,
      cacheHitRate: totalRequests > 0 ? "98.64%" : "100.00%",
      latencies: {
        p50: "12 ms",
        p90: "24 ms",
        p99: "48 ms"
      }
    });
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

// Expo Updates endpoints
// Expo Updates endpoints
// Trigger CI/CD rebuild - fresh run
const handleGetUpdates = async (req: express.Request, res: express.Response) => {
  const projectId = req.params.projectId || (req.headers["x-project-id"] as string) || (req.query.projectId as string) || "default-project";
  const platform = req.headers["expo-platform"] as string;
  const runtimeVersion = req.headers["expo-runtime-version"] as string;
  const channel = (req.headers["expo-channel-name"] as string) || "production";

  if (!platform || !runtimeVersion) {
    res.status(400).send("Missing Expo headers");
    return;
  }

  const ip = (req.headers["x-forwarded-for"] as string) || req.ip || req.socket.remoteAddress || "127.0.0.1";

  try {
    // 1. Fetch channel configuration
    const channelConfig = await queryOne("SELECT * FROM channels WHERE id = ? AND project_id = ?", [channel, projectId]);

    let status = "Success";
    let updateId: string | null = null;
    let row: any = null;

    if (channelConfig) {
      // Check platform constraint
      if (channelConfig.target_platform !== "all" && channelConfig.target_platform !== platform.toLowerCase()) {
        status = `Bypassed (Platform Mismatch: expected ${channelConfig.target_platform}, got ${platform})`;
      }
      // Runtime constraint check removed to support multiple runtimes per channel
      // Check progressive rollout
      else if (channelConfig.rollout < 100) {
        const clientHash = crypto.createHash("md5").update(ip).digest("hex");
        const clientBucket = parseInt(clientHash.substring(0, 8), 16) % 100;
        if (clientBucket >= channelConfig.rollout) {
          status = `Bypassed (Rollout Blocked: bucket ${clientBucket} >= ${channelConfig.rollout}%)`;
        }
      }

      // If checks passed, select correct update
      if (status === "Success") {
        if (channelConfig.active_release_id) {
          row = await queryOne("SELECT * FROM updates WHERE id = ? AND project_id = ?", [channelConfig.active_release_id, projectId]);
          if (!row || (row.platform !== "all" && row.platform !== platform.toLowerCase()) || row.runtime_version !== runtimeVersion) {
            // Fallback to latest update for this platform and runtime if active release mismatches
            row = await queryOne(
              "SELECT * FROM updates WHERE runtime_version = ? AND channel = ? AND project_id = ? AND (platform = ? OR platform = 'all') ORDER BY created_at DESC LIMIT 1",
              [runtimeVersion, channel, projectId, platform.toLowerCase()]
            );
            if (!row) {
              status = "Bypassed (No Release Available for Platform/Runtime)";
            }
          }
        } else {
          row = await queryOne(
            "SELECT * FROM updates WHERE runtime_version = ? AND channel = ? AND project_id = ? AND (platform = ? OR platform = 'all') ORDER BY created_at DESC LIMIT 1",
            [runtimeVersion, channel, projectId, platform.toLowerCase()]
          );
          if (!row) {
            status = "Bypassed (No Release Available)";
          }
        }
      }
    } else {
      // Default fallback if no channel config
      row = await queryOne(
        "SELECT * FROM updates WHERE runtime_version = ? AND channel = ? AND project_id = ? AND (platform = ? OR platform = 'all') ORDER BY created_at DESC LIMIT 1",
        [runtimeVersion, channel, projectId, platform.toLowerCase()]
      );
      if (!row) {
        status = "Bypassed (No Release Available)";
      }
    }

    // Log the sync request (even if bypassed or failed)
    updateId = row ? row.id : null;
    await runCommand(
      "INSERT INTO sync_logs (id, project_id, created_at, runtime_version, channel, platform, ip, status, update_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), projectId, new Date().toISOString(), runtimeVersion, channel, platform, ip, status, updateId]
    );

    if (status !== "Success" || !row) {
      res.status(404).send(status || "No update available");
      return;
    }


    const protocol = (req.headers["x-forwarded-proto"] as string) || (req.secure ? "https" : "http");
    const parsedMetadata = typeof row.metadata === "string" ? JSON.parse(row.metadata || "{}") : (row.metadata || {});
    const rawAssets = Array.isArray(parsedMetadata.assets) ? parsedMetadata.assets : [];
    const formattedAssets = rawAssets.map((a: any) => {
      const ext = a.fileExtension || (a.key ? path.extname(a.key) : "") || "";
      const cleanKey = path.basename(a.key || a.hash, ext);
      return {
        hash: a.hash,
        key: cleanKey,
        fileExtension: ext,
        contentType: a.contentType || "application/octet-stream",
        url: `${protocol}://${req.get("host")}/api/assets/${a.hash}${ext}`
      };
    });

    const manifest = generateExpoManifest({
      updateId: row.id,
      createdAt: row.created_at,
      runtimeVersion: row.runtime_version,
      bundleUrl: `${protocol}://${req.get("host")}/api/assets/${row.bundle_hash}`,
      bundleHash: row.bundle_hash,
      bundleKey: row.bundle_hash.slice(0, 32),
      assets: formattedAssets,
      metadata: parsedMetadata
    });

    // ── Manifest signing ────────────────────────────────────────────────────
    let manifestSignature: string | undefined;
    const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
    if (PRIVATE_KEY) {
      try {
        const { signPayload } = await import("@renbostudios/edge-ota-core");
        const manifestJson = JSON.stringify(manifest);
        manifestSignature = await signPayload(manifestJson, PRIVATE_KEY);
      } catch (signErr) {
        console.warn("[OTA] Could not sign manifest:", signErr);
      }
    }

    const headers = createExpoHeaders(manifestSignature);

    // Always serve multipart/mixed — this is the format the expo-updates
    // native client expects when expo-protocol-version: 1 is set.
    const { buildMultipartManifestBody } = await import("@renbostudios/edge-ota-core");
    const { body, contentType } = buildMultipartManifestBody(manifest, manifestSignature);
    res.set({
      ...headers,
      "content-type": contentType,
    });
    res.send(body);
  } catch (err) {
    console.error("Updates endpoint error:", err);
    res.status(500).send("Internal Server Error");
  }
};

async function pruneOldReleases(projectId: string, keepLimit = 10): Promise<void> {
  try {
    // 1. Get all active release IDs in channels (never delete these)
    const activeReleases = await queryAll(
      "SELECT active_release_id FROM channels WHERE project_id = ? AND active_release_id IS NOT NULL",
      [projectId]
    );
    const activeIds = new Set(activeReleases.map(r => r.active_release_id));

    // 2. Get all updates grouped by channel and runtime version to find which ones to delete
    const updates = await queryAll(
      "SELECT id, channel, runtime_version FROM updates WHERE project_id = ? ORDER BY created_at DESC",
      [projectId]
    );

    const groups: Record<string, typeof updates> = {};
    for (const u of updates) {
      const key = `${u.channel}:${u.runtime_version}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(u);
    }

    const idsToDelete: string[] = [];

    for (const key in groups) {
      const group = groups[key];
      if (group.length > keepLimit) {
        const toDelete = group.slice(keepLimit);
        for (const u of toDelete) {
          if (!activeIds.has(u.id)) {
            idsToDelete.push(u.id);
          }
        }
      }
    }

    if (idsToDelete.length > 0) {
      for (const id of idsToDelete) {
        await runCommand("DELETE FROM updates WHERE id = ?", [id]);
      }
      console.log(`[GC] Deleted ${idsToDelete.length} stale update database records for project ${projectId}`);
    }

    // 3. Run Filesystem Garbage Collection (GC)
    const referencedHashes = await queryAll("SELECT DISTINCT bundle_hash FROM updates");
    const activeHashes = new Set(referencedHashes.map(r => r.bundle_hash));

    // Crucial: also retain all referenced static assets from updates metadata
    const allUpdates = await queryAll("SELECT metadata FROM updates");
    for (const row of allUpdates) {
      if (row.metadata) {
        try {
          const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
          if (Array.isArray(meta.assets)) {
            for (const a of meta.assets) {
              if (a && a.hash) activeHashes.add(a.hash);
            }
          }
        } catch {}
      }
    }

    if (fs.existsSync(UPLOADS_DIR)) {
      const files = fs.readdirSync(UPLOADS_DIR);
      let deletedFilesCount = 0;
      for (const file of files) {
        // If filename is not in updates DB, delete it
        if (!activeHashes.has(file)) {
          const filePath = path.join(UPLOADS_DIR, file);
          try {
            fs.unlinkSync(filePath);
            deletedFilesCount++;
          } catch (e: any) {
            console.error(`[GC] Failed to delete orphaned file ${file}:`, e.message);
          }
        }
      }
      if (deletedFilesCount > 0) {
        console.log(`[GC] Cleaned up ${deletedFilesCount} orphaned bundle files from filesystem`);
      }
    }
  } catch (err: any) {
    console.error("[GC] Error running cleanup:", err.message);
  }
}

app.get("/api/updates", (req, res) => {
  const ip = (req.headers["x-forwarded-for"] as string) || req.ip || req.socket.remoteAddress || "127.0.0.1";
  if (!checkRateLimit(`ota:${ip}`, 120, 60 * 1000)) {
    res.status(429).send("Too many requests");
    return;
  }
  handleGetUpdates(req, res);
});
app.get("/api/projects/:projectId/updates", (req, res) => {
  const ip = (req.headers["x-forwarded-for"] as string) || req.ip || req.socket.remoteAddress || "127.0.0.1";
  if (!checkRateLimit(`ota:${ip}`, 120, 60 * 1000)) {
    res.status(429).send("Too many requests");
    return;
  }
  handleGetUpdates(req, res);
});

const handlePostUpdates = async (req: express.Request, res: express.Response) => {
  const projectId = req.params.projectId || (req.headers["x-project-id"] as string) || (req.query.projectId as string) || "default-project";
  try {
    const file = req.file;
    const { payload: payloadString, signature, platform } = req.body;

    if (!file || !payloadString || !signature) {
      res.status(400).send("Missing parameters: bundle, payload, and signature are required");
      return;
    }

    const payload = JSON.parse(payloadString) as {
      channel:          string;
      runtimeVersion?:  string;
      runtimeVersions?: string[];
      platform?:        string;
      bundleHash:       string;
      timestamp:        number;
      assets?:          Array<{ hash: string; key: string; fileExtension: string; contentType: string }>;
      assetCount?:      number;
      publicKey?:       string;
    };

    // Multi-Runtime Hotfix Matrix support: handle single or comma-separated or array of runtimes
    const rawRuntime = payload.runtimeVersions || payload.runtimeVersion;
    let runtimes: string[] = [];
    if (Array.isArray(rawRuntime)) {
      runtimes = rawRuntime.map(r => String(r).trim()).filter(Boolean);
    } else if (typeof rawRuntime === "string") {
      runtimes = rawRuntime.split(",").map(r => r.trim()).filter(Boolean);
    }

    if (runtimes.length === 0) {
      res.status(400).send("Invalid runtimeVersion: at least one runtime version is required.");
      return;
    }

    // ── Verify the ECDSA signature ───────────────────────────────────────────
    let verifyPublicKey = PUBLIC_KEY;
    if (projectId && projectId !== "default-project") {
      const project = await queryOne("SELECT * FROM projects WHERE id = ?", [projectId]);
      if (!project) {
        res.status(404).send("Project not found");
        return;
      }
      if (project.user_id !== (req as any).user.id) {
        const user = await queryOne("SELECT email FROM users WHERE id = ?", [(req as any).user.id]);
        const member = await queryOne(
          "SELECT id FROM team_members WHERE project_id = ? AND email = ? AND status = 'accepted' AND role IN ('developer', 'owner')",
          [projectId, user?.email || ""]
        );
        if (!member) {
          res.status(403).send("Forbidden: You do not have permission to push updates to this project");
          return;
        }
      }

      // Safe public key registration: only set if project currently has no key registered
      let currentPublicKey = project.public_key;
      if (!currentPublicKey && payload.publicKey) {
        await runCommand("UPDATE projects SET public_key = ? WHERE id = ?", [payload.publicKey, projectId]);
        currentPublicKey = payload.publicKey;
        console.log(`[OTA] Initialized ECDSA public key for project "${projectId}"`);
      }

      verifyPublicKey = currentPublicKey || PUBLIC_KEY;
    }

    if (verifyPublicKey) {
      const isValid = await verifyPayload(payloadString, signature, verifyPublicKey);
      if (!isValid) {
        console.warn("[OTA] Upload rejected: invalid ECDSA signature");
        res.status(401).send("Invalid signature — ECDSA verification failed");
        return;
      }
    } else {
      console.warn("[OTA] ⚠️  No public key configured for signature verification — skipped (dev/fallback mode)");
    }

    const updatePlatform = (platform as string) || payload.platform || "all";
    const bundleHash = payload.bundleHash;
    const bundleDestPath = path.join(UPLOADS_DIR, bundleHash);

    if (!fs.existsSync(bundleDestPath)) {
      fs.renameSync(file.path, bundleDestPath);
    } else {
      fs.unlinkSync(file.path);
    }

    // ── Insert updates across all runtimes in the Matrix ──────────────────────
    const createdAt = new Date().toISOString();
    const createdUpdateIds: string[] = [];

    const metadataObj = {
      deployedBy: "CLI",
      platform: updatePlatform,
      assets: Array.isArray(payload.assets) ? payload.assets : [],
      assetCount: (payload.assets && payload.assets.length) || payload.assetCount || 0,
      uploadedAt: createdAt
    };
    const metadataString = JSON.stringify(metadataObj);

    for (const rt of runtimes) {
      const updateId = crypto.randomUUID();
      createdUpdateIds.push(updateId);

      await runCommand(
        "INSERT INTO updates (id, project_id, created_at, runtime_version, channel, bundle_hash, platform, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          updateId,
          projectId,
          createdAt,
          rt,
          payload.channel,
          bundleHash,
          updatePlatform,
          metadataString
        ]
      );

      // ── Auto-create or update channel ──────────────────────────────────────
      const existingChannel = await queryOne("SELECT id FROM channels WHERE id = ? AND project_id = ?", [payload.channel, projectId]);
      if (!existingChannel) {
        const envLabel =
          payload.channel === "production" ? "Production" :
          payload.channel === "staging"    ? "Staging" :
          "Development";
        await runCommand(
          "INSERT INTO channels (id, project_id, env, status, rollout, runtime, active_release_id, target_platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            payload.channel,
            projectId,
            envLabel,
            "Active",
            100,
            rt,
            updateId,
            "all",
            createdAt
          ]
        );
        console.log(`[OTA] Auto-created channel "${payload.channel}" in project "${projectId}" → runtime ${rt}`);
      } else {
        await runCommand(
          "UPDATE channels SET active_release_id = ?, runtime = ? WHERE id = ? AND project_id = ?",
          [updateId, rt, payload.channel, projectId]
        );
      }
    }

    console.log(`[OTA] ✅  Update ${createdUpdateIds[0]} published → project=${projectId} channel=${payload.channel} runtimes=[${runtimes.join(", ")}] platform=${updatePlatform}`);

    // Run garbage collection asynchronously to prune old releases and clean orphaned files
    pruneOldReleases(projectId).catch(err => console.error("[GC] Error running background prune:", err.message));

    res.status(200).json({
      updateId:        createdUpdateIds[0],
      updateIds:       createdUpdateIds,
      channel:         payload.channel,
      runtimeVersion:  runtimes[0],
      runtimeVersions: runtimes,
      platform:        updatePlatform,
      bundleHash,
      createdAt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[OTA] Upload error:", error);
    res.status(500).send(message);
  }
};

app.post("/api/updates", authenticateSession, upload.single("bundle"), handlePostUpdates);
app.post("/api/projects/:projectId/updates", authenticateSession, upload.single("bundle"), handlePostUpdates);

// ── Asset Upload Endpoint ───────────────────────────────────────────────────
app.post("/api/assets/upload", authenticateSession, upload.array("assets"), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).send("No asset files provided");
      return;
    }

    const uploadedHashes: string[] = [];
    for (const f of files) {
      const buf = fs.readFileSync(f.path);
      const hash = crypto.createHash("sha256").update(buf).digest("hex");
      const targetPath = path.join(UPLOADS_DIR, hash);
      if (!fs.existsSync(targetPath)) {
        fs.renameSync(f.path, targetPath);
      } else {
        fs.unlinkSync(f.path);
      }
      uploadedHashes.push(hash);
    }

    res.json({ uploaded: uploadedHashes.length, hashes: uploadedHashes });
  } catch (e: any) {
    res.status(500).send(e.message || "Failed to upload assets");
  }
});

// ── Smart Delta / Diff Updates Engine ───────────────────────────────────────
app.get("/api/updates/delta", async (req, res) => {
  const baseHash   = req.query.baseHash as string;
  const targetHash = req.query.targetHash as string;

  if (!baseHash || !targetHash || !/^[a-fA-F0-9]+$/.test(baseHash) || !/^[a-fA-F0-9]+$/.test(targetHash)) {
    res.status(400).send("Invalid baseHash or targetHash");
    return;
  }

  const basePath   = path.join(UPLOADS_DIR, baseHash);
  const targetPath = path.join(UPLOADS_DIR, targetHash);

  if (!fs.existsSync(basePath) || !fs.existsSync(targetPath)) {
    res.status(404).send("Base or target bundle not found on server");
    return;
  }

  try {
    const baseBuf   = fs.readFileSync(basePath);
    const targetBuf = fs.readFileSync(targetPath);

    // If identical, return 304 Not Modified
    if (baseHash === targetHash) {
      res.status(304).end();
      return;
    }

    // Fast delta generator (Length-prefixed copy/insert instruction patch)
    // Format: [4 bytes header "EOTA"][4 bytes base length][4 bytes target length][diff stream]
    const header = Buffer.alloc(12);
    header.write("EOTA", 0, 4, "ascii");
    header.writeUInt32LE(baseBuf.length, 4);
    header.writeUInt32LE(targetBuf.length, 8);

    // Compute byte-level XOR delta stream for common blocks
    const minLen = Math.min(baseBuf.length, targetBuf.length);
    const diffStream = Buffer.alloc(targetBuf.length);
    targetBuf.copy(diffStream);

    for (let i = 0; i < minLen; i++) {
      diffStream[i] = targetBuf[i] ^ baseBuf[i];
    }

    const deltaBuffer = Buffer.concat([header, diffStream]);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Delta-Base", baseHash);
    res.setHeader("X-Delta-Target", targetHash);
    res.send(deltaBuffer);
  } catch (err: any) {
    console.error("[Delta] Error computing diff:", err);
    res.status(500).send("Failed to compute delta");
  }
});

// ── Secure Asset Delivery ───────────────────────────────────────────────────
app.get("/api/assets/:hash", (req, res) => {
  const rawHash = req.params.hash;
  if (!rawHash || !/^[a-zA-Z0-9_.-]+$/.test(rawHash)) {
    res.status(400).send("Invalid asset hash");
    return;
  }

  const safeFile = path.resolve(UPLOADS_DIR, path.basename(rawHash));
  if (!safeFile.startsWith(path.resolve(UPLOADS_DIR))) {
    res.status(403).send("Forbidden");
    return;
  }

  // Check if file exists by exact name, or try stripped extension (bundles stored as raw hash)
  let targetPath = safeFile;
  if (!fs.existsSync(targetPath)) {
    const withoutExt = path.join(UPLOADS_DIR, path.parse(rawHash).name);
    if (fs.existsSync(withoutExt)) {
      targetPath = withoutExt;
    } else {
      res.status(404).send("Asset not found");
      return;
    }
  }

  const ext = path.extname(rawHash).toLowerCase();
  const contentType =
    ext === ".png"   ? "image/png" :
    ext === ".jpg"   ? "image/jpeg" :
    ext === ".jpeg"  ? "image/jpeg" :
    ext === ".gif"   ? "image/gif" :
    ext === ".svg"   ? "image/svg+xml" :
    ext === ".ttf"   ? "font/ttf" :
    ext === ".otf"   ? "font/otf" :
    ext === ".woff"  ? "font/woff" :
    ext === ".woff2" ? "font/woff2" :
    ext === ".json"  ? "application/json" :
    "application/javascript";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("ETag", `"${rawHash}"`);
  fs.createReadStream(targetPath).pipe(res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EdgeOTA server-node listening on port ${PORT}`);
});
