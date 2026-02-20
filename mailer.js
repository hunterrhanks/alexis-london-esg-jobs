// ============================================================
// Daily Digest Email
// Sends the top 5 new ESG roles found today via Nodemailer.
// Supports SMTP (Gmail, Outlook, etc.) and SendGrid.
// ============================================================

const nodemailer = require("nodemailer");
const db = require("./db");

/**
 * Build the transporter from environment variables.
 *
 * Supports two modes:
 *   1. SMTP: set EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS
 *   2. SendGrid: set SENDGRID_API_KEY
 *
 * For Gmail: EMAIL_HOST=smtp.gmail.com EMAIL_PORT=587
 *            EMAIL_USER=you@gmail.com   EMAIL_PASS=your-app-password
 */
function createTransport() {
  if (process.env.SENDGRID_API_KEY) {
    return nodemailer.createTransport({
      host: "smtp.sendgrid.net",
      port: 587,
      auth: {
        user: "apikey",
        pass: process.env.SENDGRID_API_KEY,
      },
    });
  }

  if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    return nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT) || 587,
      secure: (parseInt(process.env.EMAIL_PORT) || 587) === 465,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }

  return null;
}

/**
 * Send the Daily Digest email with the top 5 new jobs.
 */
async function sendDailyDigest() {
  const recipientEmail = process.env.DIGEST_EMAIL;
  if (!recipientEmail) {
    console.log("  [Mailer] No DIGEST_EMAIL configured, skipping digest.");
    return;
  }

  const transport = createTransport();
  if (!transport) {
    console.log("  [Mailer] No email transport configured. Set EMAIL_HOST/EMAIL_USER/EMAIL_PASS or SENDGRID_API_KEY.");
    return;
  }

  // Get top 5 new jobs by match score
  const topJobs = db.getTopNewJobs(5);
  if (topJobs.length === 0) {
    console.log("  [Mailer] No new jobs found today, skipping digest.");
    return;
  }

  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  const jobRows = topJobs.map((job, i) => {
    const scoreBg = job.match_score >= 70 ? "#0D9B82" : job.match_score >= 40 ? "#D4A843" : "#999";
    const sponsorBadge = job.verified_sponsor
      ? '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:#E8F5E9;color:#2E7D32;">Verified Sponsor</span>'
      : "";
    const visaBadge = job.visa_sponsorship
      ? '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:#FEF3E7;color:#E8763A;">Visa Sponsor</span>'
      : "";
    const remoteBadge = job.remote
      ? '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:#E8F4FA;color:#1B6B93;">Remote</span>'
      : "";

    return `
    <tr>
      <td style="padding:16px 20px;border-bottom:1px solid #eee;">
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <div style="width:36px;height:36px;border-radius:50%;background:${scoreBg};color:white;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${job.match_score}</div>
          <div>
            <a href="${job.url}" style="font-size:15px;font-weight:600;color:#191919;text-decoration:none;">${job.title}</a>
            <div style="font-size:14px;color:#087A66;font-weight:500;margin:2px 0;">${job.company}</div>
            <div style="font-size:12px;color:#999;margin-bottom:6px;">${job.location} ${job.salary ? "· " + job.salary : ""}</div>
            <div style="margin-bottom:6px;">${sponsorBadge} ${visaBadge} ${remoteBadge}</div>
            ${job.ai_summary ? `<div style="font-size:13px;color:#666;line-height:1.5;background:#F9F9F7;padding:8px 10px;border-radius:6px;border-left:3px solid #0D9B82;">${job.ai_summary}</div>` : ""}
          </div>
        </div>
      </td>
    </tr>`;
  }).join("");

  const html = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8" /></head>
  <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F3F2EF;">
    <div style="max-width:600px;margin:0 auto;padding:20px;">
      <div style="background:white;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <!-- Header -->
        <div style="background:linear-gradient(135deg,#0D9B82,#1B6B93);padding:24px 20px;text-align:center;">
          <h1 style="margin:0;color:white;font-size:20px;font-weight:700;">Daily ESG Job Digest</h1>
          <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">${today}</p>
        </div>

        <!-- Greeting -->
        <div style="padding:20px 20px 10px;">
          <p style="font-size:14px;color:#666;margin:0;">Hi Alexis, here are today's top ${topJobs.length} ESG opportunities in London & remote:</p>
        </div>

        <!-- Jobs -->
        <table style="width:100%;border-collapse:collapse;">
          ${jobRows}
        </table>

        <!-- Footer -->
        <div style="padding:16px 20px;text-align:center;border-top:1px solid #eee;">
          <a href="http://localhost:3000" style="display:inline-block;padding:10px 24px;background:#0D9B82;color:white;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">View All Jobs</a>
          <p style="font-size:12px;color:#999;margin-top:12px;">Alexis London ESG Job Board · Updated daily at 6:00 AM GMT</p>
        </div>
      </div>
    </div>
  </body>
  </html>`;

  try {
    const senderEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER || "noreply@alexis-esg-jobs.com";
    await transport.sendMail({
      from: `"Alexis ESG Job Board" <${senderEmail}>`,
      to: recipientEmail,
      subject: `ESG Daily Digest: ${topJobs.length} top roles — ${today}`,
      html,
    });
    console.log(`  [Mailer] Daily digest sent to ${recipientEmail}`);
  } catch (err) {
    console.error("  [Mailer] Send failed:", err.message);
  }
}

module.exports = { sendDailyDigest };
