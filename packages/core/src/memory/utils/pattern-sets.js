/**
 * packages/core/src/memory/utils/pattern-sets.js
 *
 * Regex pattern sets used by the memory-type classifier.
 *
 * These are intentionally separated from the scoring helpers so pattern
 * sets can be audited, extended, and unit-tested in isolation.
 *
 * Previously lived in packages/core/src/utils/index.js — moved here so
 * they are co-located with the classifier that owns them.
 */

// ─── Factual patterns ─────────────────────────────────────────────────────────

/**
 * Patterns that signal a stable, user-specific fact that should be stored
 * as a `"factual"` memory (e.g. identity assertions, preferences, decisions).
 *
 * @type {RegExp[]}
 */
export const FACTUAL_PATTERNS = [
  // Identity assertions
  /\b(my name is|i am|i'm|we are|i'm a|i am a)\b/i,
  // Preferences
  /\b(i prefer|i like|i dislike|i want|we want|i don't want)\b/i,
  // Project / ownership
  /\b(my project|our project|our goal|my goal|i own|we own)\b/i,
  // Stable characteristics
  /\b(i'm based in|i live in|i work at|i study at|my role is)\b/i,
  // Decisions made
  /\b(i decided|we decided|i chose|we chose)\b/i,
  // Persistent contact / account facts
  /\b(my email|my phone|my username|my password|my url|my domain)\b/i,
  // Family / relationships
  /\b(my (mother|father|sibling|spouse|partner|daughter|son))\b/i,
  // Education / credentials
  /\b(i studied|i graduated|i majored|my degree|my certification)\b/i
];

// ─── Episodic patterns ────────────────────────────────────────────────────────

/**
 * Patterns that signal a time-bound event tied to a session or moment,
 * indicating the memory should be stored as `"episodic"`.
 *
 * @type {RegExp[]}
 */
export const EPISODIC_PATTERNS = [
  // Recent past
  /\b(yesterday|today|this morning|this afternoon|tonight)\b/i,
  // Temporal references
  /\b(last (time|week|month|day)|earlier|previously|before)\b/i,
  // Conversation history
  /\b(we (discussed|talked|decided|built|made)|you (said|told|mentioned)|i (told|said|mentioned))\b/i,
  // Experience markers
  /\b(i (experienced|encountered|faced|went through|just finished|completed))\b/i,
  // Specific events
  /\b(when we|during|at that|in that session|that time)\b/i,
  // Recent actions (optional temporal tail)
  /\b(i (built|created|added|fixed|changed|updated).*yesterday|today|last)\b/i,
  // Session-specific
  /\b(in this conversation|in this session|just now|moments ago|a few minutes ago)\b/i,
  // Timeline progression
  /\b(first|then|next|after that|later|afterward)\b/i
];

// ─── Semantic patterns ────────────────────────────────────────────────────────

/**
 * Patterns that signal general / conceptual knowledge not tied to a
 * specific event or person, indicating the memory should be stored as
 * `"semantic"`.
 *
 * @type {RegExp[]}
 */
export const SEMANTIC_PATTERNS = [
  // General knowledge
  /\b(generally|usually|typically|normally|in general)\b/i,
  // Conceptual framing
  /\b(concept of|idea|approach|method|strategy|pattern)\b/i,
  // Reasoning connectives
  /\b(because|since|therefore|thus|which means)\b/i,
  // Technical domain terms
  /\b(react|nodejs|database|api|architecture|algorithm)\b/i,
  // Universal statements
  /\b((all|most|many|some)([\s\w]+)?(is|are|require|need|benefit from|involve))\b/i,
  // Definitions
  /\b((is defined as|refers to|means|implies|represents|signifies))\b/i,
  // Best practices
  /\b(best practice|good practice|standard|convention|rule|principle)\b/i
];
