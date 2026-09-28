import { Hono } from "hono";
import { fotaController } from "../controllers/fotaController.js";

export const fotaRoutes = new Hono();

fotaRoutes.post("/add-fota-details", (c) => fotaController.addFotaDetails(c));
fotaRoutes.get("/:deviceId/get-fota-details", (c) =>
  fotaController.getLatestFotaDetails(c),
);
fotaRoutes.get("/:deviceId/download-fota/:component", (c) =>
  fotaController.downloadFotaArchive(c),
);
fotaRoutes.get("/:deviceId/fota-details-list", (c) =>
  fotaController.getFotaDetailsList(c),
);
fotaRoutes.patch("/:fotaId/update-fota-status", (c) =>
  fotaController.updateFotaStatus(c),
);
