import nodemailer from "nodemailer";
import { db } from "../db/db.js";
import { tuFotaRecipients } from "../db/schema/fota_recipients.js";
import { eq } from "drizzle-orm";
class EmailService {
    transporter = null;
    constructor() {
        this.initTransporter();
    }
    initTransporter() {
        const host = process.env.SMTP_HOST || "email-smtp.ap-south-1.amazonaws.com";
        const port = parseInt(process.env.SMTP_PORT || "587", 10);
        const secure = process.env.SMTP_SECURE === "true";
        const user = process.env.SMTP_USER || "AKIAX7R63ZNCMC5RH64E";
        const pass = process.env.SMTP_PASS || "BF+S+ydo3Qph5V5ofnbAokl0FW0WjcJQYSMoaTMGsoSl";
        this.transporter = nodemailer.createTransport({
            host,
            port,
            secure,
            auth: {
                user,
                pass,
            },
        });
    }
    getTransporter() {
        if (!this.transporter) {
            this.initTransporter();
        }
        return this.transporter;
    }
    getFromHeader() {
        const fromAddress = process.env.SMTP_FROM || "fota@notify.sclabsglobal.com";
        const fromName = process.env.SMTP_FROM_NAME || "Third Umpire FOTA";
        return `"${fromName}" <${fromAddress}>`;
    }
    /**
     * Fetch all recipient emails configured in .env and SQLite database.
     */
    async getRecipients() {
        const emailsSet = new Set();
        // 1. From environment variable
        const envRecipients = process.env.FOTA_NOTIFICATION_RECIPIENTS || "";
        envRecipients
            .split(",")
            .map((e) => e.trim().toLowerCase())
            .filter((e) => e.length > 0 && e.includes("@"))
            .forEach((e) => emailsSet.add(e));
        // 2. From database table
        try {
            const dbRecipients = await db
                .select({ email: tuFotaRecipients.email })
                .from(tuFotaRecipients)
                .where(eq(tuFotaRecipients.isActive, 1));
            for (const row of dbRecipients) {
                const cleaned = (row.email || "").trim().toLowerCase();
                if (cleaned && cleaned.includes("@")) {
                    emailsSet.add(cleaned);
                }
            }
        }
        catch (err) {
            console.warn("[WARN] Could not load recipients from database", err);
        }
        return Array.from(emailsSet);
    }
    /**
     * Helper to format dates cleanly
     */
    formatDate(date) {
        try {
            const ist = date.toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
                dateStyle: "full",
                timeStyle: "medium",
            });
            const utc = date.toUTCString();
            return { ist: `${ist} (IST)`, utc };
        }
        catch {
            return { ist: date.toISOString(), utc: date.toISOString() };
        }
    }
    /**
     * Helper to calculate human-readable duration
     */
    getDurationString(start, end) {
        if (!start)
            return "N/A";
        const startDate = typeof start === "object" ? start : new Date(start);
        const diffMs = Math.max(0, end.getTime() - startDate.getTime());
        const totalSeconds = Math.floor(diffMs / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const parts = [];
        if (hours > 0)
            parts.push(`${hours}h`);
        if (minutes > 0 || hours > 0)
            parts.push(`${minutes}m`);
        parts.push(`${seconds}s`);
        return parts.join(" ");
    }
    /**
     * 1. Send email when FOTA deployment starts/initiates.
     */
    async sendFotaInitiatedEmail(params) {
        try {
            const recipients = await this.getRecipients();
            if (recipients.length === 0) {
                console.warn("[WARN] [EmailService] No recipients found for FOTA initiated email. Configure FOTA_NOTIFICATION_RECIPIENTS in .env or add to tu_fota_recipients table.");
                return { success: false, error: "No recipients configured" };
            }
            if (!this.transporter) {
                this.initTransporter();
            }
            const formattedDate = this.formatDate(params.date);
            const deviceIdentifier = params.deviceName || params.hardwareUuid || `Device #${params.deviceId}`;
            const proposer = params.proposedByName
                ? `${params.proposedByName} (${params.proposedBy || "No email"})`
                : params.proposedBy || "System Administrator";
            const subject = `🚀 [FOTA INITIATED] Update Deployed for Device: ${deviceIdentifier} [ID: #${params.deviceId}]`;
            const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FOTA Deployment Initiated</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px; color: #1e293b; }
    .container { max-width: 650px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03); border: 1px solid #e2e8f0; }
    .header { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%); color: #ffffff; padding: 28px 32px; }
    .header h1 { margin: 0 0 8px 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
    .header p { margin: 0; font-size: 13px; color: #c7d2fe; }
    .badge { display: inline-block; background-color: #3b82f6; color: #ffffff; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
    .body-content { padding: 32px; }
    .section-title { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 24px 0 12px 0; border-bottom: 1px solid #f1f5f9; padding-bottom: 6px; }
    .info-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    .info-table td { padding: 10px 12px; font-size: 14px; border-bottom: 1px solid #f8fafc; }
    .info-table td.label { font-weight: 600; color: #475569; width: 35%; background: #f8fafc; border-radius: 4px; }
    .info-table td.value { font-weight: 500; color: #0f172a; word-break: break-all; }
    .version-table { width: 100%; border-collapse: collapse; margin: 12px 0 20px 0; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
    .version-table th { background: #f8fafc; text-align: left; padding: 10px 12px; font-size: 12px; font-weight: 600; color: #475569; border-bottom: 1px solid #e2e8f0; }
    .version-table td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #f1f5f9; }
    .version-tag { font-family: monospace; font-size: 12px; padding: 2px 6px; background: #e0e7ff; color: #3730a3; border-radius: 4px; font-weight: 600; }
    .version-arrow { color: #6366f1; font-weight: bold; padding: 0 4px; }
    .alert-box { background-color: #eff6ff; border-left: 4px solid #3b82f6; padding: 14px 16px; border-radius: 0 6px 6px 0; margin-top: 24px; font-size: 13px; color: #1e40af; line-height: 1.5; }
    .footer { background: #f8fafc; padding: 20px 32px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="badge">FOTA Deployment Initiated</span>
      <h1>Firmware Update Deployed</h1>
      <p>A new firmware update has been queued and dispatched to the target device.</p>
    </div>
    
    <div class="body-content">
      <div class="section-title">Deployment Summary</div>
      <table class="info-table">
        <tr>
          <td class="label">Target Device</td>
          <td class="value"><strong>${params.deviceName || "Unnamed Device"}</strong></td>
        </tr>
        <tr>
          <td class="label">Device Hardware UUID</td>
          <td class="value"><code>${params.hardwareUuid || "N/A"}</code></td>
        </tr>
        <tr>
          <td class="label">Device ID</td>
          <td class="value">#${params.deviceId}</td>
        </tr>
        <tr>
          <td class="label">Deployment ID</td>
          <td class="value">FOTA-${params.fotaId}</td>
        </tr>
        <tr>
          <td class="label">Initiation Date & Time</td>
          <td class="value">${formattedDate.ist}<br><span style="color:#64748b;font-size:12px;">${formattedDate.utc}</span></td>
        </tr>
        <tr>
          <td class="label">Proposed By</td>
          <td class="value"><strong>${proposer}</strong></td>
        </tr>
        <tr>
          <td class="label">Status</td>
          <td class="value"><span style="color:#2563eb;font-weight:600;">NEWIMAGE (Awaiting Device Download)</span></td>
        </tr>
      </table>

      <div class="section-title">Component Version Report</div>
      <table class="version-table">
        <thead>
          <tr>
            <th>Component</th>
            <th>Current Version</th>
            <th>Target Version</th>
            <th>Package Archive</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Device App</strong></td>
            <td><span class="version-tag">${params.deviceOldVersion || "0.0.0"}</span></td>
            <td><span class="version-arrow">➔</span> <span class="version-tag">${params.deviceNewVersion || params.deviceOldVersion || "0.0.0"}</span></td>
            <td>${params.deviceFileName ? `<code>${params.deviceFileName}</code>` : "<em>No file uploaded</em>"}</td>
          </tr>
          <tr>
            <td><strong>Web UI</strong></td>
            <td><span class="version-tag">${params.webOldVersion || "0.0.0"}</span></td>
            <td><span class="version-arrow">➔</span> <span class="version-tag">${params.webNewVersion || params.webOldVersion || "0.0.0"}</span></td>
            <td>${params.webFileName ? `<code>${params.webFileName}</code>` : "<em>No file uploaded</em>"}</td>
          </tr>
          <tr>
            <td><strong>System FOTA</strong></td>
            <td><span class="version-tag">${params.fotaOldVersion || "0.0.0"}</span></td>
            <td><span class="version-arrow">➔</span> <span class="version-tag">${params.fotaNewVersion || params.fotaOldVersion || "0.0.0"}</span></td>
            <td>${params.fotaFileName ? `<code>${params.fotaFileName}</code>` : "<em>No file uploaded</em>"}</td>
          </tr>
        </tbody>
      </table>

      <div class="alert-box">
        <strong>What happens next?</strong><br>
        The target device will automatically detect this update during its next poll cycle, download the required packages from the server, and perform installation. You will receive a follow-up completion email as soon as the device reports the update result.
      </div>
    </div>

    <div class="footer">
      <p>This automated message was sent by the Third Umpire FOTA Notification Service.</p>
      <p style="margin-top: 4px; font-size: 11px; color: #94a3b8;">Third Umpire &copy; 2026 • Automated Notification</p>
    </div>
  </div>
</body>
</html>
      `;
            const text = `
[FOTA INITIATED] Update Deployed for Device: ${deviceIdentifier} (ID: #${params.deviceId})
========================================================================

A new firmware update has been queued and dispatched to the target device.

DEPLOYMENT DETAILS:
- Target Device: ${params.deviceName || "Unnamed Device"}
- Hardware UUID: ${params.hardwareUuid || "N/A"}
- Device ID: #${params.deviceId}
- Deployment ID: FOTA-${params.fotaId}
- Date & Time: ${formattedDate.ist} (${formattedDate.utc})
- Proposed By: ${proposer}
- Current Status: NEWIMAGE (Awaiting Device Download)

COMPONENT VERSIONS:
- Device App: ${params.deviceOldVersion || "0.0.0"} -> ${params.deviceNewVersion || params.deviceOldVersion || "0.0.0"} [File: ${params.deviceFileName || "None"}]
- Web UI: ${params.webOldVersion || "0.0.0"} -> ${params.webNewVersion || params.webOldVersion || "0.0.0"} [File: ${params.webFileName || "None"}]
- System FOTA: ${params.fotaOldVersion || "0.0.0"} -> ${params.fotaNewVersion || params.fotaOldVersion || "0.0.0"} [File: ${params.fotaFileName || "None"}]

NEXT STEPS:
The target device will download the packages and execute the update. A completion email will follow when status is reported.
      `;
            const result = await this.getTransporter().sendMail({
                from: this.getFromHeader(),
                to: recipients,
                subject,
                text,
                html,
            });
            console.log(`[OK] [EmailService] FOTA Initiated email sent successfully to ${recipients.join(", ")} (Message ID: ${result.messageId})`);
            return {
                success: true,
                messageId: result.messageId,
            };
        }
        catch (err) {
            console.error("[ERROR] [EmailService] Failed to send FOTA initiated email", err);
            return {
                success: false,
                error: err instanceof Error ? err.message : "Failed to send email",
            };
        }
    }
    /**
     * 2. Send email when FOTA update is completed/applied by the device.
     */
    async sendFotaCompletedEmail(params) {
        try {
            const recipients = await this.getRecipients();
            if (recipients.length === 0) {
                console.warn("[WARN] [EmailService] No recipients found for FOTA completed email.");
                return { success: false, error: "No recipients configured" };
            }
            if (!this.transporter) {
                this.initTransporter();
            }
            const formattedCompletedDate = this.formatDate(params.completedAt);
            const deviceIdentifier = params.deviceName || params.hardwareUuid || `Device #${params.deviceId}`;
            const proposer = params.proposedByName
                ? `${params.proposedByName} (${params.proposedBy || "No email"})`
                : params.proposedBy || "System Administrator";
            const duration = this.getDurationString(params.startedAt, params.completedAt);
            const isFullSuccess = params.deviceSuccess !== false &&
                params.webSuccess !== false &&
                params.fotaSuccess !== false;
            const subject = isFullSuccess
                ? `✅ [FOTA COMPLETED] Update Successfully Installed on Device: ${deviceIdentifier} [ID: #${params.deviceId}]`
                : `⚠️ [FOTA STATUS UPDATE] Device: ${deviceIdentifier} [ID: #${params.deviceId}] - Status: ${params.status}`;
            const getComponentBadge = (success) => {
                if (success === true) {
                    return '<span style="color:#16a34a;font-weight:600;">✓ Applied Successfully</span>';
                }
                if (success === false) {
                    return '<span style="color:#dc2626;font-weight:600;">✗ Failed</span>';
                }
                return '<span style="color:#64748b;">Not Updated / Unchanged</span>';
            };
            const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FOTA Update Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px; color: #1e293b; }
    .container { max-width: 650px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03); border: 1px solid #e2e8f0; }
    .header { background: linear-gradient(135deg, #064e3b 0%, #065f46 50%, #047857 100%); color: #ffffff; padding: 28px 32px; }
    .header h1 { margin: 0 0 8px 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
    .header p { margin: 0; font-size: 13px; color: #a7f3d0; }
    .badge { display: inline-block; background-color: #10b981; color: #ffffff; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
    .body-content { padding: 32px; }
    .section-title { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 24px 0 12px 0; border-bottom: 1px solid #f1f5f9; padding-bottom: 6px; }
    .info-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    .info-table td { padding: 10px 12px; font-size: 14px; border-bottom: 1px solid #f8fafc; }
    .info-table td.label { font-weight: 600; color: #475569; width: 35%; background: #f8fafc; border-radius: 4px; }
    .info-table td.value { font-weight: 500; color: #0f172a; word-break: break-all; }
    .version-table { width: 100%; border-collapse: collapse; margin: 12px 0 20px 0; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
    .version-table th { background: #f8fafc; text-align: left; padding: 10px 12px; font-size: 12px; font-weight: 600; color: #475569; border-bottom: 1px solid #e2e8f0; }
    .version-table td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #f1f5f9; }
    .version-tag { font-family: monospace; font-size: 12px; padding: 2px 6px; background: #dcfce7; color: #166534; border-radius: 4px; font-weight: 600; }
    .success-box { background-color: #f0fdf4; border-left: 4px solid #10b981; padding: 14px 16px; border-radius: 0 6px 6px 0; margin-top: 24px; font-size: 13px; color: #166534; line-height: 1.5; }
    .footer { background: #f8fafc; padding: 20px 32px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="badge">FOTA Update Finished</span>
      <h1>Update Successfully Applied</h1>
      <p>The target device has executed the FOTA update and reported completion.</p>
    </div>
    
    <div class="body-content">
      <div class="section-title">Execution Report</div>
      <table class="info-table">
        <tr>
          <td class="label">Target Device</td>
          <td class="value"><strong>${params.deviceName || "Unnamed Device"}</strong></td>
        </tr>
        <tr>
          <td class="label">Device Hardware UUID</td>
          <td class="value"><code>${params.hardwareUuid || "N/A"}</code></td>
        </tr>
        <tr>
          <td class="label">Device ID</td>
          <td class="value">#${params.deviceId}</td>
        </tr>
        <tr>
          <td class="label">Deployment ID</td>
          <td class="value">FOTA-${params.fotaId}</td>
        </tr>
        <tr>
          <td class="label">Originally Proposed By</td>
          <td class="value"><strong>${proposer}</strong></td>
        </tr>
        <tr>
          <td class="label">Completed At</td>
          <td class="value">${formattedCompletedDate.ist}<br><span style="color:#64748b;font-size:12px;">${formattedCompletedDate.utc}</span></td>
        </tr>
        <tr>
          <td class="label">Time Taken (Duration)</td>
          <td class="value"><strong>${duration}</strong></td>
        </tr>
        <tr>
          <td class="label">Final FOTA Status</td>
          <td class="value"><span style="color:#16a34a;font-weight:700;">${params.status}</span></td>
        </tr>
      </table>

      <div class="section-title">Component Results & Current Active Versions</div>
      <table class="version-table">
        <thead>
          <tr>
            <th>Component</th>
            <th>Result Status</th>
            <th>Current Active Version</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Device App</strong></td>
            <td>${getComponentBadge(params.deviceSuccess)}</td>
            <td><span class="version-tag">${params.currentDeviceVersion || "0.0.0"}</span></td>
          </tr>
          <tr>
            <td><strong>Web UI</strong></td>
            <td>${getComponentBadge(params.webSuccess)}</td>
            <td><span class="version-tag">${params.currentWebVersion || "0.0.0"}</span></td>
          </tr>
          <tr>
            <td><strong>System FOTA</strong></td>
            <td>${getComponentBadge(params.fotaSuccess)}</td>
            <td><span class="version-tag">${params.currentFotaVersion || "0.0.0"}</span></td>
          </tr>
        </tbody>
      </table>

      <div class="success-box">
        <strong>Update Result:</strong><br>
        The device has verified and applied the software components. Active version numbers have been promoted in the system registry. The device is now operational on the updated firmware.
      </div>
    </div>

    <div class="footer">
      <p>This automated message was sent by the Third Umpire FOTA Notification Service.</p>
      <p style="margin-top: 4px; font-size: 11px; color: #94a3b8;">Third Umpire &copy; 2026 • Automated Notification</p>
    </div>
  </div>
</body>
</html>
      `;
            const text = `
[FOTA COMPLETED] Update Successfully Applied on Device: ${deviceIdentifier} (ID: #${params.deviceId})
========================================================================

The target device has executed the FOTA update and reported completion.

COMPLETION DETAILS:
- Target Device: ${params.deviceName || "Unnamed Device"}
- Hardware UUID: ${params.hardwareUuid || "N/A"}
- Device ID: #${params.deviceId}
- Deployment ID: FOTA-${params.fotaId}
- Originally Proposed By: ${proposer}
- Completed At: ${formattedCompletedDate.ist} (${formattedCompletedDate.utc})
- Total Duration: ${duration}
- Final Status: ${params.status}

ACTIVE VERSIONS ON DEVICE:
- Device App: ${params.currentDeviceVersion || "0.0.0"} (Status: ${params.deviceSuccess ? "Applied" : "Unchanged"})
- Web UI: ${params.currentWebVersion || "0.0.0"} (Status: ${params.webSuccess ? "Applied" : "Unchanged"})
- System FOTA: ${params.currentFotaVersion || "0.0.0"} (Status: ${params.fotaSuccess ? "Applied" : "Unchanged"})
      `;
            const result = await this.getTransporter().sendMail({
                from: this.getFromHeader(),
                to: recipients,
                subject,
                text,
                html,
            });
            console.log(`[OK] [EmailService] FOTA Completed email sent successfully to ${recipients.join(", ")} (Message ID: ${result.messageId})`);
            return {
                success: true,
                messageId: result.messageId,
            };
        }
        catch (err) {
            console.error("[ERROR] [EmailService] Failed to send FOTA completed email", err);
            return {
                success: false,
                error: err instanceof Error ? err.message : "Failed to send email",
            };
        }
    }
    /**
     * Send a test email to verify credentials and delivery.
     */
    async sendTestEmail(targetEmail) {
        try {
            const recipients = targetEmail
                ? [targetEmail.trim().toLowerCase()]
                : await this.getRecipients();
            if (recipients.length === 0) {
                return {
                    success: false,
                    recipients: [],
                    error: "No recipients configured to test.",
                };
            }
            if (!this.transporter) {
                this.initTransporter();
            }
            const dateStr = new Date().toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
                dateStyle: "full",
                timeStyle: "medium",
            });
            const result = await this.getTransporter().sendMail({
                from: this.getFromHeader(),
                to: recipients,
                subject: "🔔 [Test Notification] Third Umpire FOTA Email Service Active",
                text: `This is a test notification verifying that the Third Umpire FOTA Email Service is correctly configured and working.\n\nTimestamp: ${dateStr}`,
                html: `
<div style="font-family: sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; max-width: 500px;">
  <h2 style="color: #4338ca; margin-top: 0;">FOTA Email Service Test</h2>
  <p>This is a test email confirming that Amazon SES SMTP is connected and sending notifications successfully.</p>
  <p><strong>Configured Recipients:</strong> ${recipients.join(", ")}</p>
  <p><strong>Time:</strong> ${dateStr} (IST)</p>
</div>
        `,
            });
            return {
                success: true,
                messageId: result.messageId,
                recipients,
            };
        }
        catch (err) {
            console.error("[ERROR] [EmailService] Test email failed", err);
            return {
                success: false,
                recipients: [],
                error: err instanceof Error ? err.message : "Failed to send test email",
            };
        }
    }
}
export const emailService = new EmailService();
