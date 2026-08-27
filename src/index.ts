#!/usr/bin/env node

/**
 * edge-ota CLI  — Zero-SDK, self-hostable OTA updates for Expo
 * by Renbo Studios  —  Mobile App Development Studio
 * https://renbostudios.com
 *
 * Commands:
 *   edge-ota login    — Authenticate and save credentials globally
 *   edge-ota logout   — Remove stored credentials
 *   edge-ota init     — Register project, generate signing keys, configure app.json
 *   edge-ota push     — Export bundle and publish an OTA update
 *   edge-ota status   — List recent deployments for this project
 *   edge-ota keygen   — Generate a new ECDSA key pair (prints to stdout)
 */

import { Command } from "commander";
import { execSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import {
  generateECDSAKeyPair,
  signPayload,
  sha256Hex
} from "./core/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Global Config Paths ─────────────────────────────────────────────────────

const GLOBAL_CONFIG_DIR  = path.join(os.homedir(), ".config", "edge-ota");
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "config.json");
const GLOBAL_KEYS_DIR    = path.join(GLOBAL_CONFIG_DIR, "keys");

interface GlobalConfig {
  token:     string;
  email:     string;
  serverUrl: string;
}

function loadGlobalConfig(): GlobalConfig | null {
  try {
    if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, "utf-8")) as GlobalConfig;
    }
  } catch { /* ignore */ }
  return null;
}

function saveGlobalConfig(config: GlobalConfig): void {
  fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function clearGlobalConfig(): void {
  try { fs.rmSync(GLOBAL_CONFIG_FILE); } catch { /* ignore */ }
}

function loadPrivateKey(projectId: string): string | null {
  // 1. Global key store (new location)
  const globalKeyPath = path.join(GLOBAL_KEYS_DIR, `${projectId}.key`);
  if (fs.existsSync(globalKeyPath)) {
    return fs.readFileSync(globalKeyPath, "utf-8").trim();
  }
  // 2. Legacy local file (backward compat with deprecation notice)
  const localKeyPath = path.resolve(process.cwd(), ".edge-ota.private.key");
  if (fs.existsSync(localKeyPath)) {
    spin.stop();
    console.log(`  ${c.yellow}⚠${c.reset}  Using legacy ${c.dim}.edge-ota.private.key${c.reset} in project directory.`);
    console.log(`     Move it to ${c.dim}${globalKeyPath}${c.reset} and delete the local copy.`);
    return fs.readFileSync(localKeyPath, "utf-8").trim();
  }
  return null;
}

function savePrivateKey(projectId: string, key: string): void {
  fs.mkdirSync(GLOBAL_KEYS_DIR, { recursive: true });
  const keyPath = path.join(GLOBAL_KEYS_DIR, `${projectId}.key`);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
}

// ─── Auto-load .env ───────────────────────────────────────────────────────────

try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(k in process.env)) process.env[k] = v;
    }
  }
} catch { /* silently skip */ }

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const c = {
  reset:     "\x1b[0m",
  bold:      "\x1b[1m",
  dim:       "\x1b[2m",
  underline: "\x1b[4m",
  red:       "\x1b[31m",
  green:     "\x1b[32m",
  yellow:    "\x1b[33m",
  blue:      "\x1b[34m",
  magenta:   "\x1b[35m",
  cyan:      "\x1b[36m",
  white:     "\x1b[37m",
  gray:      "\x1b[90m",
};

// ─── Diagnostic Formatting Helpers ───────────────────────────────────────────

function printErrorBox(title: string, reason: string, solution?: string | string[]): void {
  const sep = `${c.red}${"─".repeat(56)}${c.reset}`;
  console.error(`\n${sep}`);
  console.error(`  ${c.red}${c.bold}✖  ${title}${c.reset}`);
  console.error(`  ${c.dim}${reason}${c.reset}`);
  if (solution) {
    console.error();
    console.error(`  ${c.cyan}${c.bold}💡 How to fix:${c.reset}`);
    const sols = Array.isArray(solution) ? solution : [solution];
    for (const s of sols) {
      console.error(`     ${s}`);
    }
  }
  console.error(`${sep}\n`);
}

function printWarningBox(title: string, reason: string, tip?: string): void {
  const sep = `${c.yellow}${"─".repeat(56)}${c.reset}`;
  console.warn(`\n${sep}`);
  console.warn(`  ${c.yellow}${c.bold}⚠  ${title}${c.reset}`);
  console.warn(`  ${c.dim}${reason}${c.reset}`);
  if (tip) {
    console.warn(`  ${c.cyan}${tip}${c.reset}`);
  }
  console.warn(`${sep}\n`);
}

function diagnoseNetworkError(err: any, serverUrl: string): { title: string; reason: string; solution: string[] } {
  const msg = err?.message || String(err);
  if (msg.includes("ECONNREFUSED")) {
    return {
      title: "Cannot connect to EdgeOTA server",
      reason: `Server at ${c.bold}${serverUrl}${c.reset}${c.dim} refused the connection (ECONNREFUSED).`,
      solution: [
        `Ensure your EdgeOTA server is running: ${c.bold}lsof -i :3020${c.reset} or check your server process.`,
        `Verify the server URL in ${c.bold}app.json${c.reset} or specify ${c.cyan}-s <url>${c.reset}`,
        `If using USB physical device debugging, run ${c.cyan}adb reverse tcp:3020 tcp:3020${c.reset}`
      ]
    };
  }
  if (msg.includes("ETIMEDOUT") || msg.includes("timeout") || msg.includes("aborted")) {
    return {
      title: "Server request timed out",
      reason: `Connection to ${c.bold}${serverUrl}${c.reset}${c.dim} exceeded timeout threshold.`,
      solution: [
        "Check your internet connection or local network routing.",
        "Ensure your firewall or VPS security group permits traffic on this port."
      ]
    };
  }
  return {
    title: "Network request failed",
    reason: msg,
    solution: [
      `Check your server URL: ${c.bold}${serverUrl}${c.reset}`,
      `Verify internet connectivity and try again.`
    ]
  };
}

