import {
  handleGraphByDomain,
  handleGraphByEntity,
  handleGraphByKeyword,
  handleGraphSimilar,
  handleGraphStats
} from "../controllers/graph.controller.js";

/**
 * @param {string} method
 * @param {string} pathname
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {boolean} true if the route was handled
 */
export function graphRoutes(method, pathname, req, res) {
  if (method === "GET" && pathname === "/api/graph/memories/by-domain") {
    handleGraphByDomain(req, res);
    return true;
  }

  if (method === "GET" && pathname === "/api/graph/memories/by-keyword") {
    handleGraphByKeyword(req, res);
    return true;
  }

  if (method === "GET" && pathname === "/api/graph/memories/by-entity") {
    handleGraphByEntity(req, res);
    return true;
  }

  if (method === "GET" && pathname === "/api/graph/memories/similar") {
    handleGraphSimilar(req, res);
    return true;
  }

  if (method === "GET" && pathname === "/api/graph/stats") {
    handleGraphStats(req, res);
    return true;
  }

  return false;
}
