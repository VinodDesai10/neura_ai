/**
 * tools/confusion-matrix.js
 *
 * Neura AI – Classifier Confusion Matrix Generator
 * ═════════════════════════════════════════════════
 *
 * Runs five classifiers against hand-labelled test cases, then computes and
 * prints a full confusion matrix with TP, TN, FP, FN, accuracy, precision,
 * recall, and F1-score for each classifier.
 *
 * Classifiers under test
 * ──────────────────────
 *  1. classifyMemoryType   (packages/core)  → "factual" | "episodic" | "semantic"
 *  2. isSmallTalk          (packages/shared) → boolean
 *  3. hasLowSignalContent  (packages/shared) → boolean
 *  4. shouldStoreMemory    (packages/core)  → boolean
 *  5. isDuplicate          (packages/core)  → boolean
 *
 * All test cases carry a human-assigned ground-truth label derived directly
 * from the classifier's documented logic.  No random or fabricated results
 * are used – every prediction is produced by calling the real production code.
 *
 * Usage
 * ─────
 *   node tools/confusion-matrix.js
 *
 * Output
 * ──────
 *   • Pretty-printed ASCII confusion matrices in the terminal
 *   • JSON report written to tools/confusion-matrix-report.json
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  classifyMemoryType,
  isSmallTalk,
  hasLowSignalContent,
  shouldStoreMemory,
  isDuplicate,
  similarity,
} from "@neura/core";

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  blue:   "\x1b[34m",
  dim:    "\x1b[2m",
  white:  "\x1b[37m",
};

const bold   = (s) => `${C.bold}${s}${C.reset}`;
const cyan   = (s) => `${C.cyan}${s}${C.reset}`;
const green  = (s) => `${C.green}${s}${C.reset}`;
const yellow = (s) => `${C.yellow}${s}${C.reset}`;
const red    = (s) => `${C.red}${s}${C.reset}`;
const blue   = (s) => `${C.blue}${s}${C.reset}`;
const dim    = (s) => `${C.dim}${s}${C.reset}`;

// ─── 1. TEST DATASETS ─────────────────────────────────────────────────────────
//
// Each entry carries:
//   input    – the raw input passed to the classifier
//   expected – the ground-truth label
//   note     – brief human annotation for the report
//
// Ground-truth labels were assigned by inspecting the classifier source code
// (pattern-sets.js, shared/src/index.js, extractor.js, deduplicationService.js)
// and applying the same logic a human reviewer would apply.

// ── 1a. classifyMemoryType ───────────────────────────────────────────────────

const MEMORY_TYPE_CASES = [
  // ── factual (identity, preferences, decisions, stable facts) ──────────────
  { input: "My name is Vinod Desai.",                                       expected: "factual",  note: "identity assertion → FACTUAL_PATTERNS[0]" },
  { input: "I am a senior software engineer at Google.",                     expected: "factual",  note: "identity + role assertion" },
  { input: "I prefer TypeScript over JavaScript for large codebases.",       expected: "factual",  note: "preference → FACTUAL_PATTERNS[1]" },
  { input: "I like using Redis for caching because it is extremely fast.",   expected: "factual",  note: "preference 'i like'" },
  { input: "I don't want to use MongoDB for relational data.",               expected: "factual",  note: "negative preference" },
  { input: "We decided to use Qdrant for our vector store.",                 expected: "factual",  note: "decision → FACTUAL_PATTERNS[4]" },
  { input: "I chose PostgreSQL over MySQL for the production database.",     expected: "factual",  note: "choice decision" },
  { input: "Our project is called AiNeura and it is a memory-centric AI.",  expected: "factual",  note: "project ownership fact" },
  { input: "My goal is to finish the MVP by the end of the month.",          expected: "factual",  note: "goal ownership → 'my goal'" },
  { input: "I work at Acme Corp and my role is Principal Architect.",        expected: "factual",  note: "work + role" },
  { input: "My email is vinod@example.com.",                                 expected: "factual",  note: "contact fact → FACTUAL_PATTERNS[5]" },
  { input: "We are building a memory system inspired by human cognition.",   expected: "factual",  note: "'we are' identity assertion" },
  { input: "I studied computer science and graduated in 2018.",              expected: "factual",  note: "education → FACTUAL_PATTERNS[7]" },
  { input: "My mother is a teacher and lives in Mumbai.",                    expected: "factual",  note: "family → FACTUAL_PATTERNS[6]" },
  { input: "I want the API to return results in under 200 ms.",              expected: "factual",  note: "preference/want" },

  // ── episodic (time-bound events, session/conversation history) ────────────
  { input: "Yesterday I fixed the memory dedup bug in the pipeline.",        expected: "episodic", note: "yesterday → EPISODIC_PATTERNS[0]" },
  { input: "We discussed the retrieval scoring formula earlier today.",       expected: "episodic", note: "today + discussed → EPISODIC_PATTERNS[2]" },
  { input: "Last week we completed the Qdrant integration.",                  expected: "episodic", note: "last week → EPISODIC_PATTERNS[1]" },
  { input: "This morning I deployed the new worker to staging.",              expected: "episodic", note: "this morning → EPISODIC_PATTERNS[0]" },
  { input: "We talked about using Neo4j for the graph store last time.",      expected: "episodic", note: "last time + talked → EPISODIC_PATTERNS[1,2]" },
  { input: "I just finished writing the hybrid retrieval scorer.",            expected: "episodic", note: "just finished → EPISODIC_PATTERNS[3]" },
  { input: "In this conversation we already decided on the schema.",          expected: "episodic", note: "in this conversation → EPISODIC_PATTERNS[6]" },
  { input: "You mentioned the recency decay formula moments ago.",            expected: "episodic", note: "moments ago → EPISODIC_PATTERNS[6]" },
  { input: "Previously we agreed on a 0.92 similarity threshold.",           expected: "episodic", note: "previously → EPISODIC_PATTERNS[1]" },
  { input: "I encountered a timeout error when querying Qdrant yesterday.",   expected: "episodic", note: "encountered + yesterday → EPISODIC_PATTERNS[3]" },
  { input: "First we build the extractor, then the scorer, after that the pipeline.", expected: "episodic", note: "timeline: first/then/after that → EPISODIC_PATTERNS[7]" },
  { input: "During the last sprint we added the Neo4j graph store.",          expected: "episodic", note: "during → EPISODIC_PATTERNS[4]" },
  { input: "I created the memory orchestrator last month.",                   expected: "episodic", note: "created + last month" },
  { input: "At that session we reviewed the deduplication logic.",            expected: "episodic", note: "at that session → EPISODIC_PATTERNS[4]" },
  { input: "A few minutes ago I added the fingerprint column to Postgres.",   expected: "episodic", note: "a few minutes ago → EPISODIC_PATTERNS[6]" },

  // ── semantic (general knowledge, concepts, patterns, best practices) ──────
  { input: "Jaccard similarity measures token-level set overlap between two texts.", expected: "semantic", note: "general concept definition" },
  { input: "Redis is generally preferred for sub-millisecond key-value lookups.",    expected: "semantic", note: "generally + technical terms → SEMANTIC_PATTERNS[0,3]" },
  { input: "Vector embeddings represent text as dense numeric arrays.",              expected: "semantic", note: "represents → SEMANTIC_PATTERNS[5]" },
  { input: "Because Qdrant uses HNSW, approximate nearest-neighbour search is fast.",expected: "semantic", note: "because + algorithm → SEMANTIC_PATTERNS[2,3]" },
  { input: "The concept of episodic memory refers to time-bound personal events.",   expected: "semantic", note: "concept + refers to → SEMANTIC_PATTERNS[1,5]" },
  { input: "Most databases require an index to achieve sub-linear query time.",      expected: "semantic", note: "most + require → SEMANTIC_PATTERNS[4]" },
  { input: "Cosine similarity is a best practice for comparing embedding vectors.",  expected: "semantic", note: "best practice → SEMANTIC_PATTERNS[6]" },
  { input: "A good architecture separates the retrieval layer from storage.",        expected: "semantic", note: "architecture + pattern → SEMANTIC_PATTERNS[3]" },
  { input: "Typically, semantic memories encode abstract generalised knowledge.",    expected: "semantic", note: "typically → SEMANTIC_PATTERNS[0]" },
  { input: "The strategy of hybrid retrieval combines vector and lexical signals.",  expected: "semantic", note: "strategy → SEMANTIC_PATTERNS[1]" },
  { input: "Exponential decay means older memories contribute less to context.",     expected: "semantic", note: "means → SEMANTIC_PATTERNS[5]" },
];

// ── 1b. isSmallTalk ──────────────────────────────────────────────────────────
//   Logic: trimmed.split(/\s+/).length <= 2  AND  one of SMALL_TALK_WORDS present

const SMALL_TALK_CASES = [
  // positive – should be small talk
  { input: "hi",             expected: true,  note: "single word, in SMALL_TALK_WORDS" },
  { input: "Hello",          expected: true,  note: "single word greeting" },
  { input: "hey",            expected: true,  note: "casual greeting" },
  { input: "ok",             expected: true,  note: "one-word acknowledgement" },
  { input: "okay",           expected: true,  note: "one-word acknowledgement variant" },
  { input: "thanks",         expected: true,  note: "one-word courtesy" },
  { input: "bye",            expected: true,  note: "farewell single word" },
  { input: "yes",            expected: true,  note: "one-word affirmative" },
  { input: "no",             expected: true,  note: "one-word negative" },
  { input: "sure",           expected: true,  note: "one-word agreement" },
  { input: "great",          expected: true,  note: "one-word reaction" },
  { input: "cool",           expected: true,  note: "one-word approval" },
  { input: "good",           expected: true,  note: "one-word positive" },
  { input: "how are you",    expected: true,  note: "3 words but exact match phrase in SMALL_TALK_WORDS" },
  { input: "Hi!",            expected: true,  note: "greeting with punctuation (stripped)" },
  // negative – should NOT be small talk
  { input: "My name is Vinod.",                                         expected: false, note: "factual statement, >2 words" },
  { input: "We decided to use Qdrant.",                                 expected: false, note: "decision, 5 words" },
  { input: "Yesterday I fixed the memory dedup bug.",                   expected: false, note: "episodic, many words" },
  { input: "Can you explain the hybrid retrieval pipeline?",            expected: false, note: "question, many words" },
  { input: "How does the recency decay formula work?",                  expected: false, note: "question, >2 words" },
  { input: "I prefer TypeScript.",                                      expected: false, note: "preference statement, 3 words without small-talk word" },
  { input: "ok let me explain the architecture in detail",              expected: false, note: "starts with ok but has many words" },
  { input: "great job on the pipeline",                                 expected: false, note: "great present but >2 words" },
  { input: "hello world this is a test",                                expected: false, note: "hello present but >2 words" },
  { input: "Qdrant is a vector database.",                              expected: false, note: "technical statement, no small-talk match" },
  { input: "no need to worry about the memory leak",                    expected: false, note: "no is there but >2 words" },
  { input: "sure I will fix the bug tomorrow",                          expected: false, note: "sure present but >2 words" },
  { input: "Redis handles the working memory bundle.",                  expected: false, note: "informational, no small-talk word" },
  { input: "thanks for the detailed explanation of vector stores",      expected: false, note: "thanks present but >2 words" },
  { input: "I want to ship the MVP by Friday.",                         expected: false, note: "factual intent, no small-talk word" },
];

// ── 1c. hasLowSignalContent ─────────────────────────────────────────────────
//   Logic: LOW_SIGNAL_PHRASES.includes(lower) OR lower.length < 8

const LOW_SIGNAL_CASES = [
  // positive – low signal
  { input: "hi",         expected: true,  note: "in LOW_SIGNAL_PHRASES" },
  { input: "hello",      expected: true,  note: "in LOW_SIGNAL_PHRASES" },
  { input: "thanks",     expected: true,  note: "in LOW_SIGNAL_PHRASES" },
  { input: "thank you",  expected: true,  note: "in LOW_SIGNAL_PHRASES" },
  { input: "okay",       expected: true,  note: "in LOW_SIGNAL_PHRASES" },
  { input: "ok",         expected: true,  note: "in LOW_SIGNAL_PHRASES AND length < 8" },
  { input: "cool",       expected: true,  note: "in LOW_SIGNAL_PHRASES" },
  { input: "great",      expected: true,  note: "in LOW_SIGNAL_PHRASES" },
  { input: "yep",        expected: true,  note: "length=3 < 8" },
  { input: "lol",        expected: true,  note: "length=3 < 8" },
  { input: "yes",        expected: true,  note: "length=3 < 8" },
  { input: "no",         expected: true,  note: "length=2 < 8" },
  { input: "sure",       expected: true,  note: "length=4 < 8" },
  // negative – has signal
  { input: "I prefer TypeScript for large projects.",                          expected: false, note: "preference fact, >8 chars, not in phrase list" },
  { input: "My name is Vinod.",                                                expected: false, note: "identity fact" },
  { input: "We decided to use Qdrant as our vector store.",                    expected: false, note: "decision, many chars" },
  { input: "Yesterday I deployed the new API to staging.",                     expected: false, note: "episodic, many chars" },
  { input: "Cosine similarity is used for comparing embeddings.",              expected: false, note: "semantic, many chars" },
  { input: "The memory worker processes jobs from the Redis queue.",           expected: false, note: "architectural fact, many chars" },
  { input: "thanks a lot for the thorough explanation",                        expected: false, note: "'thanks' is a phrase but full string is not in list, length > 8 → hasLowSignal checks exact phrase match only" },
  { input: "okay but what does the recency decay do?",                         expected: false, note: "'okay' in list but full string is not an exact match" },
  { input: "I like Redis.",                                                     expected: false, note: "preference, 9 chars" },
  { input: "I want to build a memory-aware AI assistant for my startup.",       expected: false, note: "long factual content" },
  { input: "Architecture is important for scalability.",                        expected: false, note: "semantic, many chars" },
  { input: "We are shipping the MVP next sprint.",                              expected: false, note: "factual, many chars" },
];

// ── 1d. shouldStoreMemory ────────────────────────────────────────────────────
//   Rules (from extractor.js):
//     – empty or hasLowSignalContent → false
//     – memory-query patterns → false
//     – assistant AiNeura demo/fallback messages → false
//     – assistant: only if contains plan/decision/architecture/we should/next step
//     – semantic: only if length > 24
//     – user, non-semantic, non-low-signal → true

const STORE_MEMORY_CASES = [
  // should store – user factual
  { input: { role: "user", content: "My name is Vinod.",                            memoryType: "factual"  }, expected: true,  note: "user factual, passes all gates" },
  { input: { role: "user", content: "I prefer TypeScript for backend projects.",    memoryType: "factual"  }, expected: true,  note: "user preference fact" },
  { input: { role: "user", content: "Our goal is to ship the MVP by next month.",   memoryType: "factual"  }, expected: true,  note: "user goal" },
  { input: { role: "user", content: "I decided to move the auth layer to the API.", memoryType: "factual"  }, expected: true,  note: "user decision" },
  // should store – user episodic
  { input: { role: "user", content: "Yesterday I fixed the dedup bug in the worker.", memoryType: "episodic" }, expected: true,  note: "user episodic, passes all gates" },
  { input: { role: "user", content: "We discussed the retrieval pipeline earlier.", memoryType: "episodic" }, expected: true,  note: "user episodic" },
  // should store – user semantic (length > 24)
  { input: { role: "user", content: "Jaccard similarity measures token-level overlap.", memoryType: "semantic" }, expected: true,  note: "user semantic, 48 chars > 24" },
  { input: { role: "user", content: "Redis is typically faster than Postgres for caching.", memoryType: "semantic" }, expected: true, note: "user semantic, >24 chars" },
  // should store – assistant with planning language
  { input: { role: "assistant", content: "Our plan is to implement hybrid retrieval first, then add the Neo4j layer.", memoryType: "semantic" }, expected: true,  note: "assistant with 'plan'" },
  { input: { role: "assistant", content: "The decision was made to use cosine similarity for dedup.", memoryType: "factual" }, expected: true,  note: "assistant with 'decision'" },
  { input: { role: "assistant", content: "The architecture should separate the storage layer from retrieval.", memoryType: "semantic" }, expected: true,  note: "assistant with 'architecture'" },
  { input: { role: "assistant", content: "We should start with the memory extractor before the scorer.", memoryType: "episodic" }, expected: true,  note: "assistant with 'we should'" },
  { input: { role: "assistant", content: "The next step is to add embedding caching to Redis.", memoryType: "factual" }, expected: true,  note: "assistant with 'next step'" },
  // should NOT store – empty / low-signal
  { input: { role: "user", content: "hi",    memoryType: "factual"  }, expected: false, note: "low-signal greeting" },
  { input: { role: "user", content: "ok",    memoryType: "factual"  }, expected: false, note: "low-signal ack" },
  { input: { role: "user", content: "great", memoryType: "factual"  }, expected: false, note: "low-signal phrase" },
  // should NOT store – memory queries
  { input: { role: "user", content: "What do you remember about our last session?", memoryType: "semantic" }, expected: false, note: "memory query pattern" },
  { input: { role: "user", content: "Do you remember what I told you yesterday?",   memoryType: "episodic" }, expected: false, note: "memory query pattern" },
  { input: { role: "user", content: "Can you remember the project name?",           memoryType: "factual"  }, expected: false, note: "memory query pattern" },
  { input: { role: "user", content: "What do you know about the AiNeura system?",   memoryType: "semantic" }, expected: false, note: "what do you know pattern" },
  // should NOT store – assistant without planning language
  { input: { role: "assistant", content: "Sure, I can help with that request.",                 memoryType: "semantic" }, expected: false, note: "assistant without planning keywords" },
  { input: { role: "assistant", content: "The retrieval pipeline works by combining vector and lexical scores.", memoryType: "semantic" }, expected: false, note: "assistant informational, no plan/decision" },
  { input: { role: "assistant", content: "That is an interesting approach to memory management.", memoryType: "semantic" }, expected: false, note: "assistant generic, no planning keywords" },
  // should NOT store – assistant demo/fallback
  { input: { role: "assistant", content: "AiNeura demo response: this is a placeholder.",       memoryType: "semantic" }, expected: false, note: "demo response prefix" },
  // should NOT store – user semantic too short
  { input: { role: "user", content: "Algorithms.",                           memoryType: "semantic" }, expected: false, note: "user semantic, 10 chars ≤ 24" },
  { input: { role: "user", content: "Redis cache.",                          memoryType: "semantic" }, expected: false, note: "user semantic, 11 chars ≤ 24" },
  { input: { role: "user", content: "Architecture.",                         memoryType: "semantic" }, expected: false, note: "user semantic, 12 chars ≤ 24" },
  { input: { role: "user", content: "Good design.",                          memoryType: "semantic" }, expected: false, note: "user semantic, 11 chars ≤ 24" },
  { input: { role: "user", content: "Vector DB.",                            memoryType: "semantic" }, expected: false, note: "user semantic, 9 chars ≤ 24" },
];

// ── 1e. isDuplicate ──────────────────────────────────────────────────────────
//   Logic: Jaccard similarity of token sets ≥ DEFAULT_DEDUP_THRESHOLD (0.92)

const DEDUP_CASES = [
  // duplicate – high overlap
  { input: { a: "My name is Vinod.",              b: "My name is Vinod."                     }, expected: true,  note: "identical strings → similarity = 1.0" },
  { input: { a: "I prefer TypeScript.",           b: "I prefer TypeScript."                  }, expected: true,  note: "identical" },
  { input: { a: "We use Qdrant for vectors.",     b: "We use Qdrant for vectors."             }, expected: true,  note: "identical" },
  { input: { a: "my name is vinod desai",         b: "My name is Vinod Desai."               }, expected: true,  note: "same content, different case/punctuation" },
  { input: { a: "I prefer TypeScript for large codebases", b: "i prefer typescript for large codebases" }, expected: true, note: "case-normalised identical" },
  // not duplicate – clearly different content
  { input: { a: "My name is Vinod.",              b: "I prefer TypeScript."                  }, expected: false, note: "different factual claims" },
  { input: { a: "We use Qdrant for vectors.",     b: "Yesterday I fixed the dedup bug."       }, expected: false, note: "different type and content" },
  { input: { a: "I prefer TypeScript.",           b: "Jaccard similarity measures token overlap." }, expected: false, note: "completely different content" },
  { input: { a: "My name is Vinod Desai.",        b: "I work at Acme Corp."                  }, expected: false, note: "both factual but different facts" },
  { input: { a: "Redis is fast.",                 b: "Qdrant is a vector database."           }, expected: false, note: "different technology statements" },
  { input: { a: "I like using Redis for caching because it is extremely fast and reliable.", b: "I prefer TypeScript over JavaScript for large codebases and enterprise apps." }, expected: false, note: "long strings, different content" },
  { input: { a: "Yesterday I deployed the new worker to staging.", b: "My name is Vinod."    }, expected: false, note: "completely different" },
  { input: { a: "Cosine similarity is a best practice.",    b: "I prefer TypeScript."         }, expected: false, note: "semantic vs factual" },
  { input: { a: "We discussed the retrieval pipeline.",     b: "We use Qdrant for vectors."   }, expected: false, note: "different episodic vs factual" },
  { input: { a: "The memory system uses four stores.",      b: "My goal is to finish the MVP." }, expected: false, note: "architectural vs goal" },
  // near-threshold pairs (short text uses LCS blend — more likely non-dup unless truly identical)
  { input: { a: "hi",                              b: "hi"                                   }, expected: true,  note: "trivial identical short strings" },
  { input: { a: "ok",                              b: "ok"                                   }, expected: true,  note: "trivial identical short strings" },
  { input: { a: "hi",                              b: "hello"                                }, expected: false, note: "different greeting words" },
  { input: { a: "Redis",                           b: "Qdrant"                               }, expected: false, note: "different single tokens" },
  { input: { a: "I prefer TypeScript for backend", b: "I prefer TypeScript for frontend"     }, expected: false, note: "differ on last token" },
];

// ─── 2. CONFUSION MATRIX COMPUTATION ─────────────────────────────────────────

/**
 * Run a binary classifier against a test dataset and accumulate TP/TN/FP/FN.
 *
 * @param {Array<{input: any, expected: boolean, note: string}>} cases
 * @param {(input: any) => boolean} classifier
 * @returns {{ tp, tn, fp, fn, results: Array }}
 */