// ─── Spinner ─────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const spin = (() => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let label = "";

  return {
    start(text: string) {
      label = text;
      frame = 0;
      if (!process.stdout.isTTY) {
        process.stdout.write(`  ${text}...\n`);
        return;
      }
      timer = setInterval(() => {
        const f = `${c.cyan}${FRAMES[frame % FRAMES.length]}${c.reset}`;
        process.stdout.write(`\r  ${f}  ${c.dim}${label}${c.reset}   `);
        frame++;
      }, 80);
    },
    update(text: string) {
      label = text;
    },
    stop(successMsg?: string) {
      if (timer) { clearInterval(timer); timer = null; }
      if (process.stdout.isTTY) {
        process.stdout.write("\r\x1b[K"); // clear line
      }
      if (successMsg) {
        console.log(`  ${c.green}✓${c.reset}  ${successMsg}`);
      }
    },
    fail(errMsg: string) {
      if (timer) { clearInterval(timer); timer = null; }
      if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
      console.error(`  ${c.red}✗${c.reset}  ${errMsg}`);
    }
  };
})();

// ─── Package version ─────────────────────────────────────────────────────────

let packageVersion = "0.4.0";
try {
  const pkgPath = path.join(__dirname, "..", "package.json");
  if (fs.existsSync(pkgPath)) {
    packageVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  }
} catch { /* fallback */ }

// ─── Auto Update Check ────────────────────────────────────────────────────────

const UPDATE_CHECK_FILE = path.join(GLOBAL_CONFIG_DIR, "update-check.json");

function isNewerVersion(current: string, latest: string): boolean {
  const cParts = current.split(".").map(Number);
  const lParts = latest.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const cNum = cParts[i] || 0;
    const lNum = lParts[i] || 0;
    if (lNum > cNum) return true;
    if (lNum < cNum) return false;
  }
  return false;
}

async function checkAndAutoUpdate() {
  if (process.env.EDGE_OTA_UPDATING === "true") return;

  try {
    const now = Date.now();
    if (fs.existsSync(UPDATE_CHECK_FILE)) {
      try {
        const cache = JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, "utf-8"));
        if (now - (cache.lastChecked || 0) < 15 * 60 * 1000) {
          return;
        }
      } catch { /* ignore */ }
    }

    fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify({ lastChecked: now }));

    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), 1000);

    const res = await fetch("https://registry.npmjs.org/@renbostudios/edge-ota/latest", {
      signal: controller.signal
    });
    clearTimeout(timerId);

    if (!res.ok) return;
    const data = (await res.json()) as { version: string };
    const latestVersion = data.version;

    if (latestVersion && isNewerVersion(packageVersion, latestVersion)) {
      console.log(`\n  ${c.yellow}${c.reset}  New version of ${c.bold}edge-ota${c.reset} available: ${c.green}${latestVersion}${c.reset} (current: ${c.dim}${packageVersion}${c.reset})`);
      console.log(`  ${c.blue}➜${c.reset}  Auto-updating globally...`);

      try {
        execSync("npm install -g @renbostudios/edge-ota", {
          stdio: "inherit",
          env: { ...process.env, EDGE_OTA_UPDATING: "true" }
        });
        console.log(`  ${c.green}✓${c.reset}  Successfully auto-updated to ${c.bold}${latestVersion}${c.reset}!\n`);
      } catch (err: any) {
        console.error(`  ${c.red}✗${c.reset}  Auto-update failed: ${err.message}`);
        console.error(`     Please update manually: ${c.cyan}npm install -g @renbostudios/edge-ota${c.reset}\n`);
      }
    }
  } catch {
    // Fail silently so CLI works offline
  }
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner() {
  const sep = `${c.dim}${"─".repeat(56)}${c.reset}`;
  console.log(`\n${sep}`);
  console.log(`  ${c.bold}${c.white}edge-ota${c.reset}  ${c.dim}v${packageVersion} · Zero-SDK OTA for Expo${c.reset}`);
  console.log(`  ${c.dim}by ${c.reset}${c.bold}Renbo Studios${c.reset}${c.dim} — Mobile App Development Studio${c.reset}`);
  console.log(`  ${c.dim}renbostudios.com${c.reset}`);
  console.log(`${sep}\n`);
}

// ─── app.json helpers ────────────────────────────────────────────────────────

const DEFAULT_SERVER = "https://api.ota.renbo.site";

interface AppJsonConfig {
  serverUrl:      string;
  projectId:      string | null;
  runtimeVersion: string;
  publicKey?:     string;
}

