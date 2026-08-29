import { Resend } from "resend";

// ---- Config (all per-client settings come from env vars — never edit this file per client) ----
// Required:
//   RESEND_API_KEY  - secret API key from resend.com
//   CONTACT_EMAIL   - inbox that receives enquiries (e.g. glowingleads.au@gmail.com)
//   FROM_EMAIL      - verified sender address on your Resend domain (e.g. noreply@glowingleads.com.au)
// Optional:
//   FROM_NAME       - display name for the sender (defaults to SITE_NAME, then "Website")
//   SITE_NAME       - used in FROM_NAME fallback and the email subject line

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX = 5; // max submissions per IP per window
const MIN_SUBMIT_TIME_MS = 1500; // faster than this since page load is treated as a bot

// Best-effort only: this lives in the function instance's memory, so it
// resets on cold start and isn't shared across concurrent instances. It's a
// cheap first line of defense against basic bots, not a hard guarantee — a
// shared store (e.g. Upstash Redis) would be needed for real rate limiting.
const submissionsByIp = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (submissionsByIp.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  submissionsByIp.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitize(value) {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim() : "";
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const { RESEND_API_KEY, CONTACT_EMAIL, FROM_EMAIL, FROM_NAME, SITE_NAME } = process.env;

  if (!RESEND_API_KEY || !CONTACT_EMAIL || !FROM_EMAIL) {
    console.error("Contact form: missing RESEND_API_KEY, CONTACT_EMAIL, or FROM_EMAIL env var.");
    return res.status(500).json({ ok: false, error: "Server is not configured to send email." });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: "Too many requests. Please try again later." });
  }

  const body = req.body || {};

  // Honeypot + timing check: real visitors never fill the hidden "website"
  // field and can't submit faster than a human can type. Bots that trip
  // either get a fake success so they don't learn to adapt.
  if (sanitize(body.website)) {
    return res.status(200).json({ ok: true });
  }
  const startedAt = Number(body.startedAt);
  if (Number.isFinite(startedAt) && Date.now() - startedAt < MIN_SUBMIT_TIME_MS) {
    return res.status(200).json({ ok: true });
  }

  const name = sanitize(body.name);
  const email = sanitize(body.email);
  const phone = sanitize(body.phone);
  const company = sanitize(body.company);
  const message = typeof body.message === "string" ? body.message.trim() : "";

  const errors = {};
  if (!name || name.length < 2) errors.name = "Please enter your name.";
  if (!email || !EMAIL_RE.test(email)) errors.email = "Please enter a valid email address.";
  if (!message || message.length < 10) errors.message = "Please enter a message (at least 10 characters).";
  if (message.length > 5000) errors.message = "Message is too long.";

  if (Object.keys(errors).length) {
    return res.status(400).json({ ok: false, error: "Please check the form and try again.", fields: errors });
  }

  const fromName = FROM_NAME || SITE_NAME || "Website";
  const subject = `New enquiry from ${name}${company ? ` (${company})` : ""}${SITE_NAME ? ` — ${SITE_NAME}` : ""}`;

  const rows = [
    ["Name", name],
    ["Email", email],
    ["Phone", phone || "—"],
    ["Business name", company || "—"],
  ];

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:15px;color:#111;line-height:1.5;">
      <h2 style="margin:0 0 16px;">New website enquiry</h2>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
        ${rows.map(([label, value]) => `
          <tr>
            <td style="font-weight:600;vertical-align:top;padding-right:12px;">${escapeHtml(label)}</td>
            <td>${escapeHtml(value)}</td>
          </tr>`).join("")}
      </table>
      <p style="font-weight:600;margin:20px 0 6px;">Message</p>
      <p style="white-space:pre-wrap;margin:0;">${escapeHtml(message)}</p>
    </div>
  `;

  const text = [...rows.map(([label, value]) => `${label}: ${value}`), "", "Message:", message].join("\n");

  try {
    const resend = new Resend(RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: `${fromName} <${FROM_EMAIL}>`,
      to: [CONTACT_EMAIL],
      replyTo: email,
      subject,
      html,
      text,
    });

    if (error) {
      console.error("Resend error:", error);
      return res.status(502).json({ ok: false, error: "Could not send your message. Please try again." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Contact form send failed:", err);
    return res.status(500).json({ ok: false, error: "Could not send your message. Please try again." });
  }
}