function runBinary(cases, classifier) {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  const results = [];
  for (const tc of cases) {
    const predicted = classifier(tc.input);
    const correct = predicted === tc.expected;
    if (tc.expected === true  && predicted === true)  tp++;
    if (tc.expected === false && predicted === false) tn++;
    if (tc.expected === false && predicted === true)  fp++;
    if (tc.expected === true  && predicted === false) fn++;
    results.push({ input: tc.input, expected: tc.expected, predicted, correct, note: tc.note });
  }
  return { tp, tn, fp, fn, results };
}

/**
 * Run the multiclass classifyMemoryType against a test dataset.
 * Returns per-class confusion tallies (one-vs-rest) and an overall accuracy.
 *
 * @param {Array<{input: string, expected: string, note: string}>} cases
 * @param {(input: string) => string} classifier
 * @returns {{ byClass: Record<string,{tp,tn,fp,fn}>, results: Array, accuracy: number }}
 */
function runMulticlass(cases, classifier) {
  const classes = ["factual", "episodic", "semantic"];
  const byClass = {};
  classes.forEach((cls) => { byClass[cls] = { tp: 0, tn: 0, fp: 0, fn: 0 }; });

  const matrix = {};          // actual → predicted → count
  classes.forEach((a) => { matrix[a] = {}; classes.forEach((p) => { matrix[a][p] = 0; }); });

  const results = [];
  let correct = 0;

  for (const tc of cases) {
    const predicted = classifier(tc.input);
    const isCorrect = predicted === tc.expected;
    if (isCorrect) correct++;
    matrix[tc.expected][predicted]++;

    // One-vs-rest per class
    for (const cls of classes) {
      const actualPos    = tc.expected   === cls;
      const predictedPos = predicted === cls;
      if (actualPos  && predictedPos) byClass[cls].tp++;
      if (!actualPos && !predictedPos) byClass[cls].tn++;
      if (!actualPos && predictedPos)  byClass[cls].fp++;
      if (actualPos  && !predictedPos) byClass[cls].fn++;
    }

    results.push({ input: tc.input, expected: tc.expected, predicted, correct: isCorrect, note: tc.note });
  }

  return {
    byClass,
    matrix,
    results,
    accuracy: correct / cases.length,
    correctCount: correct,
    total: cases.length,
  };
}