function readAppJson(cwd: string): AppJsonConfig {
  const appJsonPath = path.resolve(cwd, "app.json");
  if (!fs.existsSync(appJsonPath)) {
    printErrorBox(
      "app.json not found",
      `No app.json file located in directory: ${cwd}`,
      [
        `Ensure you are running edge-ota commands from the ${c.bold}root directory${c.reset} of your Expo project.`,
        `If you use dynamic config (${c.dim}app.config.js / app.config.ts${c.reset}), create a base ${c.bold}app.json${c.reset} file with your Expo configuration.`
      ]
    );
    process.exit(1);
  }

  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
  } catch (parseErr: any) {
    printErrorBox(
      "Invalid app.json syntax",
      `Failed to parse JSON in ${appJsonPath}: ${parseErr.message}`,
      `Verify that app.json contains valid JSON syntax (no trailing commas, unclosed brackets, or unescaped quotes).`
    );
    process.exit(1);
  }

  const expo = data?.expo ?? {};

  // ── Runtime version ──
  let runtimeVersion = expo.runtimeVersion;
  if (!runtimeVersion) {
    printErrorBox(
      "Missing expo.runtimeVersion in app.json",
      "Expo Updates requires a runtimeVersion to ensure native compatibility between the app binary and JS bundle.",
      [
        `Add a fixed version string in ${c.bold}app.json${c.reset} under ${c.dim}"expo"${c.reset}: ${c.cyan}"runtimeVersion": "1.0.0"${c.reset}`,
        `Or use an Expo policy helper: ${c.cyan}"runtimeVersion": { "policy": "appVersion" }${c.reset}`
      ]
    );
    process.exit(1);
  }

  // Resolve runtimeVersion object (e.g. policy helper) to string
  if (typeof runtimeVersion === "object" && runtimeVersion !== null) {
    const policy = (runtimeVersion as any).policy;
    if (policy === "appVersion") {
      runtimeVersion = expo.version;
    } else if (policy === "sdkVersion") {
      runtimeVersion = expo.sdkVersion;
    } else {
      runtimeVersion = expo.version || expo.sdkVersion;
    }
  }

  if (!runtimeVersion || typeof runtimeVersion !== "string") {
    printErrorBox(
      "Could not resolve runtimeVersion",
      `expo.runtimeVersion in app.json resolved to: ${JSON.stringify(runtimeVersion)}`,
      [
        `If using ${c.dim}"policy": "appVersion"${c.reset}, make sure ${c.bold}"expo.version"${c.reset} (e.g. "1.0.0") is defined in app.json.`,
        `If using ${c.dim}"policy": "sdkVersion"${c.reset}, make sure ${c.bold}"expo.sdkVersion"${c.reset} (e.g. "52.0.0") is defined.`,
        `Or simply specify a static string: ${c.cyan}"runtimeVersion": "1.0.0"${c.reset}`
      ]
    );
    process.exit(1);
  }

  // ── Updates URL ──
  const updatesUrl: string = expo?.updates?.url ?? "";
  if (!updatesUrl) {
    printErrorBox(
      "Missing expo.updates.url in app.json",
      "Your app is not configured to receive updates from an EdgeOTA server.",
      [
        `Run ${c.cyan}edge-ota init${c.reset} in this directory to automatically configure your project.`,
        `Or manually add under ${c.dim}"expo.updates"${c.reset}: ${c.cyan}"url": "https://api.ota.renbo.site/api/projects/<project-id>/updates"${c.reset}`
      ]
    );
    process.exit(1);
  }

  // Parse serverUrl and projectId from the updates URL.
  let serverUrl: string;
  let projectId: string | null = null;

  try {
    const u = new URL(updatesUrl);
    const projectMatch = u.pathname.match(/\/api\/projects\/([^/]+)\/updates/);
    if (projectMatch) {
      projectId = projectMatch[1];
      serverUrl = `${u.protocol}//${u.host}`;
    } else {
      serverUrl = `${u.protocol}//${u.host}`;
    }
  } catch {
    printErrorBox(
      "Malformed expo.updates.url",
      `The URL "${updatesUrl}" in app.json is not a valid HTTP/HTTPS URL.`,
      `Run ${c.cyan}edge-ota init${c.reset} to generate a valid updates URL.`
    );
    process.exit(1);
  }

  // ── Project-level server override ──
  const projectServer: string | undefined = expo?.extra?.edgeOtaServer;
  if (projectServer) {
    serverUrl = projectServer.replace(/\/$/, "");
  }

  return { serverUrl, projectId, runtimeVersion, publicKey: expo?.extra?.edgeOtaPublicKey };
}

function updateAppJson(cwd: string, serverUrl: string, projectId?: string, publicKey?: string) {
  const appJsonPath = path.resolve(cwd, "app.json");
  if (!fs.existsSync(appJsonPath)) return;

  try {
    const data = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
    if (!data.expo) data.expo = {};
    if (!data.expo.updates) data.expo.updates = {};
    if (!data.expo.extra) data.expo.extra = {};

    const cleanUrl = serverUrl.replace(/\/$/, "");
    data.expo.updates.url = projectId
      ? `${cleanUrl}/api/projects/${projectId}/updates`
      : `${cleanUrl}/api/updates`;
    data.expo.updates.checkAutomatically = data.expo.updates.checkAutomatically ?? "ON_LOAD";
    data.expo.updates.fallbackToCacheTimeout = data.expo.updates.fallbackToCacheTimeout ?? 30000;
    data.expo.updates.requestHeaders = data.expo.updates.requestHeaders ?? { "expo-channel-name": "production" };

    data.expo.extra.edgeOtaServer = cleanUrl;

    if (publicKey) {
      data.expo.extra.edgeOtaPublicKey = publicKey;
    }

    fs.writeFileSync(appJsonPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    console.log(`  ${c.dim}app.json${c.reset}    updated ${c.dim}expo.updates.url${c.reset} + ${c.dim}expo.extra.edgeOtaServer${c.reset}`);
  } catch (e: any) {
    printWarningBox("Could not write to app.json", e.message, "Ensure app.json is writable.");
  }
}

// ─── Readline helper ─────────────────────────────────────────────────────────

function ask(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, a => { rl.close(); resolve(a.trim()); }));
}

function askSecret(query: string): Promise<string> {
  return new Promise(resolve => {
    if (process.stdin.isTTY) {
      process.stdout.write(query);
      let input = "";
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", function onData(ch: string) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(input);
        } else if (ch === "\u0003") {
          process.exit(0);
        } else if (ch === "\u007f") {
          if (input.length > 0) { input = input.slice(0, -1); process.stdout.write("\b \b"); }
        } else {
          input += ch;
          process.stdout.write("•");
        }
      });
    } else {
      ask(query).then(resolve);
    }
  });
}

interface SelectOptionItem<T> {
  label: string;
  value: T;
}

function selectOption<T>(
  question: string,
  options: SelectOptionItem<T>[]
): Promise<T> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.log(`  ${c.bold}${question}${c.reset}`);
      options.forEach((opt, idx) => {
        console.log(`  [${idx + 1}] ${opt.label}`);
      });
      ask(`  selection (1-${options.length}): `).then((choice) => {
        const idx = parseInt(choice) - 1;
        if (!isNaN(idx) && idx >= 0 && idx < options.length) {
          resolve(options[idx].value);
        } else {
          resolve(options[0].value);
        }
      });
      return;
    }

    let cursor = 0;
    const hideCursor = "\u001b[?25l";
    const showCursor = "\u001b[?25h";
    let hasRendered = false;

    console.log(`  ${c.bold}${question}${c.reset}`);

    function render() {
      if (hasRendered) {
        for (let i = 0; i < options.length; i++) {
          process.stdout.write("\r\u001b[K\u001b[A");
        }
        process.stdout.write("\r\u001b[K");
      }
      hasRendered = true;

      options.forEach((opt, idx) => {
        const isSelected = idx === cursor;
        const marker = isSelected ? `${c.cyan}❯${c.reset}` : " ";
        const text = isSelected ? `${c.bold}${c.cyan}${opt.label}${c.reset}` : `${c.dim}${opt.label}${c.reset}`;
        process.stdout.write(`  ${marker} ${text}\n`);
      });
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(hideCursor);
    render();

    function onKeypress(str: string, key: any) {
      if (key.ctrl && key.name === "c") {
        process.stdout.write(showCursor);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.exit(0);
      }

      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + options.length) % options.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % options.length;
        render();
      } else if (key.name === "return" || key.name === "enter") {
        process.stdout.write(showCursor);
        process.stdin.setRawMode(false);
        process.stdin.removeListener("keypress", onKeypress);
        process.stdin.pause();
        resolve(options[cursor].value);
      }
    }

    process.stdin.on("keypress", onKeypress);
  });
}

