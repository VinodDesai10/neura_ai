/**
 * controllers/graph.controller.js
 *
 * Reads query params, delegates to graph-query service, writes the response.
 * No business logic lives here.
 */

import {
  findMemoriesByDomain,
  findMemoriesByEntity,
  findMemoriesByKeyword,
  findSimilarMemories,
  getMemoryGraphStats
} from "../services/graph-query.js";
import { sendJson, withErrorHandler } from "../middleware/error-handler.js";
import { parseQueryParams } from "../middleware/request.js";

export const handleGraphByDomain = withErrorHandler(
  "Graph query failed",
  async (req, res) => {
    const params    = parseQueryParams(req);
    const sessionId = params.get("sessionId");
    const domain    = params.get("domain");
    const limit     = Number(params.get("limit") || "10");

    if (!sessionId || !domain) {
      return sendJson(res, 400, {
        error:   "Missing parameters",
        message: "sessionId and domain are required"
      });
    }

    const memories = await findMemoriesByDomain(sessionId, domain, limit);
    sendJson(res, 200, {
      domain,
      memories,
      count:     memories.length,
      timestamp: new Date().toISOString()
    });
  }
);

export const handleGraphByKeyword = withErrorHandler(
  "Graph query failed",
  async (req, res) => {
    const params    = parseQueryParams(req);
    const sessionId = params.get("sessionId");
    const keyword   = params.get("keyword");
    const limit     = Number(params.get("limit") || "10");

    if (!sessionId || !keyword) {
      return sendJson(res, 400, {
        error:   "Missing parameters",
        message: "sessionId and keyword are required"
      });
    }

    const memories = await findMemoriesByKeyword(sessionId, keyword, limit);
    sendJson(res, 200, {
      keyword,
      memories,
      count:     memories.length,
      timestamp: new Date().toISOString()
    });
  }
);

export const handleGraphByEntity = withErrorHandler(
  "Graph query failed",
  async (req, res) => {
    const params      = parseQueryParams(req);
    const sessionId   = params.get("sessionId");
    const entityValue = params.get("entity");
    const limit       = Number(params.get("limit") || "10");

    if (!sessionId || !entityValue) {
      return sendJson(res, 400, {
        error:   "Missing parameters",
        message: "sessionId and entity are required"
      });
    }

    const memories = await findMemoriesByEntity(sessionId, entityValue, limit);
    sendJson(res, 200, {
      entity:    entityValue,
      memories,
      count:     memories.length,
      timestamp: new Date().toISOString()
    });
  }
);

export const handleGraphSimilar = withErrorHandler(
  "Graph query failed",
  async (req, res) => {
    const params    = parseQueryParams(req);
    const memoryId  = params.get("memoryId");
    const limit     = Number(params.get("limit") || "5");

    if (!memoryId) {
      return sendJson(res, 400, {
        error:   "Missing parameters",
        message: "memoryId is required"
      });
    }

    const memories = await findSimilarMemories(memoryId, limit);
    sendJson(res, 200, {
      memoryId,
      similarMemories: memories,
      count:           memories.length,
      timestamp:       new Date().toISOString()
    });
  }
);

export const handleGraphStats = withErrorHandler(
  "Graph query failed",
  async (req, res) => {
    const sessionId = parseQueryParams(req).get("sessionId");

    if (!sessionId) {
      return sendJson(res, 400, {
        error:   "Missing parameters",
        message: "sessionId is required"
      });
    }

    const stats = await getMemoryGraphStats(sessionId);
    sendJson(res, 200, {
      sessionId,
      stats,
      timestamp: new Date().toISOString()
    });
  }
);