/**
 * Compute precision, recall, F1 from a {tp, tn, fp, fn} object.
 *
 * @param {{ tp, tn, fp, fn }} counts
 * @returns {{ precision, recall, f1, accuracy }}
 */
function metrics({ tp, tn, fp, fn }) {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall    = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1        = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  const total     = tp + tn + fp + fn;
  const accuracy  = total === 0 ? 0 : (tp + tn) / total;
  return { precision, recall, f1, accuracy };
}

// ─── 3. RUNNER ────────────────────────────────────────────────────────────────

function pct(n) { return `${(n * 100).toFixed(1)}%`; }
function f3(n)  { return n.toFixed(3); }

function bar(value, width = 20) {
  const filled = Math.round(value * width);
  return green("█".repeat(filled)) + dim("░".repeat(width - filled));
}

function printSeparator(label, char = "═") {
  const line = char.repeat(70);
  console.log(`\n${cyan(bold(line))}`);
  if (label) console.log(`${cyan(bold(`  ▶ ${label}`))}`)
  console.log(`${cyan(bold(line))}`);
}

function printBinaryResults(label, { tp, tn, fp, fn, results }) {
  const m = metrics({ tp, tn, fp, fn });
  const errors = results.filter((r) => !r.correct);

  printSeparator(label);

  // Confusion matrix table
  console.log("\n  Confusion Matrix (Positive = true):\n");
  console.log("  ┌─────────────────────┬───────────────────┬───────────────────┐");
  console.log("  │                     │  Pred TRUE        │  Pred FALSE       │");
  console.log("  ├─────────────────────┼───────────────────┼───────────────────┤");
  console.log(`  │  Actual TRUE        │  ${green(`TP = ${String(tp).padEnd(11)}`)}  │  ${red(`FN = ${String(fn).padEnd(11)}`)}  │`);
  console.log(`  │  Actual FALSE       │  ${red(`FP = ${String(fp).padEnd(11)}`)}  │  ${green(`TN = ${String(tn).padEnd(11)}`)}  │`);
  console.log("  └─────────────────────┴───────────────────┴───────────────────┘");

  // Metrics
  console.log("\n  Metrics:");
  console.log(`    Accuracy  : ${bar(m.accuracy)}  ${bold(pct(m.accuracy))} (${tp + tn}/${tp + tn + fp + fn})`);
  console.log(`    Precision : ${bar(m.precision)}  ${bold(pct(m.precision))}`);
  console.log(`    Recall    : ${bar(m.recall)}     ${bold(pct(m.recall))}`);
  console.log(`    F1 Score  : ${bar(m.f1)}         ${bold(f3(m.f1))}`);

  // Misclassified cases
  if (errors.length === 0) {
    console.log(`\n  ${green("✓ All cases classified correctly.")}`);
  } else {
    console.log(`\n  ${yellow(`⚠ Misclassified cases (${errors.length}):`)} `);
    for (const e of errors) {
      const inputStr = typeof e.input === "string"
        ? `"${e.input.slice(0, 60)}"`
        : JSON.stringify({ role: e.input.role, content: e.input.content.slice(0, 50) });
      console.log(`    ${red("✗")} Expected ${bold(String(e.expected))} | Got ${bold(String(e.predicted))}`);
      console.log(`      Input  : ${dim(inputStr)}`);
      console.log(`      Note   : ${dim(e.note)}`);
    }
  }

  return { tp, tn, fp, fn, ...m, errors };
}

