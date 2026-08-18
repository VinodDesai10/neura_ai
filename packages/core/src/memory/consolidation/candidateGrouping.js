/**
 * packages/core/src/memory/consolidation/candidateGrouping.js
 *
 * Fast, metadata-first candidate grouping for memory consolidation.
 *
 * ─── Why this exists ──────────────────────────────────────────────────────────
 *
 *   Before the consolidation engine can synthesise a ConsolidatedMemory, it
 *   must identify which source memories belong together.  A naïve approach
 *   that computes pairwise similarity for every memory pair is O(N²).
 *
 *   This module mirrors the strategy in conflictCandidates.js:
 *   apply cheap metadata-only filters first, then do a lightweight token-
 *   overlap check only on memories that have already passed those filters.
 *
 * ─── Filter / grouping pipeline ──────────────────────────────────────────────
 *
 *   Stage 1 — lifecycle eligibility
 *     ACTIVE and STALE memories are eligible.
 *     ARCHIVED memories are excluded by default.
 *     CONFLICTED memories are included (their conflicts are surfaced later).
 *
 *   Stage 2 — bucket by (memoryType, domain)
 *     Memories are grouped by their shared type and primary domain.
 *     "factual/identity" can never be consolidated with "episodic/planning".
 *     Memories without a domain are bucketed into a "general" domain bucket.
 *
 *   Stage 3 — token overlap within each bucket
 *     Within each (type, domain) bucket, memories that share ≥ MIN_SHARED_TOKENS
 *     significant tokens are grouped together.  This is O(N × K) where K is
 *     the average bucket size — far cheaper than O(N²) cross-bucket comparison.
 *
 *   Stage 4 — minimum group size
 *     A group must have at least `config.minSourceCount` members.
 *
 * ─── Topic inference ─────────────────────────────────────────────────────────
 *
 *   The topic label for a group is inferred from the dominant tokens shared
 *   across all members, with a fallback to known topic patterns from the
 *   conflict detector.  No LLM is used — this is pure token analysis.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   groupConsolidationCandidates(memories, config?) → ConsolidationGroup[]
 *   inferTopic(memories)                            → string
 *   buildConsolidationTokenSet(content)             → Set<string>
 *   isEligibleForConsolidation(memory, includeArchived?) → boolean
 */

import { clampScore }              from "@neura/shared";
import { LifecycleState }          from "../lifecycle/lifecycleTypes.js";
import {
  CONSOLIDATION_DEFAULTS,
  readConsolidationConfig
} from "./consolidationTypes.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimum shared tokens for two memories to be placed in the same group.
 *
 * @type {number}
 */
const MIN_SHARED_TOKENS = 1;

/**
 * Stop words stripped before token comparison (superset of lifecycle stop words).
 *
 * @type {Set<string>}
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "were", "has", "have", "had",
  "not", "but", "with", "from", "that", "this", "they", "their",
  "our", "its", "now", "use", "using", "used", "will", "can",
  "into", "onto", "been", "also", "more", "than", "then",
  "just", "all", "any", "been", "some", "over", "such", "when",
  "there", "about", "which", "your", "would", "could", "should",
  "get", "got", "may", "his", "her", "him", "she", "who",
  "what", "how", "why", "where", "yes", "let", "did", "does"
]);

/**
 * Topic-detection patterns (sorted by priority).
 * Each pattern maps a topic label to a regex that fires on the memory content.
 *
 * @type {Array<{ topic: string, regex: RegExp }>}
 */
