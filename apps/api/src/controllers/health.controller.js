import { getStorageHealth } from "../services/storage-health.js";
import { sendJson } from "../middleware/error-handler.js";

export function handleHealth(req, res) {
  sendJson(res, 200, { status: "ok" });
}

export async function handleStorageHealth(req, res) {
  const health = await getStorageHealth();
  sendJson(res, health.status === "degraded" ? 503 : 200, health);
}