function printMulticlassResults(label, result) {
  const { byClass, matrix, accuracy, correctCount, total } = result;
  const classes = ["factual", "episodic", "semantic"];
  const errors  = result.results.filter((r) => !r.correct);

  printSeparator(label);

  // Full confusion matrix
  console.log("\n  Full Confusion Matrix (rows = Actual, cols = Predicted):\n");
  const colWidth = 12;
  const header = "  " + "Actual \\ Pred".padEnd(colWidth + 2) +
    classes.map((c) => c.padEnd(colWidth)).join("");
  console.log(cyan(header));
  console.log("  " + "─".repeat(colWidth + 2 + classes.length * colWidth));
  for (const actual of classes) {
    let row = "  " + actual.padEnd(colWidth + 2);
    for (const pred of classes) {
      const count = matrix[actual][pred];
      const cell = String(count).padEnd(colWidth);
      row += actual === pred ? green(cell) : (count > 0 ? red(cell) : dim(cell));
    }
    console.log(row);
  }

  // Per-class metrics
  console.log("\n  Per-class Metrics (One-vs-Rest):\n");
  console.log(
    "  " +
    "Class".padEnd(12) +
    "TP".padEnd(6) + "TN".padEnd(6) + "FP".padEnd(6) + "FN".padEnd(6) +
    "Precision".padEnd(12) + "Recall".padEnd(12) + "F1".padEnd(12) + "Accuracy"
  );
  console.log("  " + "─".repeat(80));
  const perClass = {};
  for (const cls of classes) {
    const m = metrics(byClass[cls]);
    perClass[cls] = m;
    console.log(
      "  " +
      cls.padEnd(12) +
      String(byClass[cls].tp).padEnd(6) +
      String(byClass[cls].tn).padEnd(6) +
      String(byClass[cls].fp).padEnd(6) +
      String(byClass[cls].fn).padEnd(6) +
      pct(m.precision).padEnd(12) +
      pct(m.recall).padEnd(12) +
      f3(m.f1).padEnd(12) +
      pct(m.accuracy)
    );
  }

  // Macro averages
  const macroPrec = classes.reduce((s, c) => s + perClass[c].precision, 0) / classes.length;
  const macroRec  = classes.reduce((s, c) => s + perClass[c].recall, 0)    / classes.length;
  const macroF1   = classes.reduce((s, c) => s + perClass[c].f1, 0)        / classes.length;

  console.log("  " + "─".repeat(80));
  console.log(
    `  ${"Macro avg".padEnd(12)}${" ".repeat(24)}${pct(macroPrec).padEnd(12)}${pct(macroRec).padEnd(12)}${f3(macroF1).padEnd(12)}`
  );

  console.log(`\n  Overall accuracy: ${bar(accuracy)} ${bold(pct(accuracy))} (${correctCount}/${total})`);

  if (errors.length === 0) {
    console.log(`\n  ${green("✓ All cases classified correctly.")}`);
  } else {
    console.log(`\n  ${yellow(`⚠ Misclassified cases (${errors.length}):`)} `);
    for (const e of errors) {
      console.log(`    ${red("✗")} Expected ${bold(e.expected)} | Got ${bold(e.predicted)}`);
      console.log(`      Input: ${dim(`"${e.input.slice(0, 70)}"`)}`);
      console.log(`      Note : ${dim(e.note)}`);
    }
  }

  return { byClass, perClass, macroPrec, macroRec, macroF1, accuracy, errors };
}