const TOPIC_PATTERNS = [
  { topic: "location",   regex: /\b(?:live|based|city|town|location|moved|home)\b/i },
  { topic: "employment", regex: /\b(?:work|job|company|employer|hired|joined|role|position)\b/i },
  { topic: "tech_stack", regex: /\b(?:uses?|using|stack|backend|frontend|database|framework|language|library|tool)\b/i },
  { topic: "project",    regex: /\b(?:project|feature|roadmap|mvp|demo|requirement|task)\b/i },
  { topic: "preference", regex: /\b(?:prefer|like|dislike|favourite|favorite|want)\b/i },
  { topic: "identity",   regex: /\b(?:name|am|called|known|age|years old)\b/i },
  { topic: "planning",   regex: /\b(?:plan|schedule|deadline|next|todo|step)\b/i }
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a normalised token set for consolidation grouping.
 *
 * @param {string} content
 * @returns {Set<string>}
 */
export function buildConsolidationTokenSet(content) {
  if (!content || typeof content !== "string") return new Set();
  return new Set(
    content
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
  );
}

/**
 * Return the number of tokens shared between two sets.
 *
 * Iterates the smaller set for efficiency.
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
function sharedTokenCount(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const t of smaller) {
    if (larger.has(t)) count++;
  }
  return count;
}

/**
 * Return the normalised domain for bucketing.
 * Memories without a domain fall into "general".
 *
 * @param {object} memory
 * @returns {string}
 */
function getDomain(memory) {
  return memory?.metadata?.domain ?? "general";
}

/**
 * Return the memory type for bucketing.
 * Unknown types fall into "unknown" (still grouped separately from known types).
 *
 * @param {object} memory
 * @returns {string}
 */
function getMemoryType(memory) {
  return memory?.memoryType ?? "unknown";
}

/**
 * Return true when a memory is eligible for consolidation based on its
 * lifecycle state.
 *
 * ACTIVE and STALE memories are included.
 * CONFLICTED memories are included so their conflicts can be surfaced.
 * ARCHIVED memories are excluded by default.
 *
 * @param {object} memory
 * @param {boolean} [includeArchived=false]
 * @returns {boolean}
 */
export function isEligibleForConsolidation(memory, includeArchived = false) {
  const state = memory?.metadata?.lifecycleState ?? LifecycleState.ACTIVE;
  if (state === LifecycleState.ARCHIVED) return includeArchived;
  return true;
}

// ─── Topic inference ──────────────────────────────────────────────────────────

/**
 * Infer a human-readable topic label for a group of memories.
 *
 * Strategy (deterministic, no LLM):
 *   1. Test each memory's content against TOPIC_PATTERNS.
 *   2. Pick the pattern that matched the most memories.
 *   3. If no pattern matched, fall back to the most common significant token
 *      shared across all memories.
 *   4. Final fallback: the memory type + domain (e.g. "factual/identity").
 *
 * @param {object[]} memories
 * @returns {string}
 */
export function inferTopic(memories) {
  if (!memories || memories.length === 0) return "general";

  // Stage 1: try pattern-based topic detection
  const topicVotes = new Map();
  for (const mem of memories) {
    const content = mem?.content ?? "";
    for (const { topic, regex } of TOPIC_PATTERNS) {
      if (regex.test(content)) {
        topicVotes.set(topic, (topicVotes.get(topic) ?? 0) + 1);
      }
    }
  }

  if (topicVotes.size > 0) {
    let best = null;
    let bestCount = 0;
    for (const [topic, count] of topicVotes) {
      if (count > bestCount) {
        bestCount = count;
        best = topic;
      }
    }
    if (best) return best;
  }

  // Stage 2: most common token across all memories
  const tokenFreq = new Map();
  for (const mem of memories) {
    const tokens = buildConsolidationTokenSet(mem?.content ?? "");
    for (const t of tokens) {
      tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1);
    }
  }

  let topToken = null;
  let topCount = 0;
  for (const [token, count] of tokenFreq) {
    if (count > topCount) {
      topCount = count;
      topToken = token;
    }
  }
  if (topToken && topCount >= Math.max(2, Math.ceil(memories.length / 2))) {
    return topToken;
  }

  // Stage 3: type/domain fallback
  const memType = getMemoryType(memories[0]);
  const domain  = getDomain(memories[0]);
  return domain !== "general" ? `${memType}/${domain}` : memType;
}

// ─── Group builder ────────────────────────────────────────────────────────────

/**
 * Group a list of memories into consolidation candidate groups.
 *
 * This is the main entry point for the consolidation engine.  It applies
 * the four-stage pipeline described in the module header and returns only
 * groups that meet the minimum size requirement.
 *
 * @param {object[]}  memories          - All memories for a user
 * @param {ReturnType<typeof readConsolidationConfig>} [config]
 * @param {{ includeArchived?: boolean }} [options]
 * @returns {import("./consolidationTypes.js").ConsolidationGroup[]}
 */
