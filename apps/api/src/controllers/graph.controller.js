import {
  findMemoriesByDomain,
  findMemoriesByEntity,
  findMemoriesByKeyword,
  findSimilarMemories,
  getMemoryGraphStats
} from "../services/graph-query.js";
import { sendJson } from "../middleware/error-handler.js";

export async function handleGraphByDomain(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const sessionId = requestUrl.searchParams.get("sessionId");
    const domain = requestUrl.searchParams.get("domain");
    const limit = Number(requestUrl.searchParams.get("limit") || "10");

    if (!sessionId || !domain) {
      return sendJson(res, 400, {
        error: "Missing parameters",
        message: "sessionId and domain are required"
      });
    }

    const memories = await findMemoriesByDomain(sessionId, domain, limit);
    sendJson(res, 200, {
      domain,
      memories,
      count: memories.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "Graph query failed",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

export async function handleGraphByKeyword(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const sessionId = requestUrl.searchParams.get("sessionId");
    const keyword = requestUrl.searchParams.get("keyword");
    const limit = Number(requestUrl.searchParams.get("limit") || "10");

    if (!sessionId || !keyword) {
      return sendJson(res, 400, {
        error: "Missing parameters",
        message: "sessionId and keyword are required"
      });
    }

    const memories = await findMemoriesByKeyword(sessionId, keyword, limit);
    sendJson(res, 200, {
      keyword,
      memories,
      count: memories.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "Graph query failed",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

export async function handleGraphByEntity(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const sessionId = requestUrl.searchParams.get("sessionId");
    const entityValue = requestUrl.searchParams.get("entity");
    const limit = Number(requestUrl.searchParams.get("limit") || "10");

    if (!sessionId || !entityValue) {
      return sendJson(res, 400, {
        error: "Missing parameters",
        message: "sessionId and entity are required"
      });
    }

    const memories = await findMemoriesByEntity(sessionId, entityValue, limit);
    sendJson(res, 200, {
      entity: entityValue,
      memories,
      count: memories.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "Graph query failed",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

export async function handleGraphSimilar(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const memoryId = requestUrl.searchParams.get("memoryId");
    const limit = Number(requestUrl.searchParams.get("limit") || "5");

    if (!memoryId) {
      return sendJson(res, 400, {
        error: "Missing parameters",
        message: "memoryId is required"
      });
    }

    const memories = await findSimilarMemories(memoryId, limit);
    sendJson(res, 200, {
      memoryId,
      similarMemories: memories,
      count: memories.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "Graph query failed",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

export async function handleGraphStats(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const sessionId = requestUrl.searchParams.get("sessionId");

    if (!sessionId) {
      return sendJson(res, 400, {
        error: "Missing parameters",
        message: "sessionId is required"
      });
    }

    const stats = await getMemoryGraphStats(sessionId);
    sendJson(res, 200, {
      sessionId,
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "Graph query failed",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