// ─── 4. MAIN ──────────────────────────────────────────────────────────────────

console.log("\n");
console.log(bold(cyan("╔══════════════════════════════════════════════════════════════════════╗")));
console.log(bold(cyan("║         NEURA AI – CLASSIFIER CONFUSION MATRIX REPORT               ║")));
console.log(bold(cyan("╚══════════════════════════════════════════════════════════════════════╝")));
console.log(dim(`  Generated: ${new Date().toISOString()}`));

// ── Classifier 1: classifyMemoryType ─────────────────────────────────────────
const memTypeResult = runMulticlass(MEMORY_TYPE_CASES, (input) => classifyMemoryType(input));
const memTypeReport = printMulticlassResults("Classifier 1: classifyMemoryType", memTypeResult);

// ── Classifier 2: isSmallTalk ────────────────────────────────────────────────
const smallTalkRaw = runBinary(SMALL_TALK_CASES, (input) => isSmallTalk(input));
const smallTalkReport = printBinaryResults("Classifier 2: isSmallTalk", smallTalkRaw);

// ── Classifier 3: hasLowSignalContent ────────────────────────────────────────
const lowSignalRaw = runBinary(LOW_SIGNAL_CASES, (input) => hasLowSignalContent(input));
const lowSignalReport = printBinaryResults("Classifier 3: hasLowSignalContent", lowSignalRaw);

