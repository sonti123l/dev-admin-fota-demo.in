import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { initializeFotaDirectories, UPLOAD_DIR, DEVICE_DIR, WEB_DIR, } from "./utils/fotaStorage.js";
import { authRoutes } from "./routes/authRoutes.js";
import { authController } from "./controllers/authController.js";
import { deviceRoutes } from "./routes/deviceRoutes.js";
import { fotaRoutes } from "./routes/fotaRoutes.js";
import { recipientRoutes } from "./routes/recipientRoutes.js";
// Initialize FOTA directories on startup
initializeFotaDirectories();
const app = new Hono();
// Global CORS configuration
app.use("*", cors({
    origin: (origin) => origin || "*",
    allowHeaders: [
        "Content-Type",
        "Authorization",
        "Accept",
        "Origin",
        "X-Requested-With",
        "*",
    ],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    exposeHeaders: ["Content-Length"],
    maxAge: 86400,
    credentials: true,
}));
// Explicit OPTIONS handler to guarantee preflight responses
app.options("*", (c) => {
    return c.body(null, 204);
});
// Health check route
app.get("/", (c) => {
    return c.text("Hello Hono!");
});
// Authentication routes
app.route("/auth", authRoutes);
// Root alias for refresh-token
app.post("/refresh-token", (c) => authController.refreshToken(c));
// Device, FOTA, and Email Recipient routes
app.route("/", deviceRoutes);
app.route("/", fotaRoutes);
app.route("/", recipientRoutes);
// Global error handler
app.onError((err, c) => {
    console.error("[ERROR] Unhandled exception", err);
    return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
});
// Start Server
const PORT = parseInt(process.env.PORT || "8787");
serve({
    fetch: app.fetch,
    port: PORT,
}, (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
    console.log(`FOTA upload directory: ${UPLOAD_DIR}`);
    console.log(`Device releases: ${DEVICE_DIR}`);
    console.log(`Web releases: ${WEB_DIR}`);
});
