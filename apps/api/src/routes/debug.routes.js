import {
  handleDebugState,
  handleMetadataPreview,
  handleResetSession
} from "../controllers/debug.controller.js";

/**
 * @param {string} method
 * @param {string} pathname
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {boolean} true if the route was handled
 */
export function debugRoutes(method, pathname, req, res) {
  if (method === "GET" && pathname === "/api/debug/state") {
    handleDebugState(req, res);
    return true;
  }

  if (method === "POST" && pathname === "/api/debug/metadata-preview") {
    handleMetadataPreview(req, res);
    return true;
  }

  if (method === "POST" && pathname === "/api/debug/reset-session") {
    handleResetSession(req, res);
    return true;
  }

  return false;
}