// ── Classifier 4: shouldStoreMemory ──────────────────────────────────────────
const storeMemRaw = runBinary(STORE_MEMORY_CASES, (input) => shouldStoreMemory(input));
const storeMemReport = printBinaryResults("Classifier 4: shouldStoreMemory", storeMemRaw);

// ── Classifier 5: isDuplicate ────────────────────────────────────────────────
const dedupRaw = runBinary(DEDUP_CASES, (input) => isDuplicate(input.a, input.b));
const dedupReport = printBinaryResults("Classifier 5: isDuplicate", dedupRaw);

// ─── 5. SUMMARY TABLE ────────────────────────────────────────────────────────

printSeparator("OVERALL SUMMARY", "═");

console.log(`
  ┌──────────────────────────────┬────────┬───────────┬──────────┬──────────┬──────────┐
  │ Classifier                   │  N     │ Accuracy  │ Precision│ Recall   │ F1       │
  ├──────────────────────────────┼────────┼───────────┼──────────┼──────────┼──────────┤`);

function summaryRow(name, n, accuracy, precision, recall, f1) {
  return `  │ ${name.padEnd(28)} │ ${String(n).padEnd(6)} │ ${pct(accuracy).padEnd(9)} │ ${pct(precision).padEnd(8)} │ ${pct(recall).padEnd(8)} │ ${f3(f1).padEnd(8)} │`;
}

