import {
  handleMcpOptions,
  handleMcpRequest,
  mcpPath
} from "../mcp/neura-memory-server.js";

/**
 * @param {string} method
 * @param {string} pathname
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {boolean} true if the route was handled
 */
export function mcpRoutes(method, pathname, req, res) {
  if (pathname !== mcpPath) {
    return false;
  }

  if (method === "OPTIONS") {
    handleMcpOptions(req, res);
    return true;
  }

  if (method === "GET" || method === "POST" || method === "DELETE") {
    handleMcpRequest(req, res).catch(() => {
      // handleMcpRequest owns its response and logging path.
    });
    return true;
  }

  return false;
}