// ─── Asset collection ─────────────────────────────────────────────────────────

interface AssetEntry {
  localPath:   string;
  key:         string;
  contentType: string;
  hash:        string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".js":    "application/javascript",
  ".hbc":   "application/javascript",
  ".json":  "application/json",
  ".png":   "image/png",
  ".jpg":   "image/jpeg",
  ".jpeg":  "image/jpeg",
  ".gif":   "image/gif",
  ".svg":   "image/svg+xml",
  ".ttf":   "font/ttf",
  ".otf":   "font/otf",
  ".woff":  "font/woff",
  ".woff2": "font/woff2",
  ".mp4":   "video/mp4",
  ".webm":  "video/webm",
};

async function hashFile(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  return sha256Hex(buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer);
}

async function collectAssets(distDir: string): Promise<AssetEntry[]> {
  const entries: AssetEntry[] = [];

  function walk(dir: string) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else {
        const ext = path.extname(name).toLowerCase();
        entries.push({
          localPath:   full,
          key:         path.relative(distDir, full).replace(/\\/g, "/"),
          contentType: CONTENT_TYPES[ext] || "application/octet-stream",
          hash:        ""
        });
      }
    }
  }

  walk(distDir);
  await Promise.all(entries.map(async e => { e.hash = await hashFile(e.localPath); }));
  return entries;
}

function findBundle(distDir: string, platform: string): string | null {
  const expoStaticJs = path.join(distDir, "_expo", "static", "js", platform);
  if (fs.existsSync(expoStaticJs)) {
    const files = fs.readdirSync(expoStaticJs).filter(f => f.endsWith(".js") || f.endsWith(".hbc"));
    if (files.length) return path.join(expoStaticJs, files[0]);
  }
  const flatJs = path.join(distDir, `index.${platform}.js`);
  if (fs.existsSync(flatJs)) return flatJs;
  const flatHbc = path.join(distDir, `index.${platform}.hbc`);
  if (fs.existsSync(flatHbc)) return flatHbc;
  const rootJs = fs.readdirSync(distDir).find(f => f.endsWith(".js") || f.endsWith(".hbc"));
  if (rootJs) return path.join(distDir, rootJs);
  return null;
}

// ─── Auth token resolution ────────────────────────────────────────────────────

function resolveToken(): string | null {
  const cfg = loadGlobalConfig();
  if (cfg?.token) return cfg.token;
  return process.env.EDGE_OTA_TOKEN || null;
}

// ─── Program ─────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("edge-ota")
  .description("Zero-SDK, self-hostable OTA update platform for Expo — by Renbo Studios")
  .version(packageVersion);

// Customize top-level help
program.addHelpText("after", `
${c.bold}Quick Start:${c.reset}
  1. ${c.cyan}edge-ota login${c.reset}                       Authenticate with EdgeOTA
  2. ${c.cyan}edge-ota init${c.reset}                        Configure your Expo app and generate signing keys
  3. ${c.cyan}npx expo prebuild --clean${c.reset}            Bake the server URL into native files (Required!)
  4. ${c.cyan}edge-ota push${c.reset}                        Export and publish your first OTA update

${c.bold}Documentation & Support:${c.reset}
  Website:       https://ota.renbo.site
  Studio:        https://renbostudios.com
  GitHub:        https://github.com/renbostudios/edge-ota-cli
`);

// Show help + auth status when called with no arguments
program.action(() => {
  printBanner();
  const cfg = loadGlobalConfig();
  if (cfg?.email) {
    console.log(`  ${c.green}●${c.reset}  Logged in as ${c.bold}${cfg.email}${c.reset}  ${c.dim}(${cfg.serverUrl})${c.reset}`);
  } else {
    console.log(`  ${c.dim}○  Not logged in — run ${c.reset}${c.cyan}edge-ota login${c.reset}`);
  }
  console.log();
  console.log(`  ${c.bold}Commands${c.reset}`);
  const cmds = [
    ["login",   "Authenticate and save credentials globally"],
    ["logout",  "Remove stored credentials"],
    ["init",    "Register project, generate signing keys, configure app.json"],
    ["push",    "Export bundle and publish an OTA update"],
    ["status",  "List recent deployments for this project"],
    ["keygen",  "Generate a new ECDSA key pair (prints to stdout)"],
  ];
  for (const [cmd, desc] of cmds) {
    console.log(`  ${c.cyan}${cmd.padEnd(10)}${c.reset}  ${c.dim}${desc}${c.reset}`);
  }
  console.log();
  console.log(`  Run ${c.cyan}edge-ota <command> --help${c.reset} for detailed command options and examples.`);
  console.log();
});

// ──────────────────────────────────────────────────────────────────────────────
// edge-ota login
// ──────────────────────────────────────────────────────────────────────────────

