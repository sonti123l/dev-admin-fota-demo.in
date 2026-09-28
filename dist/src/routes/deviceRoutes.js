import { Hono } from "hono";
import { deviceController } from "../controllers/deviceController.js";
export const deviceRoutes = new Hono();
deviceRoutes.get("/devices-list", (c) => deviceController.getDevicesList(c));
