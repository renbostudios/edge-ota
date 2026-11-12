#!/usr/bin/env node
/**
 * Sends the renbo.dev migration announcement to every verified account.
 *
 * Defaults to a dry-run (lists recipients only). Pass --send to actually queue
 * the emails through Conduit.
 *
 * Run inside the deployed API container so DATABASE_URL / CONDUIT_* are present:
 *   docker exec edge-ota-backend node apps/server-node/scripts/send-migration-email.mjs
 *   docker exec edge-ota-backend node apps/server-node/scripts/send-migration-email.mjs --send
 */
import { Client } from "pg";
import { sendDomainMigrationEmail } from "../dist/emails.js";

const SEND = process.argv.includes("--send");
const INTERNAL_DOMAINS = new Set(["edge-ota.local"]);

function isInternal(email) {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return INTERNAL_DOMAINS.has(domain) || email === process.env.ADMIN_EMAIL;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — run this inside the API container.");
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const { rows } = await client.query(
    "select email from users where email_verified = 1 order by email"
  );
  await client.end();

  const recipients = rows.map((r) => r.email).filter((e) => !isInternal(e));
  const skipped = rows.length - recipients.length;

  console.log(`\n  migration email → ${recipients.length} verified recipient(s)`);
  if (skipped > 0) console.log(`  skipped ${skipped} internal/seed account(s)`);
  recipients.forEach((e) => console.log(`   · ${e}`));

  if (!SEND) {
    console.log("\n  dry run — re-run with --send to deliver\n");
    return;
  }

  let sent = 0;
  let failed = 0;
  for (const email of recipients) {
    const ok = await sendDomainMigrationEmail(email);
    if (ok) sent++;
    else failed++;
    console.log(`  ${ok ? "✓" : "✗"} ${email}`);
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n  done: ${sent} sent, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
