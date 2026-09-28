import { db } from "../db/db.js";
import { tuFotaRecipients } from "../db/schema/fota_recipients.js";
import { emailService } from "../services/emailService.js";
import { eq } from "drizzle-orm";
class RecipientController {
    /**
     * GET /fota-recipients
     * List all configured recipient emails (from .env and database).
     */
    async getRecipients(c) {
        try {
            const allActiveEmails = await emailService.getRecipients();
            const dbRows = await db.select().from(tuFotaRecipients);
            const envRecipients = (process.env.FOTA_NOTIFICATION_RECIPIENTS || "")
                .split(",")
                .map((e) => e.trim().toLowerCase())
                .filter((e) => e.length > 0 && e.includes("@"));
            return c.json({
                recipients: allActiveEmails,
                databaseRecipients: dbRows,
                envRecipients,
            });
        }
        catch (err) {
            console.error("[ERROR] Failed to fetch recipients", err);
            return c.json({
                error: err instanceof Error ? err.message : "Failed to fetch recipients",
            }, 500);
        }
    }
    /**
     * POST /fota-recipients
     * Add a new recipient email to receive FOTA notifications.
     */
    async addRecipient(c) {
        try {
            const body = await c.req.json().catch(() => ({}));
            const { email, name } = body;
            if (!email || typeof email !== "string" || !email.includes("@")) {
                return c.json({ error: "A valid email address is required" }, 400);
            }
            const normalizedEmail = email.trim().toLowerCase();
            // Check if already in DB
            const existing = await db
                .select()
                .from(tuFotaRecipients)
                .where(eq(tuFotaRecipients.email, normalizedEmail))
                .limit(1);
            if (existing.length > 0) {
                // Re-activate if was deactivated
                await db
                    .update(tuFotaRecipients)
                    .set({ isActive: 1, name: name || existing[0].name })
                    .where(eq(tuFotaRecipients.id, existing[0].id));
                return c.json({
                    message: "Recipient updated / activated successfully",
                    recipient: { ...existing[0], isActive: 1, name: name || existing[0].name },
                });
            }
            const inserted = await db
                .insert(tuFotaRecipients)
                .values({
                email: normalizedEmail,
                name: name ? String(name).trim() : null,
                isActive: 1,
            })
                .returning();
            return c.json({
                message: "Recipient added successfully",
                recipient: inserted[0],
            }, 201);
        }
        catch (err) {
            console.error("[ERROR] Failed to add recipient", err);
            return c.json({
                error: err instanceof Error ? err.message : "Failed to add recipient",
            }, 500);
        }
    }
    /**
     * DELETE /fota-recipients/:email
     * Remove or deactivate a recipient email.
     */
    async deleteRecipient(c) {
        try {
            const emailParam = c.req.param("email");
            if (!emailParam) {
                return c.json({ error: "Email parameter is required" }, 400);
            }
            const normalizedEmail = decodeURIComponent(emailParam).trim().toLowerCase();
            await db
                .delete(tuFotaRecipients)
                .where(eq(tuFotaRecipients.email, normalizedEmail));
            return c.json({
                message: `Recipient ${normalizedEmail} removed successfully`,
            });
        }
        catch (err) {
            console.error("[ERROR] Failed to delete recipient", err);
            return c.json({
                error: err instanceof Error ? err.message : "Failed to delete recipient",
            }, 500);
        }
    }
    /**
     * POST /fota-recipients/test-email
     * Trigger a test email to verify SMTP and recipient delivery.
     */
    async sendTestEmail(c) {
        try {
            const body = await c.req.json().catch(() => ({}));
            const targetEmail = body["email"] ? String(body["email"]).trim() : undefined;
            const result = await emailService.sendTestEmail(targetEmail);
            if (!result.success) {
                return c.json({
                    error: result.error || "Failed to send test email",
                    recipients: result.recipients,
                }, 400);
            }
            return c.json({
                message: "Test email sent successfully",
                messageId: result.messageId,
                recipients: result.recipients,
            });
        }
        catch (err) {
            console.error("[ERROR] Test email failed", err);
            return c.json({
                error: err instanceof Error ? err.message : "Internal error sending test email",
            }, 500);
        }
    }
}
export const recipientController = new RecipientController();
