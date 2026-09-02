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
      await callQdrantIgnoringAlreadyExists(`/collections/${collectionName}/index`, {
        method: "PUT",
        body: JSON.stringify({ field_name: "userId", field_schema: "keyword" })
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

  // RC1 fix: index userId so we can filter by user scope during retrieval.
  // This keeps memories from different users isolated while still allowing
  // a user's own memories from any session to surface via semantic search.
  await callQdrantIgnoringAlreadyExists(`/collections/${collectionName}/index`, {
    method: "PUT",
    body: JSON.stringify({ field_name: "userId", field_schema: "keyword" })
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

/**
 * Delete a single point by ID from the Qdrant collection.
 *
 * Returns `true` on success (Qdrant returns 200 with status "acknowledged").
 * Returns `false` when the collection does not exist yet (nothing to delete).
 * Throws on any other error so the caller can handle it explicitly.
 *
 * @param {string} pointId  - UUID string of the Qdrant point to remove
 * @returns {Promise<boolean>}
 */
export async function deleteQdrantPoint(pointId) {
  try {
    await callQdrant(`/collections/${getCollectionName()}/points/delete`, {
      method: "POST",
      body: JSON.stringify({ points: [pointId] })
    });
    return true;
  } catch (error) {
    if (isMissingCollectionError(error)) {
      // Collection doesn't exist yet — treat as "not found", not an error
      return false;
    }
    throw error;
  }
}

/**
 * Perform a partial payload update on a single point.
 *
 * Uses the Qdrant PATCH /points/payload endpoint which merges the supplied
 * `payload` object into the existing point payload without touching the vector
 * or other payload fields not listed here.  This is the correct path for
 * lifecycle-state updates — we never re-upload the embedding.
 *
 * @param {string|number} pointId   - UUID string (or integer) of the point
 * @param {object}        payload   - Partial payload to merge in
 * @returns {Promise<void>}
 */
export async function setQdrantPayload(pointId, payload) {
  await callQdrant(`/collections/${getCollectionName()}/points/payload`, {
    method: "POST",
    body: JSON.stringify({
      payload,
      points: [pointId]
    })
  });
}

export async function queryQdrantPoints({ vector, sessionId, userId = null, limit = 10, strictSession = false }) {
  let payload;

  try {
    // Filter strategy (in priority order):
    //   1. strictSession=true  → filter to this session only (dedup checks, etc.)
    //   2. userId present      → filter to this user's memories (cross-session OK,
    //                            other users' data stays out)
    //   3. Neither             → no filter: search entire collection (anonymous/no-user path;
    //                            kept for backward compatibility)
    //
    // The userId filter is the key change for RC1: it eliminates cross-user noise
    // while still allowing a user's own memories from any session to surface.
    const body = { query: vector, limit, with_payload: true };
    if (strictSession && sessionId) {
      body.filter = { must: [{ key: "sessionId", match: { value: sessionId } }] };
    } else if (userId) {
      body.filter = { must: [{ key: "userId", match: { value: userId } }] };
    }

    payload = await callQdrant(`/collections/${getCollectionName()}/points/query`, {
      method: "POST",
      body:   JSON.stringify(body)
    });
  } catch (error) {
    if (isMissingCollectionError(error)) {
      return [];
    }

    // RC1 graceful fallback: if the userId index doesn't exist yet (e.g. collection
    // was created before this fix), retry without the userId filter so retrieval
    // continues to work rather than returning empty results.
    const msg = error instanceof Error ? error.message : "";
    if (userId && !strictSession && msg.includes("Index required but not found")) {
      try {
        const fallbackBody = { query: vector, limit, with_payload: true };
        const fallbackPayload = await callQdrant(
          `/collections/${getCollectionName()}/points/query`,
          { method: "POST", body: JSON.stringify(fallbackBody) }
        );
        return Array.isArray(fallbackPayload?.result?.points)
          ? fallbackPayload.result.points
          : [];
      } catch {
        return [];
      }
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
