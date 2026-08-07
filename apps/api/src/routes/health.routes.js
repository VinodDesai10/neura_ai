import { handleHealth, handleStorageHealth } from "../controllers/health.controller.js";

/**
 * @param {string} method
 * @param {string} pathname
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {boolean} true if the route was handled
 */
export function healthRoutes(method, pathname, req, res) {
  if (method === "GET" && pathname === "/health") {
    handleHealth(req, res);
    return true;
  }

  if (method === "GET" && pathname === "/health/storage") {
    handleStorageHealth(req, res);
    return true;
  }

  return false;
}