export function groupConsolidationCandidates(memories, config, options = {}) {
  const cfg = config ?? readConsolidationConfig();

  // ── Stage 1: lifecycle eligibility ─────────────────────────────────────────
  const eligible = memories.filter(
    (m) => m?.id && isEligibleForConsolidation(m, options.includeArchived ?? false)
  );

  if (eligible.length < cfg.minSourceCount) return [];

  // ── Stage 2: bucket by (memoryType, domain) ─────────────────────────────────
  /** @type {Map<string, object[]>} */
  const buckets = new Map();
  for (const mem of eligible) {
    const key = `${getMemoryType(mem)}::${getDomain(mem)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(mem);
  }

  const groups = [];

  for (const bucket of buckets.values()) {
    if (bucket.length < cfg.minSourceCount) continue;

    // ── Stage 3: token-overlap grouping within bucket ─────────────────────────
    //
    //   We use a greedy union-find approach:
    //   - Each memory starts as its own group.
    //   - Iterate through pairs within the bucket (O(K²) where K is bucket size).
    //   - If two memories share enough tokens, merge their groups.
    //   - K is naturally small when memoryType × domain is the bucket key.
    //   - The cap at maxSourcesPerGroup prevents runaway groups.

    /** @type {Map<string, string>} id → group root */
    const parent = new Map();
    /** @type {Map<string, Set<string>>} root → group member IDs */
    const groupMap = new Map();

    for (const mem of bucket) {
      parent.set(mem.id, mem.id);
      groupMap.set(mem.id, new Set([mem.id]));
    }

    function find(id) {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      parent.set(id, root); // path compression
      return root;
    }

    function union(idA, idB) {
      const rootA = find(idA);
      const rootB = find(idB);
      if (rootA === rootB) return;
      const setA = groupMap.get(rootA);
      const setB = groupMap.get(rootB);
      if (setA.size >= setB.size) {
        for (const id of setB) setA.add(id);
        groupMap.delete(rootB);
        parent.set(rootB, rootA);
      } else {
        for (const id of setA) setB.add(id);
        groupMap.delete(rootA);
        parent.set(rootA, rootB);
      }
    }

    // Pre-compute token sets
    const tokenCache = new Map();
    for (const mem of bucket) {
      tokenCache.set(mem.id, buildConsolidationTokenSet(mem?.content ?? ""));
    }

    // Compare all pairs in bucket
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const memA = bucket[i];
        const memB = bucket[j];
        const tokA = tokenCache.get(memA.id);
        const tokB = tokenCache.get(memB.id);
        const shared = sharedTokenCount(tokA, tokB);
        if (shared >= MIN_SHARED_TOKENS) {
          const rootA = find(memA.id);
          const rootB = find(memB.id);
          if (rootA !== rootB) {
            const sizeA = (groupMap.get(rootA) ?? groupMap.get(find(memA.id))).size;
            const sizeB = (groupMap.get(rootB) ?? groupMap.get(find(memB.id))).size;
            if (sizeA + sizeB <= cfg.maxSourcesPerGroup) {
              union(memA.id, memB.id);
            }
          }
        }
      }
    }

    // ── Stage 4: emit groups that meet minSourceCount ─────────────────────────
    /** @type {Map<string, object[]>} root → member memories */
    const resolvedGroups = new Map();
    for (const mem of bucket) {
      const root = find(mem.id);
      if (!resolvedGroups.has(root)) resolvedGroups.set(root, []);
      resolvedGroups.get(root).push(mem);
    }

    for (const groupMemories of resolvedGroups.values()) {
      if (groupMemories.length < cfg.minSourceCount) continue;

      const memoryIds     = groupMemories.map((m) => m.id);
      const avgConfidence = groupMemories.reduce(
        (sum, m) => sum + (m?.metadata?.confidence ?? 0.5), 0
      ) / groupMemories.length;
      const avgImportance = groupMemories.reduce(
        (sum, m) => sum + (m?.metadata?.importance ?? 0.5), 0
      ) / groupMemories.length;

      const topic   = inferTopic(groupMemories);
      const memType = getMemoryType(groupMemories[0]);
      const userId  = groupMemories[0]?.userId ?? null;

      groups.push({
        userId,
        topic,
        memoryType:   memType,
        memories:     groupMemories,
        memoryIds,
        avgConfidence: clampScore(avgConfidence),
        avgImportance: clampScore(avgImportance)
      });
    }
  }

  return groups;
}