console.log(summaryRow(
  "classifyMemoryType",
  MEMORY_TYPE_CASES.length,
  memTypeResult.accuracy,
  memTypeReport.macroPrec,
  memTypeReport.macroRec,
  memTypeReport.macroF1
));
console.log(summaryRow(
  "isSmallTalk",
  SMALL_TALK_CASES.length,
  smallTalkReport.accuracy,
  smallTalkReport.precision,
  smallTalkReport.recall,
  smallTalkReport.f1
));
console.log(summaryRow(
  "hasLowSignalContent",
  LOW_SIGNAL_CASES.length,
  lowSignalReport.accuracy,
  lowSignalReport.precision,
  lowSignalReport.recall,
  lowSignalReport.f1
));
console.log(summaryRow(
  "shouldStoreMemory",
  STORE_MEMORY_CASES.length,
  storeMemReport.accuracy,
  storeMemReport.precision,
  storeMemReport.recall,
  storeMemReport.f1
));
console.log(summaryRow(
  "isDuplicate",
  DEDUP_CASES.length,
  dedupReport.accuracy,
  dedupReport.precision,
  dedupReport.recall,
  dedupReport.f1
));

console.log(`  └──────────────────────────────┴────────┴───────────┴──────────┴──────────┴──────────┘`);

// ─── 6. JSON REPORT ───────────────────────────────────────────────────────────