program
  .command("login")
  .description("Authenticate with your EdgeOTA account and save credentials globally")
  .option("-s, --server <url>", "EdgeOTA server URL", DEFAULT_SERVER)
  .addHelpText("after", `
${c.bold}Examples:${c.reset}
  $ ${c.cyan}edge-ota login${c.reset}                          Sign in to standard cloud service (${DEFAULT_SERVER})
  $ ${c.cyan}edge-ota login -s http://localhost:3020${c.reset} Sign in to a self-hosted local server
  $ ${c.cyan}edge-ota login -s https://ota.mycompany.com${c.reset} Sign in to a self-hosted custom domain

${c.bold}CI/CD Environments:${c.reset}
  Instead of interactive login, set the ${c.bold}EDGE_OTA_TOKEN${c.reset} environment variable:
  $ ${c.cyan}export EDGE_OTA_TOKEN="eota_prod_..."${c.reset}
`)
  .action(async (options) => {
    printBanner();

    const usingCustomServer = options.server && options.server !== DEFAULT_SERVER;
    console.log(`  ${c.bold}Sign in to EdgeOTA${c.reset}`);
    if (usingCustomServer) {
      console.log(`  ${c.dim}server: ${options.server}${c.reset}`);
    }
    console.log();

    const serverUrl = (options.server || DEFAULT_SERVER).replace(/\/$/, "");
    const email    = await ask(`  ${c.dim}email:${c.reset}    `);
    const password = await askSecret(`  ${c.dim}password:${c.reset} `);

    spin.start("authenticating");

    try {
      const res = await fetch(`${serverUrl}/api/auth/login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const text = await res.text();
        spin.fail("Authentication failed");
        if (res.status === 401) {
          printErrorBox(
            "Invalid email or password",
            text || "The credentials provided were rejected by the server.",
            [
              `Check your email and password for typos.`,
              `If you don't have an account yet, register at ${c.bold}https://ota.renbo.site${c.reset}`,
              `If using self-hosted server, verify ${c.bold}${serverUrl}${c.reset} is correct.`
            ]
          );
        } else if (res.status === 403) {
          printErrorBox(
            "Account email not verified",
            text || "Your account email has not been verified.",
            `Check your inbox for the verification OTP or log in to the dashboard to verify your email.`
          );
        } else {
          printErrorBox(
            `Server returned HTTP ${res.status}`,
            text || res.statusText,
            `Check server logs or try again shortly.`
          );
        }
        process.exit(1);
      }

      const data = await res.json() as { token: string; email: string };
      saveGlobalConfig({ token: data.token, email: data.email, serverUrl });

      spin.stop();
      const sep = `${c.dim}${"─".repeat(56)}${c.reset}`;
      console.log(sep);
      console.log(`  ${c.green}✓${c.reset}  Logged in as ${c.bold}${data.email}${c.reset}`);
      console.log(`  ${c.dim}credentials saved to ${GLOBAL_CONFIG_FILE}${c.reset}`);
      console.log(sep + "\n");
      process.exit(0);
    } catch (e: any) {
      spin.fail("Connection failed");
      const diag = diagnoseNetworkError(e, serverUrl);
      printErrorBox(diag.title, diag.reason, diag.solution);
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────────────────────────────────────
// edge-ota logout
// ──────────────────────────────────────────────────────────────────────────────

program
  .command("logout")
  .description("Remove stored credentials and log out")
  .addHelpText("after", `
${c.bold}Details:${c.reset}
  Deletes the global configuration file at ${c.dim}${GLOBAL_CONFIG_FILE}${c.reset}.
  Project private signing keys in ${c.dim}${GLOBAL_KEYS_DIR}${c.reset} are preserved.
`)
  .action(() => {
    printBanner();
    const cfg = loadGlobalConfig();
    clearGlobalConfig();
    if (cfg?.email) {
      console.log(`  ${c.green}✓${c.reset}  Logged out from ${c.bold}${cfg.email}${c.reset}\n`);
    } else {
      console.log(`  ${c.dim}Already logged out.${c.reset}\n`);
    }
    process.exit(0);
  });

// ──────────────────────────────────────────────────────────────────────────────
// edge-ota init
// ──────────────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Register project on EdgeOTA, generate signing keys, and configure app.json")
  .option("-s, --server <url>", "EdgeOTA server URL (overrides logged-in server)")
  .addHelpText("after", `
${c.bold}What this command does:${c.reset}
  1. Authenticates with your EdgeOTA server
  2. Creates or links a project ID
  3. Generates a cryptographic ECDSA P-256 code-signing keypair
  4. Stores private key securely in ${c.dim}~/.config/edge-ota/keys/<projectId>.key${c.reset}
  5. Updates ${c.bold}app.json${c.reset} with ${c.dim}expo.updates.url${c.reset} and public key

${c.bold}Critical Next Step:${c.reset}
  After running ${c.cyan}edge-ota init${c.reset}, you ${c.bold}MUST rebuild your native app${c.reset}:
    $ ${c.cyan}npx expo prebuild --clean${c.reset}
    $ ${c.cyan}npx expo run:android${c.reset}   (or ${c.cyan}npx expo run:ios${c.reset} / ${c.cyan}eas build${c.reset})
`)
  .action(async (options) => {
    printBanner();

    const token = resolveToken();
    if (!token) {
      printErrorBox(
        "Not logged in",
        "You must be authenticated to initialize a project.",
        [
          `Run ${c.cyan}edge-ota login${c.reset} to authenticate interactively.`,
          `Or set ${c.cyan}export EDGE_OTA_TOKEN="eota_prod_..."${c.reset} in your environment.`
        ]
      );
      process.exit(1);
    }

    const globalCfg = loadGlobalConfig();
    const serverUrl = (options.server || globalCfg?.serverUrl || DEFAULT_SERVER).replace(/\/$/, "");
    const cwd       = process.cwd();

    // Fetch existing projects
    spin.start("fetching existing projects from server");
    let projects: any[] = [];
    try {
      const res = await fetch(`${serverUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        projects = await res.json() as any[];
      }
      spin.stop();
    } catch (e: any) {
      spin.fail("Failed to fetch projects list");
      const diag = diagnoseNetworkError(e, serverUrl);
      printWarningBox(diag.title, diag.reason, "Proceeding with new project registration...");
    }

    let projectId: string | null = null;
    let projectName = "";

    if (projects.length > 0) {
      const selectOptions = projects.map(p => ({
        label: `${p.name} ${c.dim}(id: ${p.id.slice(0, 8)}...)${c.reset}`,
        value: p
      }));
      selectOptions.push({
        label: `${c.green}+ Create a new project...${c.reset}`,
        value: null
      });

      const selected = await selectOption(
        "Select a project to associate with this app:",
        selectOptions
      );

      if (selected) {
        projectId = selected.id;
        projectName = selected.name;
      }
    }

    const keys = await generateECDSAKeyPair();

    if (projectId) {
      // Re-initialize existing project: update public key on the server
      spin.start(`associating project "${projectName}"`);
      try {
        const res = await fetch(`${serverUrl}/api/projects/${projectId}`, {
          method:  "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body:    JSON.stringify({ name: projectName, publicKey: keys.publicKey }),
        });

        if (!res.ok) {
          const text = await res.text();
          spin.fail("Failed to update project public key");
          printErrorBox(
            `Server returned HTTP ${res.status}`,
            text,
            `Ensure your user account has administrator or member permissions for project "${projectName}".`
          );
          process.exit(1);
        }
        spin.stop(`associated project "${projectName}"`);
      } catch (e: any) {
        spin.fail("Connection error during project update");
        const diag = diagnoseNetworkError(e, serverUrl);
        printErrorBox(diag.title, diag.reason, diag.solution);
        process.exit(1);
      }
    } else {
      // Create new project
      let suggestedName = path.basename(cwd);
      try {
        const data = JSON.parse(fs.readFileSync(path.resolve(cwd, "app.json"), "utf-8"));
        suggestedName = data?.expo?.name || suggestedName;
      } catch { /* ignore */ }

      projectName = (await ask(`  ${c.dim}project name [${suggestedName}]:${c.reset} `)) || suggestedName;

      spin.start("registering project on server");
      try {
        const res = await fetch(`${serverUrl}/api/projects`, {
          method:  "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body:    JSON.stringify({ name: projectName, publicKey: keys.publicKey }),
        });

        if (!res.ok) {
          const text = await res.text();
          spin.fail("Failed to register project");
          printErrorBox(
            `Server returned HTTP ${res.status}`,
            text,
            `Check that your session token is valid and project name is acceptable.`
          );
          process.exit(1);
        }

        const data = await res.json() as { id: string };
        projectId = data.id;
        spin.stop("project registered");
      } catch (e: any) {
        spin.fail("Connection error during registration");
        const diag = diagnoseNetworkError(e, serverUrl);
        printErrorBox(diag.title, diag.reason, diag.solution);
        process.exit(1);
      }
    }

    // Save private key globally
    if (projectId) {
      savePrivateKey(projectId, keys.privateKey);
      // Update app.json
      updateAppJson(cwd, serverUrl, projectId, keys.publicKey);

      const sep = `${c.dim}${"─".repeat(56)}${c.reset}`;
      console.log(`\n${sep}`);
      console.log(`  ${c.green}✓${c.reset}  ${c.bold}Initialised Successfully${c.reset}`);
      console.log(sep);
      console.log(`  project    ${c.dim}${projectId}${c.reset}`);
      console.log(`  server     ${c.dim}${serverUrl}${c.reset}`);
      console.log(`  key file   ${c.dim}${path.join(GLOBAL_KEYS_DIR, `${projectId}.key`)}${c.reset}`);
      console.log(sep);

      console.log(`\n${c.bold}${c.yellow}  ⚠  REBUILD REQUIRED${c.reset}`);
      console.log(sep);
      console.log(`  ${c.bold}Your native app MUST be rebuilt for OTA updates${c.reset}`);
      console.log(`  ${c.bold}to work.${c.reset} The server URL is baked into native`);
      console.log(`  binary configurations at build time — not read dynamically from app.json.`);
      console.log();
      console.log(`  Run these commands in order:`);
      console.log();
      console.log(`    ${c.cyan}npx expo prebuild --clean${c.reset}`);
      console.log(`    ${c.cyan}npx expo run:android${c.reset}  (or ${c.cyan}npx expo run:ios${c.reset})`);
      console.log();
      console.log(`  Or via EAS Build:`);
      console.log(`    ${c.cyan}eas build --profile production${c.reset}`);
      console.log();
      console.log(`  ${c.red}Skipping this WILL cause "Failed to check for${c.reset}`);
      console.log(`  ${c.red}update" errors on app launch.${c.reset}`);
      console.log(sep + "\n");

      console.log(`  Then run ${c.cyan}edge-ota push${c.reset} to publish your first update.\n`);
      process.exit(0);
    }
  });

// ──────────────────────────────────────────────────────────────────────────────
// edge-ota push
// ──────────────────────────────────────────────────────────────────────────────

program
  .command("push")
  .description("Export bundle, sign with ECDSA P-256, and publish an OTA update")
  .option("-c, --channel <channel>",   "Deployment channel", "production")
  .option("-p, --platform <platform>", "Target platform: ios | android | all", "all")
  .option("-r, --runtime <runtime>",   "Override target runtime version (comma-separated for multi-runtime matrix, e.g. 1.0.0,1.0.1)")
  .option("--skip-export",             "Skip expo export (use existing ./dist directory)")
  .option("--dry-run",                 "Build and sign payload locally without uploading")
  .addHelpText("after", `
${c.bold}Examples:${c.reset}
  $ ${c.cyan}edge-ota push${c.reset}                               Publish update to 'production' channel
  $ ${c.cyan}edge-ota push -c staging${c.reset}                    Publish update to 'staging' channel
  $ ${c.cyan}edge-ota push -p android${c.reset}                    Publish to Android only
  $ ${c.cyan}edge-ota push -r 1.0.5${c.reset}                      Override runtime version to 1.0.5
  $ ${c.cyan}edge-ota push -r 1.0.0,1.0.1,2.0.0${c.reset}          Hotfix multiple native runtime versions simultaneously
  $ ${c.cyan}edge-ota push --skip-export${c.reset}                 Deploy existing ./dist without re-running expo export
  $ ${c.cyan}edge-ota push --dry-run${c.reset}                     Verify build, asset collection, and signature locally

${c.bold}How It Works:${c.reset}
  1. Runs ${c.dim}npx expo export${c.reset} to produce Hermes bytecode bundles (.hbc)
  2. Discovers and uploads static media assets (.png, .jpg, .svg, .ttf, etc.)
  3. Signs bundle hash with private key in ${c.dim}~/.config/edge-ota/keys/<projectId>.key${c.reset}
  4. Publishes update to EdgeOTA server for instant client OTA sync
`)
  .action(async (options) => {
    const cwd   = process.cwd();
    const token = resolveToken();

    printBanner();

    if (!token) {
      printErrorBox(
        "Not logged in",
        "You must be authenticated to publish an OTA update.",
        [
          `Run ${c.cyan}edge-ota login${c.reset} to sign in to your EdgeOTA account.`,
          `Or set ${c.cyan}export EDGE_OTA_TOKEN="eota_prod_..."${c.reset} in your environment (recommended for CI/CD).`
        ]
      );
      process.exit(1);
    }

    // Auto-detect from app.json
    const appCfg = readAppJson(cwd);
    const { serverUrl, projectId } = appCfg;
    const runtimeVersion = options.runtime || appCfg.runtimeVersion;

    // Load private signing key
    const privateKey = projectId ? loadPrivateKey(projectId) : null;
    if (!privateKey) {
      const keyPath = projectId ? path.join(GLOBAL_KEYS_DIR, `${projectId}.key`) : "unknown";
      printErrorBox(
        "No signing key found for this project",
        `Expected private key file at: ${keyPath}`,
        [
          `Run ${c.cyan}edge-ota init${c.reset} to re-associate this project and generate a new keypair.`,
          `If collaborating with a team, copy the project's private key into ${c.bold}${keyPath}${c.reset}`,
          `Or generate keys manually using ${c.cyan}edge-ota keygen${c.reset}`
        ]
      );
      process.exit(1);
    }

    const uploadUrl = projectId
      ? `${serverUrl}/api/projects/${projectId}/updates`
      : `${serverUrl}/api/updates`;

    const distDir = path.resolve(cwd, "dist");

    // ── Step 1: Expo export ──────────────────────────────────────────────────
    if (!options.skipExport) {
      spin.start("running expo export");

      await new Promise<void>((resolve, reject) => {
        const proc = spawn("npx", ["expo", "export"], {
          cwd,
          stdio: ["inherit", "pipe", "pipe"],
          shell: process.platform === "win32",
        });

        // Filter stdout: only show platform bundle lines
        proc.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          for (const line of text.split("\n")) {
            const t = line.trim();
            if (t.startsWith("_expo/static/js/") || t.match(/\.(hbc|js)\s+\(\d/)) {
              spin.stop();
              console.log(`  ${c.dim}${t}${c.reset}`);
              spin.start("running expo export");
            }
            if (t.match(/Bundled \d+ms/)) {
              spin.update("expo export — " + t.replace("Bundled", "").trim());
            }
          }
        });

        let stderrBuf = "";
        proc.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); });

        proc.on("close", code => {
          if (code === 0) {
            spin.stop("expo export complete");
            resolve();
          } else {
            spin.fail("expo export failed");
            printErrorBox(
              "Expo export failed",
              `npx expo export exited with code ${code}`,
              [
                `Run ${c.bold}npx expo export${c.reset} directly in your terminal to see full Metro compiler logs.`,
                `Check for TypeScript compiler errors, missing dependencies, or invalid asset imports.`,
                `Recent stderr output:\n${c.dim}${stderrBuf.slice(-400).trim()}${c.reset}`
              ]
            );
            reject(new Error(`expo export exited with code ${code}`));
          }
        });
      }).catch(() => process.exit(1));

    } else {
      console.log(`  ${c.dim}skip-export — using existing ./dist${c.reset}`);
    }

    if (!fs.existsSync(distDir)) {
      printErrorBox(
        "dist directory not found",
        `Expected export output at ${distDir}`,
        [
          `Run ${c.cyan}edge-ota push${c.reset} without ${c.dim}--skip-export${c.reset} to automatically generate bundles.`,
          `Or manually build using ${c.cyan}npx expo export${c.reset}`
        ]
      );
      process.exit(1);
    }

    // ── Step 2: Collect and upload assets ────────────────────────────────────
    spin.start("collecting assets");
    const assets = await collectAssets(distDir);
    const mediaAssets = assets.filter(a => !a.key.endsWith(".js") && !a.key.endsWith(".hbc"));
    spin.stop(`found ${assets.length} total asset(s) (${mediaAssets.length} static assets)`);

    // Upload static media assets to server if any
    if (mediaAssets.length > 0 && !options.dryRun) {
      spin.start(`uploading ${mediaAssets.length} static asset(s)`);
      try {
        const assetForm = new FormData();
        for (const ma of mediaAssets) {
          const fileBuf = fs.readFileSync(ma.localPath);
          assetForm.append("assets", new Blob([fileBuf], { type: ma.contentType }), path.basename(ma.localPath));
        }
        const assetUploadUrl = `${serverUrl}/api/assets/upload`;
        const assetRes = await fetch(assetUploadUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(projectId ? { "X-Project-Id": projectId } : {})
          },
          body: assetForm
        });
        if (assetRes.ok) {
          spin.stop(`synced ${mediaAssets.length} static asset(s)`);
        } else {
          spin.stop(`asset sync notice: server returned HTTP ${assetRes.status}`);
        }
      } catch (assetErr: any) {
        spin.stop(`asset sync: ${c.dim}${assetErr.message}${c.reset}`);
      }
    }

    const platforms = options.platform === "all" ? ["ios", "android"] : [options.platform];
    const sep = `${c.dim}${"─".repeat(56)}${c.reset}`;

    // ── Step 3: Per-platform upload ──────────────────────────────────────────
    for (const platform of platforms) {
      console.log(`\n${sep}`);
      console.log(`  ${c.bold}${platform}${c.reset}`);
      console.log(sep);

      const bundlePath = findBundle(distDir, platform);
      if (!bundlePath) {
        printWarningBox(
          `No bundle found for ${platform}`,
          `Expected bundle at ./dist/_expo/static/js/${platform}/ or ./dist/index.${platform}.hbc`,
          `If this platform is not supported in your app, ignore this or pass -p <platform>.`
        );
        continue;
      }

      const bundleHash = await hashFile(bundlePath);
      const bundleSize = (fs.statSync(bundlePath).size / 1024 / 1024).toFixed(2);
      console.log(`  bundle     ${c.dim}${bundleHash.slice(0, 16)}…  ${bundleSize} MB${c.reset}`);

      const payloadObj = {
        channel:        options.channel,
        runtimeVersion,
        platform,
        bundleHash,
        timestamp:      Date.now(),
        assets:         mediaAssets.map(a => ({
          hash:          a.hash,
          key:           a.key,
          fileExtension: path.extname(a.localPath),
          contentType:   a.contentType
        })),
        assetCount:     mediaAssets.length,
        publicKey:      appCfg.publicKey,
      };
      const payloadStr = JSON.stringify(payloadObj);

      spin.start("signing bundle hash");
      const signature = await signPayload(payloadStr, privateKey);
      spin.stop(`signed  ${c.dim}${signature.slice(0, 20)}…${c.reset}`);

      if (options.dryRun) {
        console.log(`  ${c.yellow}dry-run${c.reset}   upload skipped`);
        continue;
      }

      spin.start("uploading release to server");
      const bundleBuffer = fs.readFileSync(bundlePath);
      const form = new FormData();
      form.append("bundle",    new Blob([bundleBuffer], { type: "application/javascript" }), `bundle-${platform}.hbc`);
      form.append("payload",   payloadStr);
      form.append("signature", signature);
      form.append("platform",  platform);

      let response: Response;
      try {
        response = await fetch(uploadUrl, {
          method:  "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(projectId ? { "X-Project-Id": projectId } : {})
          },
          body: form,
        });
      } catch (uploadNetErr: any) {
        spin.fail("Upload connection failed");
        const diag = diagnoseNetworkError(uploadNetErr, serverUrl);
        printErrorBox(diag.title, diag.reason, diag.solution);
        process.exit(1);
      }

      if (!response.ok) {
        const text = await response.text();
        spin.fail(`Upload failed (HTTP ${response.status})`);
        if (response.status === 401) {
          printErrorBox(
            "Authentication expired",
            "Your session token is no longer valid.",
            `Run ${c.cyan}edge-ota login${c.reset} to refresh your credentials.`
          );
        } else if (response.status === 403) {
          printErrorBox(
            "Permission denied",
            text || `You do not have permission to publish updates to project ${projectId}.`,
            `Check your team role on ${c.bold}https://ota.renbo.site${c.reset} or verify API key permissions.`
          );
        } else if (response.status === 404) {
          printErrorBox(
            "Project not found on server",
            `Project ID "${projectId}" was not found at ${serverUrl}.`,
            `Run ${c.cyan}edge-ota init${c.reset} to re-associate with an existing project or create a new one.`
          );
        } else if (response.status === 413) {
          printErrorBox(
            "Payload too large",
            "The bundle file exceeds server upload size limits.",
            "Consider optimizing your bundle, removing large embedded media, or adjusting server body limit."
          );
        } else {
          printErrorBox(`Server returned HTTP ${response.status}`, text, "Check server logs or try again shortly.");
        }
        process.exit(1);
      }

      const body = await response.json().catch(() => ({})) as any;
      spin.stop("uploaded");

      const runtimesDisplay = body.runtimeVersions ? body.runtimeVersions.join(", ") : runtimeVersion;
      console.log(`  ${c.green}✓${c.reset}  deployed`);
      console.log(`  id         ${c.dim}${body.updateId || "—"}${c.reset}`);
      console.log(`  channel    ${options.channel}`);
      console.log(`  runtime(s) ${runtimesDisplay}`);
      if (mediaAssets.length > 0) {
        console.log(`  assets     ${mediaAssets.length} static asset(s) linked`);
      }
    }

    console.log(`\n${sep}`);
    console.log(`  ${c.green}✓${c.reset}  ${c.bold}done${c.reset}  ${c.dim}update will be applied on next OTA sync${c.reset}`);
    console.log(`${sep}\n`);
    process.exit(0);
  });

