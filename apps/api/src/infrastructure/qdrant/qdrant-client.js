let collectionReady = false;

function isQdrantEnabled() {
  return Boolean(process.env.QDRANT_URL);
}

function getCollectionName() {
  return process.env.QDRANT_COLLECTION || "neura_vector_memories";
}

function buildHeaders() {
  const headers = { "Content-Type": "application/json" };

  if (process.env.QDRANT_API_KEY) {
    headers["api-key"] = process.env.QDRANT_API_KEY;
  }

  return headers;
}

function buildUrl(pathname) {
  return `${process.env.QDRANT_URL.replace(/\/+$/, "")}${pathname}`;
}

async function callQdrant(pathname, init = {}) {
  let response;

  try {
    response = await fetch(buildUrl(pathname), {
      ...init,
      headers: { ...buildHeaders(), ...(init.headers || {}) }
    });
  } catch (error) {
    const cause = error?.cause;
    const causeDetails = cause?.code
      ? `${cause.code}${cause.hostname ? ` ${cause.hostname}` : ""}`
      : cause?.message;

    throw new Error(
      `Qdrant request failed before response: ${
        causeDetails || (error instanceof Error ? error.message : "Unknown network error")
      }`
    );
  }

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Qdrant request failed (${response.status}): ${details}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function callQdrantIgnoringAlreadyExists(pathname, init = {}) {
  try {
    return await callQdrant(pathname, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (message.includes("(409)") || message.includes("already exists")) {
      return null;
    }

    throw error;
  }
}

function isMissingCollectionError(error) {
  const message = error instanceof Error ? error.message : "";
  return message.includes("(404)") && message.includes("doesn't exist");
}

export async function ensureQdrantReady(vectorSize) {
  if (!isQdrantEnabled() || !vectorSize) {
    return false;
  }

  if (collectionReady) {
    return true;
  }

  const collectionName = getCollectionName();
  const distance = process.env.QDRANT_DISTANCE || "Cosine";

  // Check if collection already exists and validate its vector size
  try {
    const info = await callQdrant(`/collections/${collectionName}`);
    const existingSize = info?.result?.config?.params?.vectors?.size;

    if (existingSize && existingSize !== vectorSize) {
      // Dimension mismatch — delete and recreate with the correct size
      await callQdrant(`/collections/${collectionName}`, { method: "DELETE" });
      await callQdrant(`/collections/${collectionName}`, {
        method: "PUT",
        body: JSON.stringify({ vectors: { size: vectorSize, distance } })
      });
      await callQdrantIgnoringAlreadyExists(`/collections/${collectionName}/index`, {
        method: "PUT",
        body: JSON.stringify({ field_name: "sessionId", field_schema: "keyword" })
      });
      collectionReady = true;
      return true;
    }
  } catch (error) {
    // Collection doesn't exist yet — fall through to create it
    if (!error?.message?.includes("(404)")) {
      throw error;
    }
  }

  // Create collection (no-op if it already exists with correct dimensions)
  await callQdrantIgnoringAlreadyExists(`/collections/${collectionName}`, {
    method: "PUT",
    body: JSON.stringify({
      vectors: { size: vectorSize, distance }
    })
  });

  await callQdrantIgnoringAlreadyExists(`/collections/${collectionName}/index`, {
    method: "PUT",
    body: JSON.stringify({ field_name: "sessionId", field_schema: "keyword" })
  });

  collectionReady = true;
  return true;
}

export async function upsertQdrantPoint(point) {
  await callQdrant(`/collections/${getCollectionName()}/points`, {
    method: "PUT",
    body: JSON.stringify({ points: [point] })
  });
}

export async function queryQdrantPoints({ vector, sessionId, limit = 10, strictSession = false }) {
  let payload;

  try {
    // When strictSession is true (e.g. dedup checks) we filter to this session only.
    // When false (default) we search cross-session so personal memories (name, preferences)
    // can surface in new sessions via semantic similarity.
    const body = { query: vector, limit, with_payload: true };
    if (strictSession && sessionId) {
      body.filter = { must: [{ key: "sessionId", match: { value: sessionId } }] };
    }

    payload = await callQdrant(`/collections/${getCollectionName()}/points/query`, {
      method: "POST",
      body:   JSON.stringify(body)
    });
  } catch (error) {
    if (isMissingCollectionError(error)) {
      return [];
    }

    throw error;
  }

  return Array.isArray(payload?.result?.points) ? payload.result.points : [];
}

export async function scrollQdrantPoints(sessionId, limit = 100) {
  let payload;

  try {
    payload = await callQdrant(`/collections/${getCollectionName()}/points/scroll`, {
      method: "POST",
      body: JSON.stringify({
        with_payload: true,
        with_vector: false,
        limit,
        filter: { must: [{ key: "sessionId", match: { value: sessionId } }] }
      })
    });
  } catch (error) {
    if (isMissingCollectionError(error)) {
      return [];
    }

    throw error;
  }

  return Array.isArray(payload?.result?.points) ? payload.result.points : [];
}

// Scroll all points across all sessions (used by debug state when no sessionId is given)
export async function scrollAllQdrantPoints(limit = 200) {
  let payload;

  try {
    payload = await callQdrant(`/collections/${getCollectionName()}/points/scroll`, {
      method: "POST",
      body: JSON.stringify({ with_payload: true, with_vector: false, limit })
    });
  } catch (error) {
    if (isMissingCollectionError(error)) {
      return [];
    }

    throw error;
  }

  return Array.isArray(payload?.result?.points) ? payload.result.points : [];
}

export function isQdrantConfigured() {
  return isQdrantEnabled();
}

export async function getQdrantHealth() {
  if (!isQdrantEnabled()) {
    return { configured: false, ok: false, message: "QDRANT_URL is not set" };
  }

  try {
    const payload = await callQdrant("/collections");
    const collections = Array.isArray(payload?.result?.collections)
      ? payload.result.collections.map((c) => c.name)
      : [];

    return { configured: true, ok: true, message: "reachable", collections };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      message: error instanceof Error ? error.message : "Unknown Qdrant error"
    };
  }
}
