/**
 * apps/api/test/helpers/retrieval-assertions.js
 *
 * Pure assertion helpers for the retrieval integration tests.
 * All helpers throw descriptive AssertionError messages on failure.
 *
 * Exported helpers:
 *   - expectIdsInOrder(results, expectedIds, label?)
 *   - expectScoresDescending(results, label?)
 *   - expectNoDuplicates(results, label?)
 *   - expectTopK(results, k, label?)
 *   - expectEmptyResults(results, label?)
 *   - expectIdFirst(results, id, label?)
 */

import assert from "node:assert/strict";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the memory id from a result object.
 * Handles both shapes: `{ id }` and `{ memory: { id } }`.
 */
function getId(result) {
  return result?.id ?? result?.memory?.id;
}

/**
 * Extract the hybrid score from a result object.
 * Handles: `{ _retrieval: { score } }` and `{ score }`.
 */
function getScore(result) {
  return result?._retrieval?.score ?? result?.score ?? 0;
}

// ─── Assertions ───────────────────────────────────────────────────────────────

/**
 * Assert that results contain exactly the expected ids in the given order.
 *
 * @param {object[]} results
 * @param {string[]} expectedIds
 * @param {string}   [label]
 */
export function expectIdsInOrder(results, expectedIds, label = "") {
  const tag      = label ? `[${label}] ` : "";
  const actualIds = results.map(getId);

  assert.deepEqual(
    actualIds,
    expectedIds,
    `${tag}Expected ids in order:\n  expected: ${JSON.stringify(expectedIds)}\n  got:      ${JSON.stringify(actualIds)}`
  );
}

/**
 * Assert that scores are in non-increasing (descending) order.
 *
 * @param {object[]} results
 * @param {string}   [label]
 */
export function expectScoresDescending(results, label = "") {
  const tag    = label ? `[${label}] ` : "";
  const scores = results.map(getScore);

  for (let i = 1; i < scores.length; i++) {
    assert.ok(
      scores[i - 1] >= scores[i],
      `${tag}Scores not descending at index ${i}: ${scores[i - 1]} < ${scores[i]}\n  All scores: ${JSON.stringify(scores)}`
    );
  }
}

/**
 * Assert that no two results share the same id or fingerprint.
 *
 * @param {object[]} results
 * @param {string}   [label]
 */
export function expectNoDuplicates(results, label = "") {
  const tag         = label ? `[${label}] ` : "";
  const seenIds         = new Set();
  const seenFingerprints = new Set();

  for (const result of results) {
    const id          = getId(result);
    const fingerprint = result?.fingerprint ?? result?.memory?.fingerprint ?? id;

    if (id) {
      assert.ok(
        !seenIds.has(id),
        `${tag}Duplicate id detected: "${id}"`
      );
      seenIds.add(id);
    }

    if (fingerprint) {
      assert.ok(
        !seenFingerprints.has(fingerprint),
        `${tag}Duplicate fingerprint detected: "${fingerprint}"`
      );
      seenFingerprints.add(fingerprint);
    }
  }
}

/**
 * Assert that exactly k results are returned.
 *
 * @param {object[]} results
 * @param {number}   k
 * @param {string}   [label]
 */
export function expectTopK(results, k, label = "") {
  const tag = label ? `[${label}] ` : "";
  assert.equal(
    results.length,
    k,
    `${tag}Expected exactly ${k} results, got ${results.length}`
  );
}

/**
 * Assert that results is an empty array (and that no exception was thrown
 * – this is called in a normal flow, not a catch).
 *
 * @param {object[]} results
 * @param {string}   [label]
 */
export function expectEmptyResults(results, label = "") {
  const tag = label ? `[${label}] ` : "";
  assert.ok(
    Array.isArray(results),
    `${tag}Expected an array, got ${typeof results}`
  );
  assert.equal(
    results.length,
    0,
    `${tag}Expected empty results, got ${results.length} items`
  );
}

/**
 * Assert that the first result has the given id.
 *
 * @param {object[]} results
 * @param {string}   expectedId
 * @param {string}   [label]
 */
export function expectIdFirst(results, expectedId, label = "") {
  const tag    = label ? `[${label}] ` : "";
  const actual = getId(results[0]);
  assert.equal(
    actual,
    expectedId,
    `${tag}Expected first result to be "${expectedId}", got "${actual}"`
  );
}