// ──────────────────────────────────────────────────────────────────────────────
// edge-ota status
// ──────────────────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("List recent deployments and active release status for this project")
  .option("-n, --limit <n>", "Number of releases to show", "10")
  .addHelpText("after", `
${c.bold}Examples:${c.reset}
  $ ${c.cyan}edge-ota status${c.reset}                         Show the last 10 releases
  $ ${c.cyan}edge-ota status -n 25${c.reset}                   Show the last 25 releases
`)
  .action(async (options) => {
    printBanner();

    const token = resolveToken();
    if (!token) {
      printErrorBox(
        "Not logged in",
        "Authentication is required to query release status.",
        `Run ${c.cyan}edge-ota login${c.reset} first.`
      );
      process.exit(1);
    }

    const cwd    = process.cwd();
    const appCfg = readAppJson(cwd);
    const { serverUrl, projectId } = appCfg;

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (projectId) headers["x-project-id"] = projectId;

    spin.start("fetching releases from server");

    let res: Response;
    try {
      res = await fetch(`${serverUrl}/api/releases`, { headers });
    } catch (e: any) {
      spin.fail("Connection failed");
      const diag = diagnoseNetworkError(e, serverUrl);
      printErrorBox(diag.title, diag.reason, diag.solution);
      process.exit(1);
    }

    if (!res.ok) {
      spin.fail(`Failed to fetch releases (HTTP ${res.status})`);
      printErrorBox(
        `Server returned HTTP ${res.status}`,
        res.statusText,
        `Verify that project "${projectId}" exists and your token has view permissions.`
      );
      process.exit(1);
    }

    const releases = await res.json() as any[];
    spin.stop();

    if (!releases.length) {
      console.log(`  ${c.dim}No releases found for project "${projectId}".${c.reset}`);
      console.log(`  Run ${c.cyan}edge-ota push${c.reset} to publish your first OTA release!\n`);
      process.exit(0);
    }

    const limit = parseInt(options.limit);
    const rows = releases.slice(0, limit).map((r: any) => ({
      ID:        r.id?.slice(0, 8) ?? "—",
      Channel:   r.channel ?? "—",
      Runtime:   r.runtime ?? "—",
      Platform:  r.platform ?? "all",
      Created:   r.created_at ? new Date(r.created_at).toLocaleString() : "—",
    }));

    console.table(rows);
    console.log();
    process.exit(0);
  });

