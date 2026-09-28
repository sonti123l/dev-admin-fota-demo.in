import { Hono } from "hono";
import { recipientController } from "../controllers/recipientController.js";

export const recipientRoutes = new Hono();

recipientRoutes.get("/fota-recipients", (c) =>
  recipientController.getRecipients(c),
);
recipientRoutes.post("/fota-recipients", (c) =>
  recipientController.addRecipient(c),
);
recipientRoutes.delete("/fota-recipients/:email", (c) =>
  recipientController.deleteRecipient(c),
);
recipientRoutes.post("/fota-recipients/test-email", (c) =>
  recipientController.sendTestEmail(c),
);
