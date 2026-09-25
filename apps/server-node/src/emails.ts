// Conduit Mail Service & Edge-OTA Brand Email Templates
// Reference: https://conduit.renbo.site/llms-full.txt

const CONDUIT_API_BASE = process.env.CONDUIT_API_BASE || "https://api.conduit.renbo.site";
const CONDUIT_API_KEY = process.env.CONDUIT_API_KEY || "";
const CONDUIT_CHANNEL_ID = process.env.CONDUIT_CHANNEL_ID || "bceb1d1b-8a03-4f56-a68f-2e1f91e613d0";
const DASHBOARD_URL = (process.env.DASHBOARD_URL || "https://ota.renbo.site").replace(/\/$/, "");

export interface ConduitEmailOptions {
  to: string;
  subject: string;
  html: string;
  tag: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  metadata?: Record<string, any>;
}

export function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sends an email via Conduit unified messaging API (`POST /api/v1/send`).
 * Automatically deduplicates `cc` recipients and excludes the primary `to` address.
 */
export async function sendConduitEmail(options: ConduitEmailOptions): Promise<boolean> {
  const { to, subject, html, tag, cc, bcc, replyTo, metadata } = options;

  if (!CONDUIT_API_KEY) {
    console.warn(`[Email:${tag}] No CONDUIT_API_KEY configured — skipping email send to ${to}`);
    return false;
  }

  const normalizedTo = to.trim().toLowerCase();
  const cleanCc = Array.isArray(cc)
    ? Array.from(new Set(cc.map(e => e.trim()).filter(e => e.includes("@") && e.toLowerCase() !== normalizedTo)))
    : [];
  const cleanBcc = Array.isArray(bcc)
    ? Array.from(new Set(bcc.map(e => e.trim()).filter(e => e.includes("@") && e.toLowerCase() !== normalizedTo)))
    : [];
  const cleanReplyTo = Array.isArray(replyTo)
    ? Array.from(new Set(replyTo.map(e => e.trim()).filter(e => e.includes("@"))))
    : [];

  const payload: Record<string, any> = {
    to: to.trim(),
    channel: "email",
    subject,
    message: html,
    sessionId: CONDUIT_CHANNEL_ID,
  };

  if (cleanCc.length > 0) payload.cc = cleanCc;
  if (cleanBcc.length > 0) payload.bcc = cleanBcc;
  if (cleanReplyTo.length > 0) payload.replyTo = cleanReplyTo;
  if (metadata && Object.keys(metadata).length > 0) payload.metadata = metadata;

  try {
    const response = await fetch(`${CONDUIT_API_BASE}/api/v1/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CONDUIT_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Email:${tag}] Conduit API error: ${response.status} — ${text}`);
      return false;
    }

    const ccLog = cleanCc.length > 0 ? ` (cc: ${cleanCc.join(", ")})` : "";
    console.log(`[Email:${tag}] Dispatched to ${to}${ccLog}`);
    return true;
  } catch (err: any) {
    console.error(`[Email:${tag}] Failed to send email: ${err.message}`);
    return false;
  }
}

export type BrandAccent = "green" | "amber" | "red";

export interface BrandLayoutProps {
  preheader: string;
  category: string;
  statusBadge?: string;
  accent?: BrandAccent;
  heading: string;
  bodyHtml: string;
  ctaLabel?: string;
  ctaUrl?: string;
  footerNote?: string;
}

const ACCENT_HEX: Record<BrandAccent, string> = {
  green: "#81C784",
  amber: "#FFAA00",
  red: "#FF6B6B",
};

/**
 * Renders the unified Edge-OTA CRT Terminal email layout matching the dashboard UI.
 */