const report = {
  meta: {
    generatedAt:   new Date().toISOString(),
    nodeVersion:   process.version,
    description:   "Neura AI classifier confusion matrix report. All predictions produced by live production code. No synthetic/random values.",
    methodology:   "Each classifier was invoked with hand-labelled inputs grounded in the classifier's documented source logic. Binary classifiers report TP/TN/FP/FN plus precision, recall, and F1. The multi-class classifier (classifyMemoryType) reports a 3×3 confusion matrix plus one-vs-rest per-class metrics and macro-averages.",
  },
  classifiers: {
    classifyMemoryType: {
      type:     "multiclass",
      classes:  ["factual", "episodic", "semantic"],
      n:        MEMORY_TYPE_CASES.length,
      accuracy: +memTypeResult.accuracy.toFixed(4),
      matrix:   memTypeResult.matrix,
      perClass: Object.fromEntries(
        Object.entries(memTypeReport.perClass).map(([k, v]) => [k, {
          tp: memTypeResult.byClass[k].tp,
          tn: memTypeResult.byClass[k].tn,
          fp: memTypeResult.byClass[k].fp,
          fn: memTypeResult.byClass[k].fn,
          precision: +v.precision.toFixed(4),
          recall:    +v.recall.toFixed(4),
          f1:        +v.f1.toFixed(4),
          accuracy:  +v.accuracy.toFixed(4),
        }])
      ),
      macroAvg: {
        precision: +memTypeReport.macroPrec.toFixed(4),
        recall:    +memTypeReport.macroRec.toFixed(4),
        f1:        +memTypeReport.macroF1.toFixed(4),
      },
      misclassifiedCases: memTypeResult.results
        .filter((r) => !r.correct)
        .map((r) => ({ input: r.input, expected: r.expected, predicted: r.predicted, note: r.note })),
    },
    isSmallTalk: {
      type:      "binary",
      n:         SMALL_TALK_CASES.length,
      tp:        smallTalkRaw.tp,
      tn:        smallTalkRaw.tn,
      fp:        smallTalkRaw.fp,
      fn:        smallTalkRaw.fn,
      accuracy:  +smallTalkReport.accuracy.toFixed(4),
      precision: +smallTalkReport.precision.toFixed(4),
      recall:    +smallTalkReport.recall.toFixed(4),
      f1:        +smallTalkReport.f1.toFixed(4),
      misclassifiedCases: smallTalkRaw.results
        .filter((r) => !r.correct)
        .map((r) => ({ input: r.input, expected: r.expected, predicted: r.predicted, note: r.note })),
    },
    hasLowSignalContent: {
      type:      "binary",
      n:         LOW_SIGNAL_CASES.length,
      tp:        lowSignalRaw.tp,
      tn:        lowSignalRaw.tn,
      fp:        lowSignalRaw.fp,
      fn:        lowSignalRaw.fn,
      accuracy:  +lowSignalReport.accuracy.toFixed(4),
      precision: +lowSignalReport.precision.toFixed(4),
      recall:    +lowSignalReport.recall.toFixed(4),
      f1:        +lowSignalReport.f1.toFixed(4),
      misclassifiedCases: lowSignalRaw.results
        .filter((r) => !r.correct)
        .map((r) => ({ input: r.input, expected: r.expected, predicted: r.predicted, note: r.note })),
    },
    shouldStoreMemory: {
      type:      "binary",
      n:         STORE_MEMORY_CASES.length,
      tp:        storeMemRaw.tp,
      tn:        storeMemRaw.tn,
      fp:        storeMemRaw.fp,
      fn:        storeMemRaw.fn,
      accuracy:  +storeMemReport.accuracy.toFixed(4),
      precision: +storeMemReport.precision.toFixed(4),
      recall:    +storeMemReport.recall.toFixed(4),
      f1:        +storeMemReport.f1.toFixed(4),
      misclassifiedCases: storeMemRaw.results
        .filter((r) => !r.correct)
        .map((r) => ({ input: r.input, expected: r.expected, predicted: r.predicted, note: r.note })),
    },
    isDuplicate: {
      type:      "binary",
      n:         DEDUP_CASES.length,
      tp:        dedupRaw.tp,
      tn:        dedupRaw.tn,
      fp:        dedupRaw.fp,
      fn:        dedupRaw.fn,
      accuracy:  +dedupReport.accuracy.toFixed(4),
      precision: +dedupReport.precision.toFixed(4),
      recall:    +dedupReport.recall.toFixed(4),
      f1:        +dedupReport.f1.toFixed(4),
      misclassifiedCases: dedupRaw.results
        .filter((r) => !r.correct)
        .map((r) => ({ input: { a: r.input.a, b: r.input.b }, expected: r.expected, predicted: r.predicted, note: r.note })),
    },
  },
};

const reportPath = new URL("./confusion-matrix-report.json", import.meta.url);
writeFileSync(fileURLToPath(reportPath), JSON.stringify(report, null, 2));

console.log(`\n  ${green("✓")} JSON report written to ${bold("tools/confusion-matrix-report.json")}`);
console.log(dim("\n  Methodology note: all predictions are from live production code (packages/core + packages/shared)."));
console.log(dim("  Ground-truth labels were assigned by reading classifier source code logic, not by running the model.\n"));