// ──────────────────────────────────────────────────────────────────────────────
// edge-ota keygen
// ──────────────────────────────────────────────────────────────────────────────

program
  .command("keygen")
  .description("Generate a fresh ECDSA P-256 key pair for code signing")
  .addHelpText("after", `
${c.bold}What to do with these keys:${c.reset}
  1. ${c.bold}Private Key:${c.reset} Store securely in ${c.dim}~/.config/edge-ota/keys/<projectId>.key${c.reset}
     or set in your CI/CD secrets for automated pushes.
  2. ${c.bold}Public Key:${c.reset}  Save in your project settings on the dashboard (${DEFAULT_SERVER})
     or paste into ${c.dim}app.json${c.reset} under ${c.dim}expo.extra.edgeOtaPublicKey${c.reset}.
`)
  .action(async () => {
    const keys = await generateECDSAKeyPair();
    const sep  = `${c.dim}${"─".repeat(56)}${c.reset}`;
    console.log(`\n${sep}`);
    console.log(`  ${c.bold}PRIVATE KEY${c.reset}  ${c.red}(Keep Secret — Never Commit to Git)${c.reset}`);
    console.log(sep);
    console.log(keys.privateKey);
    console.log(`\n${sep}`);
    console.log(`  ${c.bold}PUBLIC KEY${c.reset}   ${c.green}(Paste into Dashboard → Settings → Code Signing)${c.reset}`);
    console.log(sep);
    console.log(keys.publicKey);
    console.log(`${sep}\n`);
    process.exit(0);
  });

await checkAndAutoUpdate();
program.parse(process.argv);