export function renderBrandEmailLayout(props: BrandLayoutProps): string {
  const accentColor = ACCENT_HEX[props.accent || "green"];
  const statusBadge = props.statusBadge || "SYSTEM // ONLINE";
  const fontStack = "'Share Tech Mono', 'Geist Mono', 'Courier New', Courier, monospace";
  const displayStack = "'VT323', 'Share Tech Mono', 'Courier New', Courier, monospace";

  const ctaSection = props.ctaLabel && props.ctaUrl
    ? `
          <!-- Primary CTA -->
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="background-color:${accentColor};padding:14px 24px;">
                    <a href="${escapeHtml(props.ctaUrl)}" style="font-family:${fontStack};font-size:12px;color:#000000;text-decoration:none;font-weight:bold;letter-spacing:1.5px;display:block;text-transform:uppercase;">
                      ${escapeHtml(props.ctaLabel)} &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:${fontStack};font-size:10px;color:#666666;line-height:16px;">
                    Direct URL: <a href="${escapeHtml(props.ctaUrl)}" style="color:${accentColor};text-decoration:underline;word-break:break-all;">${escapeHtml(props.ctaUrl)}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
    : "";

  const footerNoteSection = props.footerNote
    ? `
          <tr>
            <td style="padding:20px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:${fontStack};font-size:11px;color:#777777;line-height:18px;">
                    ${props.footerNote}
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="en" style="color-scheme:dark;">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=VT323&display=swap" rel="stylesheet">
  <title>${escapeHtml(props.heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:#000000;color:#FFFFFF;font-family:${fontStack};-webkit-font-smoothing:antialiased;">
  <!-- Hidden Preheader -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#000000;">
    ${escapeHtml(props.preheader)}
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#000000;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;width:100%;background-color:#0A0A0A;border:1px solid #333333;border-top:2px solid ${accentColor};">

          <!-- Brand Header Bar -->
          <tr>
            <td style="padding:24px 32px 20px 32px;border-bottom:1px solid #222222;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="left" valign="middle">
                    <a href="${DASHBOARD_URL}" style="text-decoration:none;color:#FFFFFF;font-family:${displayStack};font-size:20px;font-weight:bold;letter-spacing:1px;">
                      <span style="color:#81C784;">&#9618;</span> EDGE-OTA
                    </a>
                  </td>
                  <td align="right" valign="middle">
                    <span style="display:inline-block;border:1px solid #2A2A2A;background-color:#111111;padding:3px 8px;font-family:${fontStack};font-size:9px;color:${accentColor};letter-spacing:1.5px;text-transform:uppercase;font-weight:bold;">
                      &#9679; ${escapeHtml(statusBadge)}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Section Category Breadcrumb -->
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="font-family:${fontStack};font-size:10px;color:#777777;text-transform:uppercase;letter-spacing:2px;">
                    <span style="color:${accentColor};font-weight:bold;">&#9618;</span> // ${escapeHtml(props.category)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Heading -->
          <tr>
            <td style="padding:10px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="font-family:${displayStack};font-size:26px;color:#FFFFFF;font-weight:bold;letter-spacing:0.5px;line-height:30px;">
                    ${escapeHtml(props.heading)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body Content -->
          <tr>
            <td style="padding:16px 32px 0 32px;font-family:${fontStack};font-size:13px;color:#CCCCCC;line-height:21px;">
              ${props.bodyHtml}
            </td>
          </tr>

          ${ctaSection}
          ${footerNoteSection}

          <!-- Divider -->
          <tr>
            <td style="padding:28px 32px 0 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="border-top:1px solid #222222;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Signature Footer -->
          <tr>
            <td style="padding:16px 32px 24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="left" style="font-family:${fontStack};font-size:10px;color:#555555;letter-spacing:1px;">
                    &copy; 2026 <a href="${DASHBOARD_URL}" style="color:#888888;text-decoration:none;">EDGE-OTA</a>
                  </td>
                  <td align="right" style="font-family:${fontStack};font-size:10px;color:#555555;letter-spacing:1px;">
                    BUILT BY <a href="https://renbostudios.com" style="color:#FFFFFF;text-decoration:none;font-weight:bold;">RENBO STUDIOS</a>
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
}

/**
 * Helper to render a terminal key-value metadata table inside an email.
 */
function renderKeyValueBox(rows: Array<{ label: string; value: string; highlight?: BrandAccent }>): string {
  const fontStack = "'Share Tech Mono', 'Geist Mono', 'Courier New', Courier, monospace";
  const rowsHtml = rows
    .map((r, i) => {
      const borderTop = i > 0 ? "border-top:1px solid #1C1C1C;" : "";
      const valColor = r.highlight ? ACCENT_HEX[r.highlight] : "#FFFFFF";
      return `
        <tr>
          <td style="padding:10px 14px;${borderTop}font-family:${fontStack};font-size:10px;color:#777777;text-transform:uppercase;letter-spacing:1px;width:38%;">
            ${escapeHtml(r.label)}
          </td>
          <td style="padding:10px 14px;${borderTop}font-family:${fontStack};font-size:12px;color:${valColor};font-weight:bold;word-break:break-all;">
            ${escapeHtml(r.value)}
          </td>
        </tr>`;
    })
    .join("");

  return `
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:16px;background-color:#000000;border:1px solid #2A2A2A;">
      ${rowsHtml}
    </table>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Account Verification OTP Email
// ─────────────────────────────────────────────────────────────────────────────
export async function sendOtpEmail(email: string, code: string): Promise<boolean> {
  const fontStack = "'Share Tech Mono', 'Geist Mono', 'Courier New', Courier, monospace";
  const bodyHtml = `
    <p style="margin:0 0 16px 0;color:#CCCCCC;">
      Use the 6-digit verification code below to verify <strong style="color:#FFFFFF;">${escapeHtml(email)}</strong> on your Edge-OTA console.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#000000;border:1px solid #81C784;padding:20px 24px;text-align:center;">
      <tr>
        <td style="font-family:${fontStack};font-size:10px;color:#81C784;text-transform:uppercase;letter-spacing:2px;text-align:center;padding-bottom:10px;font-weight:bold;">
          VERIFICATION CODE
        </td>
      </tr>
      <tr>
        <td style="font-family:${fontStack};font-size:32px;color:#FFFFFF;letter-spacing:8px;text-align:center;font-weight:bold;">
          ${escapeHtml(code)}
        </td>
      </tr>
    </table>`;

  const html = renderBrandEmailLayout({
    preheader: `Your Edge-OTA verification code is ${code}`,
    category: "EMAIL VERIFICATION",
    statusBadge: "AUTH // OTP",
    accent: "green",
    heading: "VERIFY YOUR EMAIL ADDRESS",
    bodyHtml,
    footerNote: "This verification code expires in <strong style=\"color:#FFFFFF;\">10 minutes</strong>. If you did not request this code, you can safely ignore this email.",
  });

  return sendConduitEmail({
    to: email,
    subject: `${code} is your verification code — Edge-OTA`,
    html,
    tag: "OTP",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Password Reset OTP Email
// ─────────────────────────────────────────────────────────────────────────────
export async function sendPasswordResetOtpEmail(email: string, code: string): Promise<boolean> {
  const fontStack = "'Share Tech Mono', 'Geist Mono', 'Courier New', Courier, monospace";
  const bodyHtml = `
    <p style="margin:0 0 16px 0;color:#CCCCCC;">
      A password reset was requested for your Edge-OTA account (<strong style="color:#FFFFFF;">${escapeHtml(email)}</strong>). Enter the recovery code below to set a new password:
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#000000;border:1px solid #FFAA00;padding:20px 24px;text-align:center;">
      <tr>
        <td style="font-family:${fontStack};font-size:10px;color:#FFAA00;text-transform:uppercase;letter-spacing:2px;text-align:center;padding-bottom:10px;font-weight:bold;">
          PASSWORD RECOVERY CODE
        </td>
      </tr>
      <tr>
        <td style="font-family:${fontStack};font-size:32px;color:#FFFFFF;letter-spacing:8px;text-align:center;font-weight:bold;">
          ${escapeHtml(code)}
        </td>
      </tr>
    </table>`;

  const html = renderBrandEmailLayout({
    preheader: `Your Edge-OTA password reset code is ${code}`,
    category: "ACCOUNT RECOVERY",
    statusBadge: "SECURITY // RESET",
    accent: "amber",
    heading: "RESET YOUR PASSWORD",
    bodyHtml,
    ctaLabel: "OPEN PASSWORD RESET",
    ctaUrl: `${DASHBOARD_URL}/forgot-password?email=${encodeURIComponent(email)}`,
    footerNote: "This recovery code expires in <strong style=\"color:#FFFFFF;\">10 minutes</strong>. If you did not request a password reset, no changes have been made to your account.",
  });

  return sendConduitEmail({
    to: email,
    subject: `${code} — Reset your Edge-OTA password`,
    html,
    tag: "PasswordResetOTP",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Password Changed Confirmation Email
// ─────────────────────────────────────────────────────────────────────────────
export async function sendPasswordChangedEmail(email: string): Promise<boolean> {
  const bodyHtml = `
    <p style="margin:0 0 12px 0;color:#CCCCCC;">
      The password for your Edge-OTA account (<strong style="color:#FFFFFF;">${escapeHtml(email)}</strong>) was just updated, and all previous sessions have been signed out.
    </p>
    ${renderKeyValueBox([
      { label: "Account", value: email },
      { label: "Action", value: "Password Updated & Sessions Rotated", highlight: "green" },
      { label: "Timestamp", value: new Date().toUTCString() },
    ])}`;

  const html = renderBrandEmailLayout({
    preheader: "Your Edge-OTA account password has been updated.",
    category: "SECURITY AUDIT",
    statusBadge: "AUTH // UPDATED",
    accent: "green",
    heading: "PASSWORD UPDATED SUCCESSFULLY",
    bodyHtml,
    ctaLabel: "SIGN IN TO CONSOLE",
    ctaUrl: `${DASHBOARD_URL}/login`,
    footerNote: "If you did not perform this change, reset your password immediately at <a href=\"" + DASHBOARD_URL + "/forgot-password\" style=\"color:#FF6B6B;\">" + DASHBOARD_URL + "/forgot-password</a>.",
  });

  return sendConduitEmail({
    to: email,
    subject: "Security Alert: Your Edge-OTA password was changed",
    html,
    tag: "PasswordChanged",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Post-Verification Welcome Email
// ─────────────────────────────────────────────────────────────────────────────
export async function sendWelcomeEmail(email: string): Promise<boolean> {
  const fontStack = "'Share Tech Mono', 'Geist Mono', 'Courier New', Courier, monospace";
  const bodyHtml = `
    <p style="margin:0 0 16px 0;color:#CCCCCC;">
      Your account (<strong style="color:#81C784;">${escapeHtml(email)}</strong>) is verified and ready. Deploy cryptographically signed Expo React Native OTA updates with zero egress fees in 3 commands:
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#000000;border:1px solid #2A2A2A;padding:16px;">
      <tr>
        <td style="font-family:${fontStack};font-size:10px;color:#81C784;text-transform:uppercase;letter-spacing:1.5px;padding-bottom:8px;font-weight:bold;">
          // TERMINAL QUICKSTART
        </td>
      </tr>
      <tr>
        <td style="font-family:${fontStack};font-size:12px;color:#FFFFFF;line-height:22px;">
          <span style="color:#555555;">$</span> npm i -g @renbostudios/edge-ota<br>
          <span style="color:#555555;">$</span> edge-ota login<br>
          <span style="color:#555555;">$</span> edge-ota init<br>
          <span style="color:#555555;">$</span> edge-ota push --channel production
        </td>
      </tr>
    </table>`;

  const html = renderBrandEmailLayout({
    preheader: "Welcome to Edge-OTA — Zero-SDK OTA Updates for Expo React Native.",
    category: "SYSTEM ONBOARDING",
    statusBadge: "ACCOUNT // VERIFIED",
    accent: "green",
    heading: "WELCOME TO EDGE-OTA",
    bodyHtml,
    ctaLabel: "LAUNCH CONSOLE",
    ctaUrl: `${DASHBOARD_URL}/onboarding`,
    footerNote: "Need help pairing your Expo app? Read the <a href=\"" + DASHBOARD_URL + "/docs\" style=\"color:#81C784;\">protocol documentation</a>.",
  });

  return sendConduitEmail({
    to: email,
    subject: "Welcome to Edge-OTA — Quickstart Guide",
    html,
    tag: "Welcome",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Team Member Invitation Email (with CC to inviter / team)
// ─────────────────────────────────────────────────────────────────────────────
export async function sendInviteEmail(
  email: string,
  inviterEmail: string,
  projectName: string,
  role: string,
  inviteToken: string,
  ccEmails: string[] = []
): Promise<boolean> {
  const acceptUrl = `${DASHBOARD_URL}/team/accept?token=${encodeURIComponent(inviteToken)}`;
  const roleDisplay = role.toUpperCase();

  const bodyHtml = `
    <p style="margin:0 0 14px 0;color:#CCCCCC;">
      <strong style="color:#81C784;">${escapeHtml(inviterEmail)}</strong> has invited you to collaborate on the project <strong style="color:#FFAA00;">${escapeHtml(projectName)}</strong> on Edge-OTA.
    </p>
    ${renderKeyValueBox([
      { label: "Project", value: projectName, highlight: "amber" },
      { label: "Invited By", value: inviterEmail, highlight: "green" },
      { label: "Access Role", value: roleDisplay },
      { label: "Recipient", value: email },
    ])}`;

  const html = renderBrandEmailLayout({
    preheader: `${inviterEmail} invited you to join ${projectName} on Edge-OTA`,
    category: "TEAM INVITATION",
    statusBadge: `ROLE // ${roleDisplay}`,
    accent: "green",
    heading: `JOIN ${projectName.toUpperCase()}`,
    bodyHtml,
    ctaLabel: "ACCEPT INVITATION",
    ctaUrl: acceptUrl,
    footerNote: "This invitation expires in <strong style=\"color:#FFFFFF;\">7 days</strong>. The inviter has been CC'd on this dispatch.",
  });

  const ccList = [inviterEmail, ...ccEmails].filter(Boolean);

  return sendConduitEmail({
    to: email,
    subject: `You're invited to ${projectName} — Edge-OTA`,
    html,
    tag: "TeamInvite",
    cc: ccList,
    replyTo: inviterEmail ? [inviterEmail] : undefined,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Team Invitation Accepted Notification (to Owner + CC team)
// ─────────────────────────────────────────────────────────────────────────────
export async function sendInviteAcceptedEmail(
  ownerEmail: string,
  memberEmail: string,
  projectName: string,
  role: string,
  ccEmails: string[] = []
): Promise<boolean> {
  const bodyHtml = `
    <p style="margin:0 0 14px 0;color:#CCCCCC;">
      <strong style="color:#81C784;">${escapeHtml(memberEmail)}</strong> has accepted the invitation to join <strong style="color:#FFAA00;">${escapeHtml(projectName)}</strong>.
    </p>
    ${renderKeyValueBox([
      { label: "Project", value: projectName, highlight: "amber" },
      { label: "New Member", value: memberEmail, highlight: "green" },
      { label: "Assigned Role", value: role.toUpperCase() },
      { label: "Status", value: "ACTIVE", highlight: "green" },
    ])}`;

  const html = renderBrandEmailLayout({
    preheader: `${memberEmail} joined ${projectName} on Edge-OTA`,
    category: "TEAM ACCESS UPDATE",
    statusBadge: "MEMBER // ACTIVE",
    accent: "green",
    heading: "TEAM INVITATION ACCEPTED",
    bodyHtml,
    ctaLabel: "MANAGE TEAM",
    ctaUrl: `${DASHBOARD_URL}/settings`,
  });

  return sendConduitEmail({
    to: ownerEmail,
    subject: `${memberEmail} joined ${projectName} — Edge-OTA`,
    html,
    tag: "TeamInviteAccepted",
    cc: [memberEmail, ...ccEmails],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Team Member Removed Notification (with CC to Owner / Team)
// ─────────────────────────────────────────────────────────────────────────────
export async function sendMemberRemovedEmail(
  memberEmail: string,
  projectName: string,
  ownerEmail?: string,
  ccEmails: string[] = []
): Promise<boolean> {
  const bodyHtml = `
    <p style="margin:0 0 14px 0;color:#CCCCCC;">
      Your team access to project <strong style="color:#FFAA00;">${escapeHtml(projectName)}</strong> on Edge-OTA has been revoked by the workspace administrator.
    </p>
    ${renderKeyValueBox([
      { label: "Project", value: projectName },
      { label: "Account", value: memberEmail },
      { label: "Status", value: "ACCESS REVOKED", highlight: "red" },
    ])}`;

  const html = renderBrandEmailLayout({
    preheader: `Your access to ${projectName} on Edge-OTA has been removed`,
    category: "TEAM ACCESS UPDATE",
    statusBadge: "ACCESS // REVOKED",
    accent: "red",
    heading: "PROJECT ACCESS REMOVED",
    bodyHtml,
    footerNote: "If you believe this was a mistake, please contact your project administrator.",
  });

  const ccList = [...(ownerEmail ? [ownerEmail] : []), ...ccEmails];

  return sendConduitEmail({
    to: memberEmail,
    subject: `Access removed for ${projectName} — Edge-OTA`,
    html,
    tag: "TeamMemberRemoved",
    cc: ccList,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Pro Tier Trial Activated Email (with CC to Team)
// ─────────────────────────────────────────────────────────────────────────────
export async function sendProTrialActivatedEmail(
  email: string,
  projectName: string,
  trialEndsAt: string,
  ccEmails: string[] = []
): Promise<boolean> {
  const formattedEnd = new Date(trialEndsAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const bodyHtml = `
    <p style="margin:0 0 14px 0;color:#CCCCCC;">
      Complimentary <strong style="color:#FFAA00;">30-Day Pro Tier</strong> access is now active for project <strong style="color:#FFFFFF;">${escapeHtml(projectName)}</strong>.
    </p>
    ${renderKeyValueBox([
      { label: "Project", value: projectName },
      { label: "Plan Tier", value: "PRO TIER (30-DAY TRIAL)", highlight: "amber" },
      { label: "MAU Quota", value: "250,000 MAU / month", highlight: "green" },
      { label: "Edge Bandwidth", value: "UNLIMITED (Zero Egress)", highlight: "green" },
      { label: "Trial Valid Until", value: formattedEnd },
    ])}`;

  const html = renderBrandEmailLayout({
    preheader: `Pro Tier (30-Day Trial) activated for ${projectName}`,
    category: "BILLING & QUOTAS",
    statusBadge: "PLAN // PRO TRIAL",
    accent: "amber",
    heading: "PRO TIER ACTIVATED",
    bodyHtml,
    ctaLabel: "VIEW QUOTAS & ANALYTICS",
    ctaUrl: `${DASHBOARD_URL}/analytics`,
  });

  return sendConduitEmail({
    to: email,
    subject: `Pro Tier Activated for ${projectName} — Edge-OTA`,
    html,
    tag: "ProTrialActivated",
    cc: ccEmails,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Pro Tier Trial Expired Email (with CC to Team)
// ─────────────────────────────────────────────────────────────────────────────
export async function sendProTrialExpiredEmail(
  email: string,
  projectName: string,
  ccEmails: string[] = []
): Promise<boolean> {
  const bodyHtml = `
    <p style="margin:0 0 14px 0;color:#CCCCCC;">
      The 30-day Pro Trial for project <strong style="color:#FFFFFF;">${escapeHtml(projectName)}</strong> has ended. Your workspace has transitioned to the standard Free Tier limits.
    </p>
    ${renderKeyValueBox([
      { label: "Project", value: projectName },
      { label: "Current Plan", value: "FREE TIER", highlight: "amber" },
      { label: "MAU Limit", value: "20,000 MAU / month" },
      { label: "Bandwidth Quota", value: "200 GB" },
    ])}`;

  const html = renderBrandEmailLayout({
    preheader: `Your 30-day Pro Trial for ${projectName} has ended`,
    category: "BILLING & QUOTAS",
    statusBadge: "PLAN // FREE TIER",
    accent: "amber",
    heading: "PRO TRIAL ENDED",
    bodyHtml,
    ctaLabel: "MANAGE BILLING",
    ctaUrl: `${DASHBOARD_URL}/settings`,
  });

  return sendConduitEmail({
    to: email,
    subject: `Pro Trial ended for ${projectName} — Edge-OTA`,
    html,
    tag: "ProTrialExpired",
    cc: ccEmails,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. API Deploy Key Created / Revoked Security Alert
// ─────────────────────────────────────────────────────────────────────────────
export async function sendApiKeyAlertEmail(
  email: string,
  action: "created" | "revoked",
  label: string,
  prefix: string,
  scope: string
): Promise<boolean> {
  const isCreated = action === "created";
  const bodyHtml = `
    <p style="margin:0 0 14px 0;color:#CCCCCC;">
      A CI/CD API deploy token was <strong style="color:${isCreated ? "#81C784" : "#FF6B6B"};">${action}</strong> on your Edge-OTA account.
    </p>
    ${renderKeyValueBox([
      { label: "Token Label", value: label },
      { label: "Key Prefix", value: prefix },
      { label: "Scope", value: scope },
      { label: "Status", value: isCreated ? "ACTIVE" : "REVOKED", highlight: isCreated ? "green" : "red" },
      { label: "Timestamp", value: new Date().toUTCString() },
    ])}`;

  const html = renderBrandEmailLayout({
    preheader: `API key "${label}" (${prefix}) was ${action} on your Edge-OTA account`,
    category: "ACCESS CONTROL",
    statusBadge: isCreated ? "KEY // CREATED" : "KEY // REVOKED",
    accent: isCreated ? "green" : "red",
    heading: isCreated ? "NEW API KEY GENERATED" : "API KEY REVOKED",
    bodyHtml,
    ctaLabel: "AUDIT API KEYS",
    ctaUrl: `${DASHBOARD_URL}/keys`,
    footerNote: "If you did not authorize this action, revoke the credential immediately in your console.",
  });

  return sendConduitEmail({
    to: email,
    subject: `Security Notice: API Key "${label}" ${action} — Edge-OTA`,
    html,
    tag: `ApiKey_${action}`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Project ECDSA Public Key Updated Security Alert (with CC to Team)
// ─────────────────────────────────────────────────────────────────────────────
export async function sendPublicKeyUpdatedEmail(
  email: string,
  projectName: string,
  ccEmails: string[] = []
): Promise<boolean> {
  const bodyHtml = `
    <p style="margin:0 0 14px 0;color:#CCCCCC;">
      The <strong style="color:#FFFFFF;">ECDSA P-256 Public Key Certificate</strong> for project <strong style="color:#FFAA00;">${escapeHtml(projectName)}</strong> was updated. All subsequent OTA bundle uploads will be verified against this new key.
    </p>
    ${renderKeyValueBox([
      { label: "Project", value: projectName, highlight: "amber" },
      { label: "Certificate", value: "ECDSA P-256 (SHA-256)", highlight: "green" },
      { label: "Updated At", value: new Date().toUTCString() },
    ])}`;

  const html = renderBrandEmailLayout({
    preheader: `ECDSA P-256 signing public key updated for ${projectName}`,
    category: "CRYPTOGRAPHIC SECURITY",
    statusBadge: "SIGNING // UPDATED",
    accent: "amber",
    heading: "CODE-SIGNING KEY UPDATED",
    bodyHtml,
    ctaLabel: "REVIEW PROJECT SETTINGS",
    ctaUrl: `${DASHBOARD_URL}/settings`,
    footerNote: "Remember to run <code style=\"color:#FFFFFF;\">npx expo prebuild --clean</code> if your native binary public key changed.",
  });

  return sendConduitEmail({
    to: email,
    subject: `Code-signing public key updated for ${projectName} — Edge-OTA`,
    html,
    tag: "PublicKeyUpdated",
    cc: ccEmails,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Production Release Deployed / Rolled Back Email (with CC to Team)
// ─────────────────────────────────────────────────────────────────────────────
export async function sendProductionDeployEmail(
  ownerEmail: string,
  projectName: string,
  info: {
    releaseId: string;
    channel: string;
    runtimes: string[];
    platform: string;
    bundleHash: string;
    isRollback?: boolean;
    rolledBackFrom?: string;
  },
  ccEmails: string[] = []
): Promise<boolean> {
  const isRollback = Boolean(info.isRollback);
  const shortId = info.releaseId.slice(0, 8);
  const rows: Array<{ label: string; value: string; highlight?: BrandAccent }> = [
    { label: "Project", value: projectName },
    { label: "Release ID", value: `#${shortId} (${info.releaseId})`, highlight: isRollback ? "amber" : "green" },
    { label: "Channel", value: `/${info.channel}`, highlight: "green" },
    { label: "Runtime(s)", value: info.runtimes.join(", ") },
    { label: "Platform", value: info.platform.toUpperCase() },
    { label: "Bundle SHA-256", value: `${info.bundleHash.slice(0, 24)}...` },
  ];

  if (isRollback && info.rolledBackFrom) {
    rows.push({ label: "Rolled Back Target", value: `#${info.rolledBackFrom.slice(0, 8)}`, highlight: "amber" });
  }

  const bodyHtml = `
    <p style="margin:0 0 14px 0;color:#CCCCCC;">
      ${
        isRollback
          ? `A console rollback was executed on <strong style="color:#FFAA00;">${escapeHtml(projectName)}</strong>, restoring a known-good bundle on channel <strong style="color:#FFFFFF;">/${escapeHtml(info.channel)}</strong>.`
          : `A new signed OTA update has been published to <strong style="color:#81C784;">/${escapeHtml(info.channel)}</strong> for project <strong style="color:#FFFFFF;">${escapeHtml(projectName)}</strong>.`
      }
    </p>
    ${renderKeyValueBox(rows)}`;

  const html = renderBrandEmailLayout({
    preheader: `${isRollback ? "Rollback" : "Release"} #${shortId} live on /${info.channel} for ${projectName}`,
    category: isRollback ? "RELEASE ROLLBACK" : "PRODUCTION DEPLOYMENT",
    statusBadge: isRollback ? "OTA // ROLLBACK" : "OTA // LIVE",
    accent: isRollback ? "amber" : "green",
    heading: isRollback ? `ROLLBACK DEPLOYED (#${shortId})` : `RELEASE #${shortId} PUBLISHED`,
    bodyHtml,
    ctaLabel: "INSPECT RELEASE",
    ctaUrl: `${DASHBOARD_URL}/releases/${encodeURIComponent(info.releaseId)}`,
  });

  return sendConduitEmail({
    to: ownerEmail,
    subject: `${isRollback ? "[Rollback]" : "[Deployed]"} ${projectName} #${shortId} on /${info.channel} — Edge-OTA`,
    html,
    tag: isRollback ? "ReleaseRollback" : "ProductionDeploy",
    cc: ccEmails,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. Fatal OTA Client Crash Alert (`expo-fatal-error`) (with CC to Team)
// ─────────────────────────────────────────────────────────────────────────────
export async function sendFatalCrashAlertEmail(
  ownerEmail: string,
  projectName: string,
  crash: {
    channel: string;
    platform: string;
    runtimeVersion: string;
    currentUpdateId?: string;
    fatalError: string;
  },
  ccEmails: string[] = []
): Promise<boolean> {
  const bodyHtml = `
    <p style="margin:0 0 14px 0;color:#CCCCCC;">
      A native client device reported an <code style="color:#FF6B6B;">expo-fatal-error</code> header during OTA handshake for project <strong style="color:#FFFFFF;">${escapeHtml(projectName)}</strong>.
    </p>
    ${renderKeyValueBox([
      { label: "Project", value: projectName },
      { label: "Channel", value: `/${crash.channel}` },
      { label: "Platform", value: crash.platform.toUpperCase() },
      { label: "Runtime Version", value: crash.runtimeVersion },
      { label: "Update ID", value: crash.currentUpdateId || "embedded" },
      { label: "Fatal Error", value: crash.fatalError.slice(0, 300), highlight: "red" },
    ])}`;

  const html = renderBrandEmailLayout({
    preheader: `OTA crash reported on ${projectName} (/${crash.channel})`,
    category: "CRASH TELEMETRY ALERT",
    statusBadge: "ALERT // FATAL ERROR",
    accent: "red",
    heading: "OTA FATAL ERROR REPORTED",
    bodyHtml,
    ctaLabel: "OPEN RELEASES & ROLLBACK",
    ctaUrl: `${DASHBOARD_URL}/releases`,
    footerNote: "You can immediately roll back to a previous known-good release from the Edge-OTA Releases console.",
  });

  return sendConduitEmail({
    to: ownerEmail,
    subject: `[ALERT] OTA Fatal Crash detected on ${projectName} — Edge-OTA`,
    html,
    tag: "FatalCrashAlert",
    cc: ccEmails,
  });
}
