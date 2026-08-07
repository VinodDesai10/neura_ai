import { handleChat } from "../controllers/chat.controller.js";

/**
 * @param {string} method
 * @param {string} pathname
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {boolean} true if the route was handled
 */
export function chatRoutes(method, pathname, req, res) {
  if (method === "POST" && pathname === "/api/chat") {
    handleChat(req, res);
    return true;
  }

  return false;
}
