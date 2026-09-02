#!/usr/bin/env node
/**
 * tools/seed-context-evaluation-data.js
 *
 * Reproducible seed script for context-retrieval evaluation.
 *
 * Populates an isolated test namespace in the production databases with
 * ~150 realistic memory records across 8 categories, using stable IDs so
 * expected-vs-fetched comparison is always possible.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  ISOLATION GUARANTEE                                                    │
 * │  All records use:                                                       │
 * │    userId    = "eval-user-001"                                          │
 * │    sessionId = "eval-session-<category>"                                │
 * │  IDs all begin with "eval-" so they are trivially filterable.          │
 * │  Run `npm run seed-context-evaluation -- --reset` to wipe and reseed.  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *   node tools/seed-context-evaluation-data.js
 *   node tools/seed-context-evaluation-data.js --reset      (wipe + reseed)
 *   node tools/seed-context-evaluation-data.js --dry-run    (print plan, no DB writes)
 *
 * Environment:
 *   POSTGRES_URL   – Neon / PostgreSQL connection string
 *   POSTGRES_SSL   – "require" (default) or "disable"
 *   QDRANT_URL     – Qdrant cloud endpoint
 *   QDRANT_API_KEY – Qdrant API key
 *   QDRANT_COLLECTION – collection name (default: neura_vector_memories)
 *   OPENAI_API_KEY  – API key for embedding model
 *   OPENAI_BASE_URL – Base URL for OpenAI-compatible provider (Gemini etc.)
 *   OPENAI_EMBEDDING_MODEL – embedding model name
 *
 * The script does NOT require the full API server to be running.
 * It calls Postgres and Qdrant directly via their native APIs.
 */

// ─── Load .env ────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, "..");

function loadDotenv(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadDotenv(resolve(ROOT, ".env"));
loadDotenv(resolve(ROOT, ".env.local"));

// ─── CLI flags ────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const RESET   = args.includes("--reset");
const DRY_RUN = args.includes("--dry-run");

// ─── Constants ────────────────────────────────────────────────────────────────

const EVAL_USER_ID    = "eval-user-001";
// A stable, well-formed UUID used as the source_event_id for all seed records.
// This is a "sentinel" UUID that clearly identifies records as seeded eval data.
const EVAL_SOURCE_EVT = "00000000-0000-4000-a000-000000000001";
const SCHEMA_VERSION  = 3;

const SESSIONS = {
  PERSONAL:  "eval-session-personal",
  PROJECTS:  "eval-session-projects",
  HISTORY:   "eval-session-history",
  GOALS:     "eval-session-goals",
  EVENTS:    "eval-session-events",
  RECENCY:   "eval-session-recency",
  TOPICS:    "eval-session-topics",
  NOISE:     "eval-session-noise",
};

// ─── Time helpers ─────────────────────────────────────────────────────────────

const NOW = Date.now();
const hoursAgo  = (h) => new Date(NOW - h  * 3600 * 1000).toISOString();
const daysAgo   = (d) => hoursAgo(d * 24);
const weeksAgo  = (w) => daysAgo(w * 7);
const monthsAgo = (m) => daysAgo(m * 30);

// ─── Deterministic UUID ───────────────────────────────────────────────────────
// Produces a valid UUID v4-formatted string from a human-readable seed so that
// every run of this script generates EXACTLY the same UUID for each memory.
// This makes the data fully reproducible and comparison stable.

import { createHash } from "node:crypto";

function deterministicUUID(seed) {
  const h = createHash("sha256").update(`neura-eval:${seed}`).digest("hex");
  // Format as xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    "4" + h.slice(13, 16),
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32)
  ].join("-");
}

// ─── Fingerprint (must match @neura/core computeMemoryFingerprint) ─────────────
// Simple sorted token bag — same algorithm used in the production code.

import { STOP_TERMS } from "../packages/shared/src/index.js";

function computeMemoryFingerprint(content) {
  const tokens = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP_TERMS.has(t));
  return [...new Set(tokens)].sort().join(" ");
}

// ─── Metadata builder ─────────────────────────────────────────────────────────

function meta({
  importance    = 0.7,
  confidence    = 0.85,
  timestamp,
  domain        = "personal",
  domainConf    = 0.80,
  altDomains    = [],
  tags          = [],
  keywords      = [],
  entities      = [],
  role          = "user",
  sentiment     = "neutral",
  signalStrength= 0.75,
  specificity   = 0.70,
  permanence    = 0.65,
  actionability = 0.50,
} = {}) {
  return {
    importance,
    confidence,
    timestamp: timestamp || hoursAgo(24),
    domain,
    domainConfidence: domainConf,
    alternateDomains: altDomains,
    tags,
    role,
    schemaVersion: SCHEMA_VERSION,
    generatedBy: "seed-context-evaluation",
    extractionMethod: "manual-seed",
    source: { eventId: EVAL_SOURCE_EVT, sessionId: "eval-session-seed", segmentIndex: 0 },
    signalStrength,
    specificity,
    permanence,
    actionability,
    sentiment,
    keywords,
    entities,
    classificationConfidence: confidence,
    alternativeClassifications: [],
    classificationDebug: { factualScore: 0, episodicScore: 0, semanticScore: 0 },
  };
}

// ─── Memory catalogue ─────────────────────────────────────────────────────────
//
// Convention:
//   eval-f### → factual  (stored in Postgres)
//   eval-e### → episodic (stored in Qdrant, needs embedding)
//   eval-s### → semantic (stored in Qdrant, needs embedding)
//
// Categories
//   A: Personal facts & preferences       (eval-f001 … eval-f020)
//   B: Projects & technical info          (eval-f021 … eval-f040, eval-s001 … eval-s005)
//   C: Past conversations / episodic      (eval-e001 … eval-e030)
//   D: Goals & tasks                      (eval-f041 … eval-f055, eval-e031 … eval-e035)
//   E: Dates & events                     (eval-e036 … eval-e050)
//   F: Recent vs old memories             (eval-f056 … eval-f060, eval-e051 … eval-e055)
//   G: Same-topic cluster (diet/health)   (eval-f061 … eval-f070)
//   H: Distractors / unrelated noise      (eval-f071 … eval-f090, eval-s006 … eval-s015)
//
// Total: 90 factual + 55 episodic/semantic = 145 records
//
// ─────────────────────────────────────────────────────────────────────────────

const MEMORIES = [];

// ──────────────────────────────────────────────────────────────────────────────
// CATEGORY A — Personal facts & preferences (20 factual)
// ──────────────────────────────────────────────────────────────────────────────

MEMORIES.push(
  {
    id: "eval-f001", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "My name is Arjun Mehta and I am 32 years old.",
    summary: "User's name is Arjun Mehta, age 32.",
    metadata: meta({ importance: 0.95, domain: "identity", keywords: ["arjun", "mehta", "name", "age", "32"], timestamp: monthsAgo(6) })
  },
  {
    id: "eval-f002", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I live in Bengaluru, India, in the Koramangala neighbourhood.",
    summary: "User lives in Koramangala, Bengaluru, India.",
    metadata: meta({ importance: 0.90, domain: "identity", keywords: ["bengaluru", "india", "koramangala", "live"], timestamp: monthsAgo(5) })
  },
  {
    id: "eval-f003", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I am a senior software engineer at a fintech startup called PaySwift.",
    summary: "User is a senior software engineer at PaySwift (fintech startup).",
    metadata: meta({ importance: 0.92, domain: "identity", keywords: ["software", "engineer", "payswift", "fintech", "startup"], timestamp: monthsAgo(4) })
  },
  {
    id: "eval-f004", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I have been programming in Python and TypeScript for over eight years.",
    summary: "User has 8+ years of Python and TypeScript experience.",
    metadata: meta({ importance: 0.88, domain: "engineering", keywords: ["python", "typescript", "programming", "eight", "years"], timestamp: monthsAgo(3) })
  },
  {
    id: "eval-f005", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I prefer dark mode in all my editors and terminals — I use VS Code with the Dracula theme.",
    summary: "User prefers dark mode; uses VS Code with Dracula theme.",
    metadata: meta({ importance: 0.72, domain: "preference", keywords: ["dark", "mode", "vscode", "dracula", "theme", "editor"], timestamp: monthsAgo(3) })
  },
  {
    id: "eval-f006", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "My preferred breakfast is idli with sambar — I eat it almost every weekday morning.",
    summary: "User's favourite breakfast is idli with sambar.",
    metadata: meta({ importance: 0.65, domain: "preference", keywords: ["breakfast", "idli", "sambar", "morning", "weekday"], timestamp: monthsAgo(2) })
  },
  {
    id: "eval-f007", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I am vegetarian and allergic to peanuts.",
    summary: "User is vegetarian and allergic to peanuts.",
    metadata: meta({ importance: 0.93, domain: "preference", keywords: ["vegetarian", "allergic", "peanuts", "diet"], timestamp: monthsAgo(6) })
  },
  {
    id: "eval-f008", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "My preferred music genre while coding is lo-fi hip-hop; I use a playlist called 'Deep Work'.",
    summary: "User listens to lo-fi hip-hop while coding (playlist: 'Deep Work').",
    metadata: meta({ importance: 0.60, domain: "preference", keywords: ["music", "lofi", "hiphop", "coding", "deep", "work", "playlist"], timestamp: monthsAgo(2) })
  },
  {
    id: "eval-f009", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I commute to the office by electric scooter three days a week.",
    summary: "User commutes by electric scooter 3 days/week.",
    metadata: meta({ importance: 0.55, domain: "personal", keywords: ["commute", "scooter", "electric", "office"], timestamp: monthsAgo(1) })
  },
  {
    id: "eval-f010", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I have a golden retriever dog named Bruno. He is two years old.",
    summary: "User has a golden retriever dog named Bruno (2 years old).",
    metadata: meta({ importance: 0.78, domain: "personal", keywords: ["dog", "golden", "retriever", "bruno"], timestamp: monthsAgo(4) })
  },
  {
    id: "eval-f011", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "My sister Priya lives in Pune and works as a data scientist at a healthcare company.",
    summary: "User's sister Priya is a data scientist in Pune.",
    metadata: meta({ importance: 0.75, domain: "personal", keywords: ["sister", "priya", "pune", "data", "scientist", "healthcare"], timestamp: monthsAgo(3) })
  },
  {
    id: "eval-f012", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I drink four cups of filter coffee per day, usually without sugar.",
    summary: "User drinks 4 cups of filter coffee daily, no sugar.",
    metadata: meta({ importance: 0.62, domain: "preference", keywords: ["coffee", "filter", "cups", "sugar"], timestamp: monthsAgo(1) })
  },
  {
    id: "eval-f013", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "My favourite book is 'The Pragmatic Programmer' by David Thomas and Andrew Hunt.",
    summary: "User's favourite book is The Pragmatic Programmer.",
    metadata: meta({ importance: 0.70, domain: "preference", keywords: ["book", "pragmatic", "programmer", "david", "thomas", "andrew", "hunt"], timestamp: monthsAgo(5) })
  },
  {
    id: "eval-f014", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I go to the gym three times a week, focusing on strength training.",
    summary: "User goes to the gym 3x/week for strength training.",
    metadata: meta({ importance: 0.68, domain: "personal", keywords: ["gym", "strength", "training", "three", "week"], timestamp: monthsAgo(2) })
  },
  {
    id: "eval-f015", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I use a standing desk at home and alternate between sitting and standing every 45 minutes.",
    summary: "User uses a standing desk and alternates posture every 45 mins.",
    metadata: meta({ importance: 0.63, domain: "preference", keywords: ["standing", "desk", "sitting", "45", "minutes"], timestamp: monthsAgo(2) })
  },
  {
    id: "eval-f016", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "My timezone is IST (UTC+5:30) and I usually start work at 9 AM.",
    summary: "User is in IST (UTC+5:30) and starts work at 9 AM.",
    metadata: meta({ importance: 0.80, domain: "identity", keywords: ["timezone", "ist", "utc", "9am", "work"], timestamp: monthsAgo(5) })
  },
  {
    id: "eval-f017", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I prefer async communication over meetings; Slack is my primary work communication tool.",
    summary: "User prefers async communication via Slack over meetings.",
    metadata: meta({ importance: 0.74, domain: "preference", keywords: ["async", "slack", "meetings", "communication"], timestamp: monthsAgo(3) })
  },
  {
    id: "eval-f018", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I hold a B.Tech in Computer Science from IIT Bombay, graduated in 2015.",
    summary: "User graduated B.Tech CS from IIT Bombay in 2015.",
    metadata: meta({ importance: 0.85, domain: "identity", keywords: ["btech", "computer", "science", "iit", "bombay", "2015"], timestamp: monthsAgo(8) })
  },
  {
    id: "eval-f019", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "My MacBook Pro is a 2023 M3 model with 36 GB unified memory.",
    summary: "User has a 2023 MacBook Pro M3 with 36 GB RAM.",
    metadata: meta({ importance: 0.67, domain: "engineering", keywords: ["macbook", "m3", "2023", "36gb", "memory"], timestamp: monthsAgo(1) })
  },
  {
    id: "eval-f020", sessionId: SESSIONS.PERSONAL, memoryType: "factual",
    content: "I use Neovim as my secondary editor for quick terminal-based edits and server configuration.",
    summary: "User uses Neovim as secondary editor for terminal work.",
    metadata: meta({ importance: 0.60, domain: "engineering", keywords: ["neovim", "terminal", "editor", "server", "configuration"], timestamp: monthsAgo(2) })
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// CATEGORY B — Projects & technical info (20 factual + 5 semantic)
// ──────────────────────────────────────────────────────────────────────────────

MEMORIES.push(
  {
    id: "eval-f021", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "I am currently building a payment gateway integration for PaySwift's checkout SDK.",
    summary: "User is building PaySwift payment gateway checkout SDK integration.",
    metadata: meta({ importance: 0.88, domain: "project", keywords: ["payment", "gateway", "payswift", "sdk", "checkout"], timestamp: daysAgo(3) })
  },
  {
    id: "eval-f022", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "The checkout SDK is written in TypeScript and targets React and Vue frontends.",
    summary: "PaySwift checkout SDK: TypeScript, supports React and Vue.",
    metadata: meta({ importance: 0.82, domain: "engineering", keywords: ["sdk", "typescript", "react", "vue", "frontend"], timestamp: daysAgo(3) })
  },
  {
    id: "eval-f023", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "We use PostgreSQL for transactional data and Redis for rate limiting and session caching.",
    summary: "PaySwift stack: PostgreSQL for transactions, Redis for caching.",
    metadata: meta({ importance: 0.85, domain: "architecture", keywords: ["postgresql", "redis", "transactions", "rate", "limiting", "sessions"], timestamp: daysAgo(5) })
  },
  {
    id: "eval-f024", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "Our API uses JWT tokens for authentication with a 15-minute access token TTL.",
    summary: "PaySwift API uses JWT auth with 15-minute access token TTL.",
    metadata: meta({ importance: 0.87, domain: "architecture", keywords: ["jwt", "token", "authentication", "ttl", "15", "minutes"], timestamp: daysAgo(4) })
  },
  {
    id: "eval-f025", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "The backend is deployed on AWS using ECS Fargate with auto-scaling based on CPU usage.",
    summary: "PaySwift backend: AWS ECS Fargate with CPU-based auto-scaling.",
    metadata: meta({ importance: 0.84, domain: "architecture", keywords: ["aws", "ecs", "fargate", "autoscaling", "cpu", "deploy"], timestamp: daysAgo(7) })
  },
  {
    id: "eval-f026", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "I am responsible for the fraud detection microservice which uses a rule-based engine.",
    summary: "User owns fraud detection microservice (rule-based engine).",
    metadata: meta({ importance: 0.88, domain: "project", keywords: ["fraud", "detection", "microservice", "rule", "engine"], timestamp: daysAgo(10) })
  },
  {
    id: "eval-f027", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "We have a CI/CD pipeline using GitHub Actions that deploys to staging on every PR merge.",
    summary: "CI/CD via GitHub Actions; deploys to staging on PR merge.",
    metadata: meta({ importance: 0.80, domain: "engineering", keywords: ["cicd", "github", "actions", "staging", "deploy", "pr"], timestamp: daysAgo(8) })
  },
  {
    id: "eval-f028", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "Our test coverage target is 80% for critical payment flows; currently at 73%.",
    summary: "Test coverage target 80%; currently at 73% for payment flows.",
    metadata: meta({ importance: 0.76, domain: "engineering", keywords: ["test", "coverage", "80", "73", "payment", "flows"], timestamp: daysAgo(5) })
  },
  {
    id: "eval-f029", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "We use Datadog for monitoring with dashboards for latency, error rate, and payment success rate.",
    summary: "Monitoring via Datadog: latency, error rate, payment success dashboards.",
    metadata: meta({ importance: 0.79, domain: "engineering", keywords: ["datadog", "monitoring", "latency", "error", "payment"], timestamp: daysAgo(6) })
  },
  {
    id: "eval-f030", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "The fraud detection service processes approximately 50,000 transactions per day.",
    summary: "Fraud detection service handles ~50K transactions/day.",
    metadata: meta({ importance: 0.83, domain: "project", keywords: ["fraud", "50000", "transactions", "day", "processes"], timestamp: daysAgo(9) })
  },
  {
    id: "eval-f031", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "I maintain a personal side project: a React app that visualises my personal finance data using Plaid API.",
    summary: "User's side project: React app with personal finance data (Plaid API).",
    metadata: meta({ importance: 0.72, domain: "project", keywords: ["react", "personal", "finance", "plaid", "api", "visualise"], timestamp: weeksAgo(3) })
  },
  {
    id: "eval-f032", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "The finance visualisation app is deployed on Vercel with a Supabase backend.",
    summary: "Finance app deployed on Vercel with Supabase backend.",
    metadata: meta({ importance: 0.68, domain: "engineering", keywords: ["vercel", "supabase", "deploy", "finance", "app"], timestamp: weeksAgo(3) })
  },
  {
    id: "eval-f033", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "I am exploring using LangChain to add a natural language querying feature to the finance app.",
    summary: "User exploring LangChain for NL query in finance app.",
    metadata: meta({ importance: 0.74, domain: "project", keywords: ["langchain", "nlp", "query", "finance", "natural", "language"], timestamp: weeksAgo(2) })
  },
  {
    id: "eval-f034", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "Our team uses a two-week sprint cycle with sprint planning every other Monday.",
    summary: "Team uses 2-week sprints; planning every other Monday.",
    metadata: meta({ importance: 0.70, domain: "engineering", keywords: ["sprint", "two", "week", "planning", "monday"], timestamp: weeksAgo(1) })
  },
  {
    id: "eval-f035", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "The PaySwift monorepo uses Nx as its build system and npm workspaces for package management.",
    summary: "PaySwift monorepo: Nx build system, npm workspaces.",
    metadata: meta({ importance: 0.75, domain: "engineering", keywords: ["nx", "monorepo", "npm", "workspaces", "build"], timestamp: daysAgo(14) })
  },
  {
    id: "eval-f036", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "I use Vitest for unit tests in the TypeScript codebase and Playwright for E2E tests.",
    summary: "User uses Vitest for unit tests and Playwright for E2E.",
    metadata: meta({ importance: 0.77, domain: "engineering", keywords: ["vitest", "playwright", "e2e", "unit", "test", "typescript"], timestamp: daysAgo(12) })
  },
  {
    id: "eval-f037", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "The payment gateway supports UPI, credit cards, debit cards, and BNPL options.",
    summary: "PaySwift supports UPI, credit/debit cards, and BNPL payments.",
    metadata: meta({ importance: 0.86, domain: "project", keywords: ["upi", "credit", "debit", "bnpl", "payment", "gateway"], timestamp: daysAgo(15) })
  },
  {
    id: "eval-f038", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "I am the tech lead for a team of five engineers: Ravi, Kavya, Suresh, Deepa, and Nikhil.",
    summary: "User leads a team of 5 engineers at PaySwift.",
    metadata: meta({ importance: 0.85, domain: "identity", keywords: ["tech", "lead", "team", "five", "ravi", "kavya", "suresh"], timestamp: monthsAgo(3) })
  },
  {
    id: "eval-f039", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "Our service-level objective (SLO) for the payment API is 99.95% availability.",
    summary: "Payment API SLO: 99.95% availability.",
    metadata: meta({ importance: 0.87, domain: "engineering", keywords: ["slo", "99.95", "availability", "payment", "api"], timestamp: monthsAgo(2) })
  },
  {
    id: "eval-f040", sessionId: SESSIONS.PROJECTS, memoryType: "factual",
    content: "We use OpenTelemetry for distributed tracing across all PaySwift microservices.",
    summary: "PaySwift uses OpenTelemetry for distributed tracing.",
    metadata: meta({ importance: 0.80, domain: "architecture", keywords: ["opentelemetry", "tracing", "distributed", "microservices"], timestamp: monthsAgo(1) })
  }
);

// ─── Category B: Semantic memories (technical summaries) ─────────────────────

MEMORIES.push(
  {
    id: "eval-s001", sessionId: SESSIONS.PROJECTS, memoryType: "semantic",
    content: "Payment systems require strong consistency guarantees because double-charges and missed payments cause direct financial harm. Idempotency keys, distributed locks, and two-phase commit patterns are standard mitigations.",
    summary: "Payment systems need strong consistency: idempotency keys, distributed locks, 2PC.",
    metadata: meta({ importance: 0.88, domain: "architecture", keywords: ["payment", "consistency", "idempotency", "distributed", "locks", "two-phase"], timestamp: weeksAgo(4) })
  },
  {
    id: "eval-s002", sessionId: SESSIONS.PROJECTS, memoryType: "semantic",
    content: "Fraud detection models that rely purely on rule-based systems tend to have high false-positive rates. Combining rules with ML models trained on behavioural signals significantly reduces false positives.",
    summary: "Rule-only fraud detection has high false positives; combining with ML models improves accuracy.",
    metadata: meta({ importance: 0.85, domain: "engineering", keywords: ["fraud", "detection", "rules", "ml", "false", "positive", "behavioural"], timestamp: weeksAgo(3) })
  },
  {
    id: "eval-s003", sessionId: SESSIONS.PROJECTS, memoryType: "semantic",
    content: "TypeScript's strict null checks and discriminated unions make API boundary types more reliable. Using zod for runtime validation of external payloads closes the gap between compile-time and runtime safety.",
    summary: "TypeScript strict mode + zod runtime validation ensures API type safety.",
    metadata: meta({ importance: 0.82, domain: "engineering", keywords: ["typescript", "strict", "zod", "validation", "api", "runtime"], timestamp: weeksAgo(5) })
  },
  {
    id: "eval-s004", sessionId: SESSIONS.PROJECTS, memoryType: "semantic",
    content: "Database connection pooling is critical for high-throughput services. Using PgBouncer or the pool settings in postgres.js limits peak Postgres connections and prevents connection storm errors under load.",
    summary: "DB connection pooling (PgBouncer/postgres.js) prevents connection storms under load.",
    metadata: meta({ importance: 0.84, domain: "architecture", keywords: ["connection", "pooling", "pgbouncer", "postgres", "throughput"], timestamp: weeksAgo(6) })
  },
  {
    id: "eval-s005", sessionId: SESSIONS.PROJECTS, memoryType: "semantic",
    content: "React Server Components reduce client-side JavaScript bundle size significantly. They are best suited for static or infrequently-changing UI elements, while interactive widgets should remain as Client Components.",
    summary: "React Server Components reduce bundle size; keep interactive parts as Client Components.",
    metadata: meta({ importance: 0.75, domain: "engineering", keywords: ["react", "server", "components", "bundle", "javascript", "client"], timestamp: weeksAgo(4) })
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// CATEGORY C — Past conversations / episodic events (30 episodic)
// ──────────────────────────────────────────────────────────────────────────────

MEMORIES.push(
  {
    id: "eval-e001", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "During our conversation on Monday I explained the architecture of the fraud detection service and we decided to add a new rule for detecting velocity attacks.",
    summary: "Discussed fraud detection architecture; decided to add velocity attack rule.",
    metadata: meta({ importance: 0.80, domain: "engineering", keywords: ["fraud", "detection", "velocity", "attack", "architecture", "rule"], timestamp: daysAgo(4) })
  },
  {
    id: "eval-e002", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "We debugged a production incident where the payment webhook handler was timing out under high load due to a missing database index.",
    summary: "Debugged production timeout: payment webhook missing DB index.",
    metadata: meta({ importance: 0.88, domain: "engineering", keywords: ["production", "incident", "webhook", "timeout", "database", "index"], timestamp: daysAgo(6) })
  },
  {
    id: "eval-e003", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I presented the Q2 roadmap to the CTO last week and got approval to hire two more backend engineers.",
    summary: "Presented Q2 roadmap to CTO; approved to hire 2 backend engineers.",
    metadata: meta({ importance: 0.82, domain: "project", keywords: ["q2", "roadmap", "cto", "hire", "engineers", "approval"], timestamp: daysAgo(7) })
  },
  {
    id: "eval-e004", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "We had a sprint retrospective yesterday. The team flagged that PR review cycles are too slow — averaging three days from open to merge.",
    summary: "Sprint retro: PR review cycles averaging 3 days flagged as too slow.",
    metadata: meta({ importance: 0.76, domain: "engineering", keywords: ["retrospective", "pr", "review", "slow", "three", "days", "sprint"], timestamp: daysAgo(1) })
  },
  {
    id: "eval-e005", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I onboarded Nikhil, our new backend engineer, last Tuesday. He is ramping up on the payment service codebase.",
    summary: "Onboarded Nikhil (new backend engineer) last Tuesday.",
    metadata: meta({ importance: 0.77, domain: "project", keywords: ["onboard", "nikhil", "backend", "engineer", "tuesday"], timestamp: daysAgo(5) })
  },
  {
    id: "eval-e006", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "We shipped the BNPL (Buy Now Pay Later) feature to production two weeks ago after three months of development.",
    summary: "Shipped BNPL feature to production after 3 months of development.",
    metadata: meta({ importance: 0.87, domain: "project", keywords: ["bnpl", "buy", "now", "pay", "later", "production", "shipped"], timestamp: weeksAgo(2) })
  },
  {
    id: "eval-e007", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I attended a distributed systems workshop at HasGeek last month and learned about consensus algorithms beyond Raft.",
    summary: "Attended distributed systems workshop at HasGeek; learned beyond-Raft consensus.",
    metadata: meta({ importance: 0.72, domain: "engineering", keywords: ["distributed", "systems", "workshop", "hasgeek", "raft", "consensus"], timestamp: monthsAgo(1) })
  },
  {
    id: "eval-e008", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I had a 1:1 with my manager Anjali today. She mentioned that I am on track for a senior to staff engineer promotion.",
    summary: "1:1 with manager Anjali; on track for staff engineer promotion.",
    metadata: meta({ importance: 0.85, domain: "identity", keywords: ["manager", "anjali", "promotion", "staff", "engineer", "1on1"], timestamp: hoursAgo(3) })
  },
  {
    id: "eval-e009", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "Our team completed a database migration from MongoDB to PostgreSQL for the transactions service over the weekend.",
    summary: "Completed MongoDB→PostgreSQL migration for transactions service.",
    metadata: meta({ importance: 0.83, domain: "engineering", keywords: ["migration", "mongodb", "postgresql", "transactions", "weekend"], timestamp: weeksAgo(1) })
  },
  {
    id: "eval-e010", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I reviewed Kavya's pull request for the new UPI deep link feature this morning. Left 12 comments, mostly on error handling.",
    summary: "Reviewed Kavya's UPI deep link PR; 12 comments on error handling.",
    metadata: meta({ importance: 0.70, domain: "engineering", keywords: ["review", "kavya", "pr", "upi", "deep", "link", "error", "handling"], timestamp: hoursAgo(5) })
  },
  {
    id: "eval-e011", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I gave a talk at the Bengaluru Python meetup about using async patterns in financial systems.",
    summary: "Gave talk at Bengaluru Python meetup on async patterns in finance.",
    metadata: meta({ importance: 0.75, domain: "engineering", keywords: ["talk", "python", "meetup", "async", "financial", "bengaluru"], timestamp: weeksAgo(3) })
  },
  {
    id: "eval-e012", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "We resolved a critical security vulnerability in the OAuth flow — a PKCE bypass that was reported by a pen tester.",
    summary: "Fixed critical security bug: PKCE bypass in OAuth flow.",
    metadata: meta({ importance: 0.93, domain: "engineering", keywords: ["security", "oauth", "pkce", "bypass", "vulnerability", "pentest"], timestamp: weeksAgo(2) })
  },
  {
    id: "eval-e013", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I pair-programmed with Ravi for two hours to redesign the retry logic for failed payment callbacks.",
    summary: "Pair-programmed with Ravi to redesign payment callback retry logic.",
    metadata: meta({ importance: 0.73, domain: "engineering", keywords: ["pair", "programming", "ravi", "retry", "payment", "callback"], timestamp: daysAgo(9) })
  },
  {
    id: "eval-e014", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "Our December deployment caused a 45-minute partial outage because of a misconfigured feature flag. We added a pre-deploy feature-flag validation step to the CI pipeline.",
    summary: "December deployment caused 45-min outage due to bad feature flag; added CI validation.",
    metadata: meta({ importance: 0.88, domain: "engineering", keywords: ["deployment", "outage", "feature", "flag", "ci", "december", "45", "minutes"], timestamp: monthsAgo(3) })
  },
  {
    id: "eval-e015", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I completed an advanced system design course on Educative.io covering distributed caching and message queues.",
    summary: "Completed Educative.io system design course on caching and message queues.",
    metadata: meta({ importance: 0.70, domain: "education", keywords: ["course", "system", "design", "distributed", "caching", "message", "queue", "educative"], timestamp: monthsAgo(2) })
  },
  {
    id: "eval-e016", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "Suresh and I spent the afternoon debugging a race condition in the webhook deduplication logic that was causing some payments to be processed twice.",
    summary: "Debugged race condition in webhook dedup logic causing double-processed payments.",
    metadata: meta({ importance: 0.89, domain: "engineering", keywords: ["race", "condition", "webhook", "deduplication", "double", "payment", "suresh"], timestamp: daysAgo(11) })
  },
  {
    id: "eval-e017", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I attended a company all-hands last Thursday. The CEO announced expansion into Southeast Asia starting Q3.",
    summary: "Company all-hands: CEO announced SE Asia expansion in Q3.",
    metadata: meta({ importance: 0.78, domain: "business", keywords: ["all-hands", "ceo", "southeast", "asia", "q3", "expansion"], timestamp: daysAgo(4) })
  },
  {
    id: "eval-e018", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "We discussed adopting OpenFeature for feature flag management to move away from hardcoded environment variables.",
    summary: "Discussed adopting OpenFeature for feature flag management.",
    metadata: meta({ importance: 0.74, domain: "engineering", keywords: ["openfeature", "feature", "flag", "environment", "variable"], timestamp: daysAgo(13) })
  },
  {
    id: "eval-e019", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I completed my annual performance review last week. I scored 4.2 out of 5, which qualifies me for a 15% salary increment.",
    summary: "Annual review score 4.2/5; qualifies for 15% salary increment.",
    metadata: meta({ importance: 0.82, domain: "identity", keywords: ["performance", "review", "4.2", "increment", "15", "salary"], timestamp: weeksAgo(1) })
  },
  {
    id: "eval-e020", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I read about the Stripe Engineering blog post on idempotency keys and shared key takeaways with the team.",
    summary: "Shared Stripe blog takeaways on idempotency keys with team.",
    metadata: meta({ importance: 0.68, domain: "engineering", keywords: ["stripe", "idempotency", "keys", "blog", "engineering"], timestamp: daysAgo(16) })
  },
  {
    id: "eval-e021", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "Last Friday Deepa and I reviewed the database schema for the upcoming loyalty points feature.",
    summary: "Reviewed loyalty points DB schema with Deepa last Friday.",
    metadata: meta({ importance: 0.72, domain: "project", keywords: ["deepa", "schema", "loyalty", "points", "database", "review"], timestamp: daysAgo(3) })
  },
  {
    id: "eval-e022", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "We ran our quarterly load test and the payment API handled 2,000 requests per second with p99 latency under 200ms.",
    summary: "Load test: payment API hit 2k RPS with p99 < 200ms.",
    metadata: meta({ importance: 0.86, domain: "engineering", keywords: ["load", "test", "2000", "rps", "p99", "200ms", "payment"], timestamp: weeksAgo(2) })
  },
  {
    id: "eval-e023", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "My team celebrated our BNPL launch with a team dinner at a restaurant in Indiranagar.",
    summary: "Team dinner in Indiranagar to celebrate BNPL launch.",
    metadata: meta({ importance: 0.58, domain: "personal", keywords: ["dinner", "indiranagar", "bnpl", "launch", "celebrate", "team"], timestamp: weeksAgo(2) })
  },
  {
    id: "eval-e024", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I had a call with a third-party KYC provider to evaluate their API for the new user onboarding flow.",
    summary: "Evaluated third-party KYC API for new user onboarding.",
    metadata: meta({ importance: 0.80, domain: "project", keywords: ["kyc", "api", "onboarding", "third-party", "evaluation"], timestamp: weeksAgo(3) })
  },
  {
    id: "eval-e025", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "We upgraded Node.js from version 20 to 22 across the entire monorepo last sprint without any issues.",
    summary: "Upgraded Node.js 20→22 across monorepo last sprint.",
    metadata: meta({ importance: 0.71, domain: "engineering", keywords: ["nodejs", "upgrade", "20", "22", "monorepo", "sprint"], timestamp: weeksAgo(2) })
  },
  {
    id: "eval-e026", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I gave feedback on an RFC for introducing GraphQL subscriptions for real-time payment status updates.",
    summary: "Gave RFC feedback on GraphQL subscriptions for real-time payment updates.",
    metadata: meta({ importance: 0.74, domain: "engineering", keywords: ["graphql", "subscriptions", "realtime", "payment", "rfc"], timestamp: weeksAgo(4) })
  },
  {
    id: "eval-e027", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I used Claude to help draft the system design document for the new cross-border payments feature.",
    summary: "Used Claude to draft system design doc for cross-border payments feature.",
    metadata: meta({ importance: 0.75, domain: "engineering", keywords: ["claude", "ai", "system", "design", "cross-border", "payments", "document"], timestamp: daysAgo(8) })
  },
  {
    id: "eval-e028", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "The engineering team adopted the decision record (ADR) practice to document architectural choices.",
    summary: "Team adopted ADR practice for documenting architectural decisions.",
    metadata: meta({ importance: 0.70, domain: "engineering", keywords: ["adr", "decision", "record", "architecture", "documentation"], timestamp: monthsAgo(2) })
  },
  {
    id: "eval-e029", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "I mentored Kavya on database indexing strategies, specifically covering composite indexes and partial indexes.",
    summary: "Mentored Kavya on composite and partial DB indexing strategies.",
    metadata: meta({ importance: 0.73, domain: "engineering", keywords: ["mentor", "kavya", "database", "index", "composite", "partial"], timestamp: daysAgo(18) })
  },
  {
    id: "eval-e030", sessionId: SESSIONS.HISTORY, memoryType: "episodic",
    content: "After the December incident, we implemented circuit breakers for all third-party payment provider integrations.",
    summary: "Added circuit breakers for all third-party payment integrations post-incident.",
    metadata: meta({ importance: 0.87, domain: "architecture", keywords: ["circuit", "breaker", "third-party", "payment", "incident"], timestamp: monthsAgo(2) })
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// CATEGORY D — Goals & tasks (15 factual + 5 episodic)
// ──────────────────────────────────────────────────────────────────────────────

MEMORIES.push(
  {
    id: "eval-f041", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "My primary goal for this quarter is to reduce payment failure rate from 2.1% to below 1.5%.",
    summary: "Q3 goal: reduce payment failure rate from 2.1% to < 1.5%.",
    metadata: meta({ importance: 0.90, domain: "planning", keywords: ["goal", "payment", "failure", "rate", "2.1", "1.5", "quarter"], timestamp: weeksAgo(5), actionability: 0.90 })
  },
  {
    id: "eval-f042", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I want to complete the AWS Solutions Architect Professional certification before the end of this year.",
    summary: "Goal: AWS Solutions Architect Professional cert by year-end.",
    metadata: meta({ importance: 0.83, domain: "education", keywords: ["aws", "certification", "solutions", "architect", "professional"], timestamp: weeksAgo(4), actionability: 0.85 })
  },
  {
    id: "eval-f043", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I need to hire two senior backend engineers by the end of Q3 to support the Southeast Asia expansion.",
    summary: "Task: hire 2 senior backend engineers by end of Q3.",
    metadata: meta({ importance: 0.88, domain: "project", keywords: ["hire", "backend", "engineers", "q3", "southeast", "asia"], timestamp: weeksAgo(3), actionability: 0.95 })
  },
  {
    id: "eval-f044", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I plan to refactor the payment routing logic to reduce cyclomatic complexity before the next major release.",
    summary: "Plan: refactor payment routing logic to reduce complexity before next release.",
    metadata: meta({ importance: 0.80, domain: "engineering", keywords: ["refactor", "payment", "routing", "cyclomatic", "complexity", "release"], timestamp: daysAgo(6), actionability: 0.85 })
  },
  {
    id: "eval-f045", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I want to read and summarise one technical book per month. Current: 'Designing Data-Intensive Applications' by Kleppmann.",
    summary: "Reading goal: 1 tech book/month. Currently reading DDIA by Kleppmann.",
    metadata: meta({ importance: 0.72, domain: "education", keywords: ["book", "designing", "data-intensive", "applications", "kleppmann", "read"], timestamp: weeksAgo(2), actionability: 0.75 })
  },
  {
    id: "eval-f046", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I must improve our API documentation coverage — currently only 40% of endpoints have OpenAPI specs.",
    summary: "Task: increase API documentation coverage from 40% to full OpenAPI specs.",
    metadata: meta({ importance: 0.78, domain: "engineering", keywords: ["api", "documentation", "openapi", "coverage", "40"], timestamp: daysAgo(10), actionability: 0.88 })
  },
  {
    id: "eval-f047", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I am targeting a marathon run in November — currently training with a 5-day-a-week running schedule.",
    summary: "Training for marathon in November; running 5 days/week.",
    metadata: meta({ importance: 0.70, domain: "personal", keywords: ["marathon", "november", "training", "running", "5", "week"], timestamp: weeksAgo(6), actionability: 0.80 })
  },
  {
    id: "eval-f048", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I want to launch the personal finance app publicly before year-end with at least 500 beta users.",
    summary: "Goal: launch personal finance app publicly with 500 beta users by year-end.",
    metadata: meta({ importance: 0.77, domain: "project", keywords: ["launch", "finance", "app", "500", "beta", "users", "year"], timestamp: weeksAgo(4), actionability: 0.85 })
  },
  {
    id: "eval-f049", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I plan to write three technical blog posts about distributed systems and payment infrastructure.",
    summary: "Goal: write 3 technical blog posts on distributed systems and payments.",
    metadata: meta({ importance: 0.68, domain: "planning", keywords: ["blog", "write", "technical", "distributed", "payment", "three"], timestamp: weeksAgo(3), actionability: 0.80 })
  },
  {
    id: "eval-f050", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I need to set up an on-call rotation for the payment team to distribute incident response burden fairly.",
    summary: "Task: establish on-call rotation for payment team.",
    metadata: meta({ importance: 0.84, domain: "engineering", keywords: ["on-call", "rotation", "incident", "response", "team"], timestamp: daysAgo(5), actionability: 0.92 })
  },
  {
    id: "eval-f051", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I want to reduce our Datadog bill by 20% by auditing and removing unused custom metrics.",
    summary: "Task: reduce Datadog costs 20% by removing unused custom metrics.",
    metadata: meta({ importance: 0.74, domain: "project", keywords: ["datadog", "cost", "metrics", "unused", "20", "reduce"], timestamp: daysAgo(7), actionability: 0.85 })
  },
  {
    id: "eval-f052", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I plan to implement structured logging with correlation IDs across all services by end of sprint.",
    summary: "Plan: add structured logging with correlation IDs across all services.",
    metadata: meta({ importance: 0.79, domain: "engineering", keywords: ["structured", "logging", "correlation", "ids", "services", "sprint"], timestamp: daysAgo(4), actionability: 0.90 })
  },
  {
    id: "eval-f053", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I need to prepare and deliver a lunch-and-learn session on observability best practices for the engineering org.",
    summary: "Task: deliver lunch-and-learn on observability best practices.",
    metadata: meta({ importance: 0.72, domain: "planning", keywords: ["lunch", "learn", "observability", "best", "practices", "engineering"], timestamp: daysAgo(9), actionability: 0.85 })
  },
  {
    id: "eval-f054", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I want to migrate the fraud detection rule engine to a configurable policy-as-code system using OPA.",
    summary: "Goal: migrate fraud detection rules to OPA policy-as-code.",
    metadata: meta({ importance: 0.82, domain: "project", keywords: ["opa", "policy", "fraud", "detection", "configurable", "migrate"], timestamp: weeksAgo(3), actionability: 0.80 })
  },
  {
    id: "eval-f055", sessionId: SESSIONS.GOALS, memoryType: "factual",
    content: "I plan to introduce weekly knowledge-sharing sessions for the team, starting next Monday.",
    summary: "Plan: start weekly team knowledge-sharing sessions next Monday.",
    metadata: meta({ importance: 0.67, domain: "planning", keywords: ["knowledge", "sharing", "weekly", "sessions", "monday"], timestamp: daysAgo(2), actionability: 0.88 })
  }
);

MEMORIES.push(
  {
    id: "eval-e031", sessionId: SESSIONS.GOALS, memoryType: "episodic",
    content: "I signed up for the AWS Professional architect exam and booked a slot for October 15th.",
    summary: "Booked AWS architect exam for October 15.",
    metadata: meta({ importance: 0.82, domain: "education", keywords: ["aws", "exam", "october", "15", "booked"], timestamp: weeksAgo(2) })
  },
  {
    id: "eval-e032", sessionId: SESSIONS.GOALS, memoryType: "episodic",
    content: "I submitted the first of my three blog posts — titled 'Why Idempotency Matters in Payments' — to the company tech blog.",
    summary: "Submitted first blog post 'Why Idempotency Matters in Payments'.",
    metadata: meta({ importance: 0.72, domain: "planning", keywords: ["blog", "idempotency", "payments", "submit", "tech"], timestamp: daysAgo(6) })
  },
  {
    id: "eval-e033", sessionId: SESSIONS.GOALS, memoryType: "episodic",
    content: "I ran a half-marathon yesterday as a training milestone — completed in 2 hours 8 minutes.",
    summary: "Ran half-marathon yesterday in 2:08 as training milestone.",
    metadata: meta({ importance: 0.73, domain: "personal", keywords: ["half-marathon", "2h08m", "training", "run", "milestone"], timestamp: hoursAgo(20) })
  },
  {
    id: "eval-e034", sessionId: SESSIONS.GOALS, memoryType: "episodic",
    content: "I completed the on-call rotation setup — we are now using PagerDuty with a weekly rotation across five engineers.",
    summary: "On-call rotation set up via PagerDuty; weekly across 5 engineers.",
    metadata: meta({ importance: 0.80, domain: "engineering", keywords: ["pagerduty", "on-call", "rotation", "weekly", "five", "engineers"], timestamp: daysAgo(2) })
  },
  {
    id: "eval-e035", sessionId: SESSIONS.GOALS, memoryType: "episodic",
    content: "I hired Megha, a senior backend engineer with Kafka and Go experience, who will join next month.",
    summary: "Hired Megha (senior backend, Kafka/Go) to join next month.",
    metadata: meta({ importance: 0.85, domain: "project", keywords: ["hire", "megha", "kafka", "go", "senior", "backend"], timestamp: daysAgo(3) })
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// CATEGORY E — Dates & specific events (15 episodic)
// ──────────────────────────────────────────────────────────────────────────────

MEMORIES.push(
  {
    id: "eval-e036", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "My wedding anniversary is on March 12. We have been married for four years.",
    summary: "Wedding anniversary: March 12. Married 4 years.",
    metadata: meta({ importance: 0.88, domain: "personal", keywords: ["anniversary", "march", "12", "married", "four", "years"], timestamp: monthsAgo(2) })
  },
  {
    id: "eval-e037", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "My father's 65th birthday is on November 3rd. I have started planning a surprise family trip.",
    summary: "Father's 65th birthday: November 3. Planning surprise family trip.",
    metadata: meta({ importance: 0.87, domain: "personal", keywords: ["father", "birthday", "november", "3", "65", "family", "trip"], timestamp: weeksAgo(1) })
  },
  {
    id: "eval-e038", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "The company's annual hackathon is scheduled for September 20-21. I am leading a team of four.",
    summary: "Company hackathon: September 20-21. Leading a team of 4.",
    metadata: meta({ importance: 0.80, domain: "project", keywords: ["hackathon", "september", "20", "21", "team", "four", "lead"], timestamp: weeksAgo(2) })
  },
  {
    id: "eval-e039", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "PaySwift is presenting at the India Fintech Summit in Mumbai on October 8th.",
    summary: "PaySwift presents at India Fintech Summit, Mumbai, October 8.",
    metadata: meta({ importance: 0.78, domain: "business", keywords: ["fintech", "summit", "mumbai", "october", "8", "payswift"], timestamp: weeksAgo(3) })
  },
  {
    id: "eval-e040", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "We have a product demo for the Southeast Asia expansion stakeholders on September 15.",
    summary: "Product demo for SE Asia expansion on September 15.",
    metadata: meta({ importance: 0.83, domain: "project", keywords: ["demo", "southeast", "asia", "september", "15", "stakeholders"], timestamp: weeksAgo(1) })
  },
  {
    id: "eval-e041", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "Our PCI-DSS compliance audit is booked for November 10-12. We need to have all documentation ready by November 1.",
    summary: "PCI-DSS audit: November 10-12. Documentation due November 1.",
    metadata: meta({ importance: 0.91, domain: "engineering", keywords: ["pci-dss", "audit", "november", "10", "12", "documentation", "compliance"], timestamp: weeksAgo(4) })
  },
  {
    id: "eval-e042", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "My team's next performance review cycle opens on October 1st. I need to collect peer feedback from five people.",
    summary: "Performance review cycle opens October 1. Collect peer feedback from 5.",
    metadata: meta({ importance: 0.81, domain: "planning", keywords: ["performance", "review", "october", "1", "peer", "feedback", "five"], timestamp: weeksAgo(3) })
  },
  {
    id: "eval-e043", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "I booked a 10-day trip to Japan for December 20 to January 1. It will be my first visit to Japan.",
    summary: "Japan trip booked: December 20 – January 1, first visit.",
    metadata: meta({ importance: 0.85, domain: "personal", keywords: ["japan", "december", "20", "january", "1", "trip", "10", "days"], timestamp: weeksAgo(2) })
  },
  {
    id: "eval-e044", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "The Bengaluru marathon I am registered for is on November 17th. My bib number is 4523.",
    summary: "Bengaluru marathon: November 17, bib #4523.",
    metadata: meta({ importance: 0.79, domain: "personal", keywords: ["marathon", "november", "17", "bengaluru", "bib", "4523"], timestamp: weeksAgo(5) })
  },
  {
    id: "eval-e045", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "Q3 ends September 30. The payment failure rate goal must be achieved before the Q3 wrap-up meeting.",
    summary: "Q3 ends Sept 30; payment failure rate goal must be met by then.",
    metadata: meta({ importance: 0.85, domain: "planning", keywords: ["q3", "september", "30", "payment", "failure", "goal", "wrap-up"], timestamp: daysAgo(8) })
  },
  {
    id: "eval-e046", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "I have a dentist appointment on September 10 at 5 PM at Apollo Clinic, Koramangala.",
    summary: "Dentist appointment: September 10 at 5 PM, Apollo Clinic Koramangala.",
    metadata: meta({ importance: 0.65, domain: "personal", keywords: ["dentist", "september", "10", "5pm", "apollo", "koramangala"], timestamp: daysAgo(2) })
  },
  {
    id: "eval-e047", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "Megha's joining date is October 1. I need to prepare an onboarding plan for her by September 25.",
    summary: "Megha joins October 1; onboarding plan due September 25.",
    metadata: meta({ importance: 0.82, domain: "project", keywords: ["megha", "october", "1", "onboarding", "september", "25"], timestamp: daysAgo(3) })
  },
  {
    id: "eval-e048", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "My mother's birthday is June 15. I sent flowers and a book this year.",
    summary: "Mother's birthday: June 15. Sent flowers and a book.",
    metadata: meta({ importance: 0.75, domain: "personal", keywords: ["mother", "birthday", "june", "15", "flowers", "book"], timestamp: monthsAgo(3) })
  },
  {
    id: "eval-e049", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "The company's annual offsite is in Coorg from October 25-27. I am presenting the 2025 tech roadmap.",
    summary: "Company offsite in Coorg: October 25-27. Presenting 2025 tech roadmap.",
    metadata: meta({ importance: 0.80, domain: "planning", keywords: ["offsite", "coorg", "october", "25", "27", "roadmap", "2025"], timestamp: weeksAgo(3) })
  },
  {
    id: "eval-e050", sessionId: SESSIONS.EVENTS, memoryType: "episodic",
    content: "The sprint ends on Friday, September 5. All tickets must be moved to Done before the demo.",
    summary: "Sprint ends Friday September 5; all tickets must be Done before demo.",
    metadata: meta({ importance: 0.78, domain: "planning", keywords: ["sprint", "september", "5", "friday", "tickets", "demo"], timestamp: daysAgo(1) })
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// CATEGORY F — Recent vs old memories (test recency decay)
//              5 recent (< 6h) + 5 very old (> 3 months)
// ──────────────────────────────────────────────────────────────────────────────

MEMORIES.push(
  {
    id: "eval-f056", sessionId: SESSIONS.RECENCY, memoryType: "factual",
    content: "I just finished code-reviewing the BNPL refund flow and approved it for merge.",
    summary: "Just approved BNPL refund flow PR for merge.",
    metadata: meta({ importance: 0.75, domain: "engineering", keywords: ["bnpl", "refund", "review", "approve", "merge"], timestamp: hoursAgo(1) })
  },
  {
    id: "eval-f057", sessionId: SESSIONS.RECENCY, memoryType: "factual",
    content: "I sent the weekly engineering update email to leadership this morning.",
    summary: "Sent weekly engineering update email to leadership this morning.",
    metadata: meta({ importance: 0.62, domain: "planning", keywords: ["weekly", "update", "email", "leadership", "morning"], timestamp: hoursAgo(2) })
  },
  {
    id: "eval-e051", sessionId: SESSIONS.RECENCY, memoryType: "episodic",
    content: "I just attended the daily stand-up and mentioned that the fraud detection rule for velocity attacks is ready for QA.",
    summary: "Stand-up: velocity attack fraud rule is ready for QA.",
    metadata: meta({ importance: 0.70, domain: "engineering", keywords: ["standup", "fraud", "velocity", "attack", "qa", "ready"], timestamp: hoursAgo(3) })
  },
  {
    id: "eval-e052", sessionId: SESSIONS.RECENCY, memoryType: "episodic",
    content: "I grabbed lunch with Ravi and Kavya and we brainstormed the cross-border payments feature.",
    summary: "Lunch brainstorm with Ravi and Kavya on cross-border payments.",
    metadata: meta({ importance: 0.58, domain: "project", keywords: ["lunch", "ravi", "kavya", "cross-border", "payments", "brainstorm"], timestamp: hoursAgo(4) })
  },
  {
    id: "eval-f058", sessionId: SESSIONS.RECENCY, memoryType: "factual",
    content: "I just fixed a broken test in the CI pipeline that was blocking all other engineers from merging PRs.",
    summary: "Fixed broken CI test that was blocking all PR merges.",
    metadata: meta({ importance: 0.80, domain: "engineering", keywords: ["ci", "test", "broken", "fix", "blocking", "pr", "merge"], timestamp: hoursAgo(5) })
  },
  // ─── Very old memories (3-9 months ago) ──────────────────────────────────
  {
    id: "eval-f059", sessionId: SESSIONS.RECENCY, memoryType: "factual",
    content: "We launched the first version of the PaySwift checkout SDK six months ago with just credit card support.",
    summary: "Launched first PaySwift checkout SDK (credit card only) 6 months ago.",
    metadata: meta({ importance: 0.78, domain: "project", keywords: ["launch", "payswift", "sdk", "credit", "card", "six", "months"], timestamp: monthsAgo(6) })
  },
  {
    id: "eval-f060", sessionId: SESSIONS.RECENCY, memoryType: "factual",
    content: "I joined PaySwift as senior engineer in January two years ago. The company had 30 engineers at the time.",
    summary: "Joined PaySwift as senior engineer January 2 years ago; 30 engineers then.",
    metadata: meta({ importance: 0.86, domain: "identity", keywords: ["joined", "payswift", "january", "senior", "engineer", "30", "engineers"], timestamp: monthsAgo(24) })
  },
  {
    id: "eval-e053", sessionId: SESSIONS.RECENCY, memoryType: "episodic",
    content: "Three months ago we migrated our entire infrastructure from AWS us-east-1 to ap-south-1 to reduce latency for Indian users.",
    summary: "Migrated AWS from us-east-1 to ap-south-1 for India latency 3 months ago.",
    metadata: meta({ importance: 0.84, domain: "architecture", keywords: ["aws", "migration", "us-east-1", "ap-south-1", "latency", "india"], timestamp: monthsAgo(3) })
  },
  {
    id: "eval-e054", sessionId: SESSIONS.RECENCY, memoryType: "episodic",
    content: "Six months ago we lost a major merchant client because our 3DS authentication success rate was too low.",
    summary: "Lost major merchant 6 months ago due to low 3DS auth success rate.",
    metadata: meta({ importance: 0.88, domain: "business", keywords: ["merchant", "3ds", "authentication", "lost", "client", "six", "months"], timestamp: monthsAgo(6) })
  },
  {
    id: "eval-e055", sessionId: SESSIONS.RECENCY, memoryType: "episodic",
    content: "Eight months ago I attended my first PaySwift board meeting as a guest presenter and explained our security roadmap.",
    summary: "Presented security roadmap at PaySwift board meeting 8 months ago.",
    metadata: meta({ importance: 0.80, domain: "project", keywords: ["board", "meeting", "security", "roadmap", "presenter", "eight", "months"], timestamp: monthsAgo(8) })
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// CATEGORY G — Multiple memories about the same topic (diet/health)
//              10 factual — testing that same-topic cluster retrieval works
// ──────────────────────────────────────────────────────────────────────────────

MEMORIES.push(
  {
    id: "eval-f061", sessionId: SESSIONS.TOPICS, memoryType: "factual",
    content: "I follow an intermittent fasting schedule: 16:8 ratio, eating between noon and 8 PM.",
    summary: "Follows 16:8 intermittent fasting: eating noon–8 PM.",
    metadata: meta({ importance: 0.74, domain: "personal", keywords: ["intermittent", "fasting", "16:8", "noon", "8pm", "eating"], timestamp: daysAgo(15) })
  },
  {
    id: "eval-f062", sessionId: SESSIONS.TOPICS, memoryType: "factual",
    content: "I avoid refined sugar and white flour as part of my diet. I substitute with jaggery and whole wheat.",
    summary: "Diet: no refined sugar or white flour; uses jaggery and whole wheat.",
    metadata: meta({ importance: 0.75, domain: "personal", keywords: ["diet", "sugar", "flour", "jaggery", "whole", "wheat", "refined"], timestamp: daysAgo(20) })
  },
  {
    id: "eval-f063", sessionId: SESSIONS.TOPICS, memoryType: "factual",
    content: "I take vitamin D3 (2000 IU) and omega-3 (1g EPA+DHA) supplements every morning.",
    summary: "Takes vitamin D3 2000IU and omega-3 1g daily in the morning.",
    metadata: meta({ importance: 0.72, domain: "personal", keywords: ["vitamin", "d3", "omega-3", "supplement", "2000", "1g"], timestamp: daysAgo(10) })
  },
  {
    id: "eval-f064", sessionId: SESSIONS.TOPICS, memoryType: "factual",
    content: "I track my daily calories using the Healthifyme app, targeting 2,200 kcal on training days.",
    summary: "Tracks calories with Healthifyme; 2200 kcal on training days.",
    metadata: meta({ importance: 0.65, domain: "personal", keywords: ["calories", "healthifyme", "2200", "training", "track"], timestamp: daysAgo(7) })
  },
  {
    id: "eval-f065", sessionId: SESSIONS.TOPICS, memoryType: "factual",
    content: "My doctor recommended I increase protein intake to at least 140g per day for muscle recovery.",
    summary: "Doctor recommended 140g+ daily protein for muscle recovery.",
    metadata: meta({ importance: 0.78, domain: "personal", keywords: ["protein", "140g", "muscle", "recovery", "doctor", "intake"], timestamp: daysAgo(25) })
  },
  {
    id: "eval-f066", sessionId: SESSIONS.TOPICS, memoryType: "factual",
    content: "I had a blood test last month. My ferritin was low at 18 ng/ml — the doctor suggested iron-rich foods.",
    summary: "Blood test: low ferritin (18 ng/ml); doctor suggested iron-rich foods.",
    metadata: meta({ importance: 0.82, domain: "personal", keywords: ["ferritin", "18", "ng/ml", "blood", "test", "iron"], timestamp: monthsAgo(1) })
  },
  {
    id: "eval-f067", sessionId: SESSIONS.TOPICS, memoryType: "factual",
    content: "I do not drink alcohol. I stopped drinking two years ago for health reasons.",
    summary: "User doesn't drink alcohol; stopped 2 years ago for health.",
    metadata: meta({ importance: 0.80, domain: "personal", keywords: ["alcohol", "stopped", "two", "years", "health", "drink"], timestamp: monthsAgo(4) })
  },
  {
    id: "eval-f068", sessionId: SESSIONS.TOPICS, memoryType: "factual",
    content: "I try to drink at least 3 litres of water per day, especially on running days.",
    summary: "Drinks 3+ litres of water daily, especially on running days.",
    metadata: meta({ importance: 0.64, domain: "personal", keywords: ["water", "3", "litres", "daily", "running", "hydration"], timestamp: daysAgo(5) })
  },
  {
    id: "eval-f069", sessionId: SESSIONS.TOPICS, memoryType: "factual",
    content: "I sleep 7-8 hours every night and keep a consistent sleep schedule: 11 PM to 6:30 AM.",
    summary: "Sleeps 7-8 hours; schedule 11 PM to 6:30 AM.",
    metadata: meta({ importance: 0.70, domain: "personal", keywords: ["sleep", "7", "8", "hours", "11pm", "6:30am", "schedule"], timestamp: daysAgo(8) })
  },
  {
    id: "eval-f070", sessionId: SESSIONS.TOPICS, memoryType: "factual",
    content: "My resting heart rate has improved from 72 BPM to 58 BPM over the past eight months of training.",
    summary: "Resting heart rate improved: 72→58 BPM over 8 months of training.",
    metadata: meta({ importance: 0.74, domain: "personal", keywords: ["heart", "rate", "72", "58", "bpm", "training", "eight", "months"], timestamp: daysAgo(12) })
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// CATEGORY H — Distractors / noise (20 factual + 10 semantic)
//              Should NOT appear for most queries but test negative precision
// ──────────────────────────────────────────────────────────────────────────────

MEMORIES.push(
  {
    id: "eval-f071", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "The French Riviera has excellent summer weather and is famous for its art museums.",
    summary: "French Riviera: excellent summer weather and art museums.",
    metadata: meta({ importance: 0.40, domain: "personal", keywords: ["french", "riviera", "summer", "art", "museums"], timestamp: monthsAgo(7) })
  },
  {
    id: "eval-f072", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "Sourdough bread requires a starter culture and a long fermentation process of at least 12 hours.",
    summary: "Sourdough requires starter culture and 12+ hour fermentation.",
    metadata: meta({ importance: 0.35, domain: "personal", keywords: ["sourdough", "bread", "starter", "fermentation", "12", "hours"], timestamp: monthsAgo(5) })
  },
  {
    id: "eval-f073", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "The Nintendo Switch 2 was announced with a 7.9-inch display and backward compatibility.",
    summary: "Nintendo Switch 2: 7.9-inch display, backward compatible.",
    metadata: meta({ importance: 0.30, domain: "personal", keywords: ["nintendo", "switch", "2", "display", "backward", "compatible"], timestamp: monthsAgo(4) })
  },
  {
    id: "eval-f074", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "I watched the Formula 1 Monaco Grand Prix last weekend. Verstappen won for the third consecutive time.",
    summary: "Watched F1 Monaco GP; Verstappen won 3rd consecutive time.",
    metadata: meta({ importance: 0.38, domain: "personal", keywords: ["formula", "1", "monaco", "grand", "prix", "verstappen", "won"], timestamp: weeksAgo(8) })
  },
  {
    id: "eval-f075", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "The price of a 2BHK flat in Koramangala, Bengaluru, is approximately ₹1.2 crore.",
    summary: "2BHK in Koramangala costs approx ₹1.2 crore.",
    metadata: meta({ importance: 0.42, domain: "planning", keywords: ["2bhk", "koramangala", "flat", "1.2", "crore", "bengaluru"], timestamp: monthsAgo(3) })
  },
  {
    id: "eval-f076", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "I use a Kindle Paperwhite for reading. It has 32 GB storage and a 7-week battery life.",
    summary: "Uses Kindle Paperwhite: 32 GB, 7-week battery.",
    metadata: meta({ importance: 0.45, domain: "preference", keywords: ["kindle", "paperwhite", "32gb", "7", "week", "battery"], timestamp: monthsAgo(6) })
  },
  {
    id: "eval-f077", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "My favourite cricket team is Royal Challengers Bengaluru. I have attended three live IPL matches.",
    summary: "Supports Royal Challengers Bengaluru; attended 3 live IPL matches.",
    metadata: meta({ importance: 0.40, domain: "personal", keywords: ["cricket", "rcb", "bangalore", "ipl", "matches", "three"], timestamp: monthsAgo(4) })
  },
  {
    id: "eval-f078", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "The Taj Mahal was built between 1632 and 1653 by Mughal emperor Shah Jahan.",
    summary: "Taj Mahal built 1632-1653 by Shah Jahan.",
    metadata: meta({ importance: 0.25, domain: "education", keywords: ["taj", "mahal", "1632", "1653", "shah", "jahan", "mughal"], timestamp: monthsAgo(9) })
  },
  {
    id: "eval-f079", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "I tried making pasta carbonara at home last week — used guanciale instead of pancetta.",
    summary: "Made pasta carbonara at home with guanciale last week.",
    metadata: meta({ importance: 0.32, domain: "personal", keywords: ["pasta", "carbonara", "guanciale", "pancetta", "cooking"], timestamp: weeksAgo(1) })
  },
  {
    id: "eval-f080", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "The average human brain has approximately 86 billion neurons.",
    summary: "Human brain has ~86 billion neurons.",
    metadata: meta({ importance: 0.20, domain: "education", keywords: ["brain", "neurons", "86", "billion", "human"], timestamp: monthsAgo(8) })
  },
  {
    id: "eval-f081", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "I need to renew my car insurance policy before October 31.",
    summary: "Car insurance renewal due by October 31.",
    metadata: meta({ importance: 0.55, domain: "planning", keywords: ["car", "insurance", "renewal", "october", "31"], timestamp: daysAgo(14) })
  },
  {
    id: "eval-f082", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "My home WiFi router is a TP-Link AX5400 with a 2.4 GHz and 5 GHz dual-band network.",
    summary: "Home WiFi: TP-Link AX5400 dual-band (2.4 + 5 GHz).",
    metadata: meta({ importance: 0.30, domain: "personal", keywords: ["wifi", "router", "tp-link", "ax5400", "dual-band", "5ghz"], timestamp: monthsAgo(5) })
  },
  {
    id: "eval-f083", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "The best chai in Bengaluru is from a roadside stall near Cubbon Park.",
    summary: "Best chai in Bengaluru: roadside stall near Cubbon Park.",
    metadata: meta({ importance: 0.28, domain: "preference", keywords: ["chai", "bengaluru", "cubbon", "park", "roadside"], timestamp: monthsAgo(2) })
  },
  {
    id: "eval-f084", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "I subscribed to a 10-session pottery class at a studio in HSR Layout starting next Saturday.",
    summary: "10-session pottery class in HSR Layout starts next Saturday.",
    metadata: meta({ importance: 0.45, domain: "personal", keywords: ["pottery", "class", "hsr", "layout", "saturday", "10"], timestamp: daysAgo(5) })
  },
  {
    id: "eval-f085", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "The stock market hit an all-time high last Monday with the Nifty 50 crossing 26,000 points.",
    summary: "Nifty 50 crossed 26,000 points last Monday (ATH).",
    metadata: meta({ importance: 0.35, domain: "business", keywords: ["stock", "market", "nifty", "50", "26000", "all-time", "high"], timestamp: weeksAgo(1) })
  },
  {
    id: "eval-f086", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "I planted a balcony herb garden this month — growing basil, mint, coriander, and rosemary.",
    summary: "Planted balcony herb garden: basil, mint, coriander, rosemary.",
    metadata: meta({ importance: 0.38, domain: "personal", keywords: ["balcony", "herb", "garden", "basil", "mint", "coriander", "rosemary"], timestamp: weeksAgo(2) })
  },
  {
    id: "eval-f087", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "Bruno (my dog) had his annual veterinary check-up last Thursday. He is in excellent health.",
    summary: "Bruno's annual vet check-up last Thursday; excellent health.",
    metadata: meta({ importance: 0.52, domain: "personal", keywords: ["bruno", "dog", "vet", "check-up", "thursday", "health"], timestamp: daysAgo(4) })
  },
  {
    id: "eval-f088", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "I am planning to get a new ergonomic chair — considering the Herman Miller Aeron or Steelcase Leap.",
    summary: "Shopping for ergonomic chair: Herman Miller Aeron or Steelcase Leap.",
    metadata: meta({ importance: 0.45, domain: "planning", keywords: ["ergonomic", "chair", "herman", "miller", "steelcase", "aeron", "leap"], timestamp: daysAgo(8) })
  },
  {
    id: "eval-f089", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "My wife Meera is a UX designer and works at a product design agency in Bengaluru.",
    summary: "Wife Meera is a UX designer at a product design agency in Bengaluru.",
    metadata: meta({ importance: 0.72, domain: "personal", keywords: ["meera", "wife", "ux", "designer", "bengaluru", "agency"], timestamp: monthsAgo(3) })
  },
  {
    id: "eval-f090", sessionId: SESSIONS.NOISE, memoryType: "factual",
    content: "I use a Philips air purifier in my bedroom because Bengaluru's AQI peaks in winter.",
    summary: "Uses Philips air purifier in bedroom; Bengaluru AQI peaks in winter.",
    metadata: meta({ importance: 0.40, domain: "personal", keywords: ["philips", "air", "purifier", "bengaluru", "aqi", "winter", "bedroom"], timestamp: monthsAgo(2) })
  }
);

// ─── Noise: semantic memories (unrelated concepts) ────────────────────────────

MEMORIES.push(
  {
    id: "eval-s006", sessionId: SESSIONS.NOISE, memoryType: "semantic",
    content: "Quantum computing leverages superposition and entanglement to solve problems intractable for classical computers. Current quantum hardware still requires near-absolute-zero cooling.",
    summary: "Quantum computing uses superposition/entanglement; current hardware needs extreme cooling.",
    metadata: meta({ importance: 0.40, domain: "education", keywords: ["quantum", "computing", "superposition", "entanglement", "cooling"], timestamp: monthsAgo(4) })
  },
  {
    id: "eval-s007", sessionId: SESSIONS.NOISE, memoryType: "semantic",
    content: "The Carnatic music tradition uses 72 parent scales (Melakarta ragas) from which thousands of derivative ragas are built.",
    summary: "Carnatic music has 72 Melakarta ragas as parent scales.",
    metadata: meta({ importance: 0.32, domain: "education", keywords: ["carnatic", "music", "melakarta", "ragas", "72", "scales"], timestamp: monthsAgo(6) })
  },
  {
    id: "eval-s008", sessionId: SESSIONS.NOISE, memoryType: "semantic",
    content: "Photosynthesis converts carbon dioxide and water into glucose and oxygen using light energy absorbed by chlorophyll.",
    summary: "Photosynthesis: CO2 + H2O → glucose + O2 via chlorophyll.",
    metadata: meta({ importance: 0.22, domain: "education", keywords: ["photosynthesis", "carbon", "dioxide", "glucose", "oxygen", "chlorophyll"], timestamp: monthsAgo(8) })
  },
  {
    id: "eval-s009", sessionId: SESSIONS.NOISE, memoryType: "semantic",
    content: "Sushi rice requires a precise vinegar-to-salt-to-sugar ratio to achieve the right stickiness and flavour balance.",
    summary: "Sushi rice needs precise vinegar/salt/sugar ratio for texture and flavour.",
    metadata: meta({ importance: 0.30, domain: "personal", keywords: ["sushi", "rice", "vinegar", "salt", "sugar", "sticky"], timestamp: monthsAgo(5) })
  },
  {
    id: "eval-s010", sessionId: SESSIONS.NOISE, memoryType: "semantic",
    content: "The Doppler effect describes the change in frequency of a wave (sound or light) when the source and observer are moving relative to each other.",
    summary: "Doppler effect: frequency shift when source/observer move relative to each other.",
    metadata: meta({ importance: 0.20, domain: "education", keywords: ["doppler", "effect", "frequency", "wave", "sound", "light"], timestamp: monthsAgo(7) })
  },
  {
    id: "eval-s011", sessionId: SESSIONS.NOISE, memoryType: "semantic",
    content: "Black-and-white street photography benefits from strong contrast and decisive moments rather than post-processing filters.",
    summary: "B&W street photography: strong contrast and decisive moment over filters.",
    metadata: meta({ importance: 0.28, domain: "personal", keywords: ["photography", "black", "white", "contrast", "street", "filters"], timestamp: monthsAgo(3) })
  },
  {
    id: "eval-s012", sessionId: SESSIONS.NOISE, memoryType: "semantic",
    content: "The Indian Penal Code is being replaced by the Bharatiya Nyaya Sanhita, which modernises criminal law with updated sections.",
    summary: "IPC replaced by Bharatiya Nyaya Sanhita (modernised Indian criminal law).",
    metadata: meta({ importance: 0.35, domain: "education", keywords: ["ipc", "bharatiya", "nyaya", "sanhita", "criminal", "law", "india"], timestamp: monthsAgo(2) })
  },
  {
    id: "eval-s013", sessionId: SESSIONS.NOISE, memoryType: "semantic",
    content: "Monsoon in South India typically runs from June to September, with the Southwest monsoon bringing most of the annual rainfall to Karnataka.",
    summary: "South India monsoon: June–September; Southwest monsoon covers Karnataka.",
    metadata: meta({ importance: 0.30, domain: "personal", keywords: ["monsoon", "south", "india", "june", "september", "karnataka", "southwest"], timestamp: monthsAgo(1) })
  },
  {
    id: "eval-s014", sessionId: SESSIONS.NOISE, memoryType: "semantic",
    content: "Classical ballet positions are numbered in French from first to fifth position; turnout is the fundamental defining posture.",
    summary: "Ballet: five French positions; turnout is foundational posture.",
    metadata: meta({ importance: 0.18, domain: "education", keywords: ["ballet", "positions", "french", "turnout", "classical"], timestamp: monthsAgo(9) })
  },
  {
    id: "eval-s015", sessionId: SESSIONS.NOISE, memoryType: "semantic",
    content: "Compound interest grows wealth exponentially. Albert Einstein allegedly called it the eighth wonder of the world.",
    summary: "Compound interest grows exponentially; often called the 8th wonder (Einstein quote).",
    metadata: meta({ importance: 0.38, domain: "education", keywords: ["compound", "interest", "wealth", "exponential", "einstein", "wonder"], timestamp: monthsAgo(4) })
  }
);

// ─── Final count assertion ────────────────────────────────────────────────────

const TOTAL_EXPECTED = 160; // 90 factual + 55 episodic + 15 semantic
if (MEMORIES.length !== TOTAL_EXPECTED) {
  console.error(`\n❌ BUG: expected ${TOTAL_EXPECTED} memories but catalogue has ${MEMORIES.length}`);
  process.exit(1);
}

// ─── Category breakdown for reporting ────────────────────────────────────────

const CATEGORIES = {
  "A: Personal facts & preferences":         MEMORIES.filter(m => /^eval-f0(0[1-9]|1\d|20)$/.test(m.id)),
  "B: Projects & technical info":            MEMORIES.filter(m => /^eval-f(02[1-9]|03\d|040)$|^eval-s00[1-5]$/.test(m.id)),
  "C: Past conversations / episodic events": MEMORIES.filter(m => /^eval-e0(0[1-9]|[12]\d|30)$/.test(m.id)),
  "D: Goals & tasks":                        MEMORIES.filter(m => /^eval-f0(4[1-9]|5[0-5])$|^eval-e03[1-5]$/.test(m.id)),
  "E: Dates & events":                       MEMORIES.filter(m => /^eval-e0(3[6-9]|4\d|50)$/.test(m.id)),
  "F: Recent vs old memories":               MEMORIES.filter(m => /^eval-f05[6-9]$|^eval-f060$|^eval-e05[1-5]$/.test(m.id)),
  "G: Same-topic cluster (health/diet)":     MEMORIES.filter(m => /^eval-f06[1-9]$|^eval-f070$/.test(m.id)),
  "H: Distractors / noise":                  MEMORIES.filter(m => /^eval-f0(7[1-9]|8\d|90)$|^eval-s0(0[6-9]|1[0-5])$/.test(m.id)),
};

// ─── Postgres writer ──────────────────────────────────────────────────────────

async function writeToPostgres(factualMemories) {
  const { default: postgres } = await import("postgres");

  const ssl = process.env.POSTGRES_SSL === "disable" ? false : "require";
  const sql = postgres(process.env.POSTGRES_URL, {
    max: 3,
    ssl,
    idle_timeout: 30,
    connect_timeout: 15,
    // Suppress DDL NOTICE messages (relation already exists, column already exists, etc.)
    onnotice: () => {}
  });

  try {
    // Ensure table + indexes exist (same DDL as postgres-client.js)
    await sql`
      create table if not exists factual_memories (
        id uuid primary key,
        session_id text not null,
        fingerprint text not null,
        source_event_id uuid,
        memory_type text not null,
        content text not null,
        summary text not null,
        metadata jsonb not null,
        embedding jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (session_id, fingerprint)
      )
    `;

    await sql`alter table factual_memories add column if not exists user_id text`;

    await sql`
      create unique index if not exists factual_memories_user_fingerprint_idx
      on factual_memories (user_id, fingerprint)
      where user_id is not null
    `;

    await sql`
      create index if not exists factual_memories_session_idx
      on factual_memories (session_id)
    `;

    await sql`
      create index if not exists factual_memories_user_idx
      on factual_memories (user_id)
      where user_id is not null
    `;

    await sql`
      alter table factual_memories
      add column if not exists search_vector tsvector
        generated always as (
          to_tsvector('english', coalesce(content,'') || ' ' || coalesce(summary,''))
        ) stored
    `;

    await sql`
      create index if not exists factual_memories_fts_idx
      on factual_memories using gin(search_vector)
    `;

    // Insert all factual memories
    let inserted = 0;
    let skipped  = 0;

    for (const m of factualMemories) {
      const fp  = m.fingerprint || computeMemoryFingerprint(m.content);
      const ts  = m.metadata.timestamp;
      // Use a deterministic UUID as the actual primary key; store the stable
      // eval string ID in metadata so queries can filter by it.
      const uid = deterministicUUID(m.id);
      const metaWithEvalId = { ...m.metadata, evalId: m.id };

      try {
        await sql`
          insert into factual_memories (
            id, session_id, user_id, fingerprint, source_event_id, memory_type,
            content, summary, metadata, embedding, created_at, updated_at
          ) values (
            ${uid}, ${m.sessionId}, ${EVAL_USER_ID}, ${fp}, ${EVAL_SOURCE_EVT},
            ${m.memoryType}, ${m.content}, ${m.summary},
            ${sql.json(metaWithEvalId)}, ${null}, ${ts}, ${ts}
          )
          on conflict (user_id, fingerprint) where user_id is not null
          do update set
            summary         = excluded.summary,
            content         = excluded.content,
            updated_at      = excluded.updated_at,
            metadata        = excluded.metadata
        `;
        inserted++;
      } catch (err) {
        if (err.code === "23505") {
          skipped++;
        } else {
          throw err;
        }
      }
    }

    return { inserted, skipped };
  } finally {
    await sql.end();
  }
}

// ─── Delete all eval records from Postgres ────────────────────────────────────

async function deleteFromPostgres() {
  const { default: postgres } = await import("postgres");
  const ssl = process.env.POSTGRES_SSL === "disable" ? false : "require";
  const sql = postgres(process.env.POSTGRES_URL, { max: 2, ssl, onnotice: () => {} });
  try {
    const result = await sql`
      delete from factual_memories
      where user_id = ${EVAL_USER_ID}
         or session_id like 'eval-session-%'
    `;
    console.log(`  🗑  Deleted ${result.count} factual memories from Postgres`);
  } finally {
    await sql.end();
  }
}

// ─── Qdrant writer ────────────────────────────────────────────────────────────

function buildQdrantHeaders() {
  const h = { "Content-Type": "application/json" };
  if (process.env.QDRANT_API_KEY) h["api-key"] = process.env.QDRANT_API_KEY;
  return h;
}

async function callQdrant(path, init = {}) {
  const base = (process.env.QDRANT_URL || "").replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...buildQdrantHeaders(), ...(init.headers || {}) }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Qdrant ${path} → ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function ensureQdrantCollection(vectorSize) {
  const col     = process.env.QDRANT_COLLECTION || "neura_vector_memories";
  const distance = process.env.QDRANT_DISTANCE  || "Cosine";

  try {
    const info = await callQdrant(`/collections/${col}`);
    const existing = info?.result?.config?.params?.vectors?.size;
    if (existing && existing !== vectorSize) {
      throw new Error(
        `Qdrant collection vector size mismatch: stored=${existing}, embedding=${vectorSize}. ` +
        "Delete the collection manually or use a matching embedding model."
      );
    }
    return col;
  } catch (err) {
    if (!err.message?.includes("404")) throw err;
  }

  await callQdrant(`/collections/${col}`, {
    method: "PUT",
    body: JSON.stringify({ vectors: { size: vectorSize, distance } })
  });

  await callQdrant(`/collections/${col}/index`, {
    method: "PUT",
    body: JSON.stringify({ field_name: "sessionId", field_schema: "keyword" })
  });

  return col;
}

async function writeToQdrant(vectorMemories, embedFn) {
  if (!process.env.QDRANT_URL) {
    return { inserted: 0, skipped: vectorMemories.length, reason: "QDRANT_URL not set" };
  }

  const col = process.env.QDRANT_COLLECTION || "neura_vector_memories";
  let inserted = 0;
  let failed   = 0;

  // Process in small batches to avoid rate limits on the embedding API
  const BATCH = 3;
  const BATCH_DELAY_MS = 2000; // 2 second pause between batches

  for (let i = 0; i < vectorMemories.length; i += BATCH) {
    const batch = vectorMemories.slice(i, i + BATCH);
    const points = [];

    for (const m of batch) {
      const text      = `${m.memoryType}: ${m.summary}`;
      const embedding = await embedFn(text);

      if (!embedding) {
        console.warn(`  ⚠️  No embedding for ${m.id} — skipping Qdrant insert`);
        failed++;
        continue;
      }

      // Ensure collection exists with the right vector size
      if (points.length === 0 && i === 0) {
        await ensureQdrantCollection(embedding.length);
      }

      const fp        = m.fingerprint || computeMemoryFingerprint(m.content);
      const pointId   = deterministicUUID(m.id); // stable, reproducible UUID
      points.push({
        id:      pointId,
        vector:  embedding,
        payload: {
          sessionId:     m.sessionId,
          userId:        EVAL_USER_ID,
          fingerprint:   fp,
          sourceEventId: EVAL_SOURCE_EVT,
          memoryType:    m.memoryType,
          content:       m.content,
          summary:       m.summary,
          metadata:      { ...m.metadata, evalId: m.id },
        }
      });
    }

    if (points.length === 0) continue;

    await callQdrant(`/collections/${col}/points`, {
      method: "PUT",
      body: JSON.stringify({ points })
    });

    inserted += points.length;
    process.stdout.write(`  ⬆  Qdrant: ${inserted}/${vectorMemories.length} upserted\r`);

    // Pause between batches to stay within embedding API rate limits
    if (i + BATCH < vectorMemories.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  process.stdout.write("\n");
  return { inserted, failed };
}

// ─── Delete all eval records from Qdrant ─────────────────────────────────────

async function deleteFromQdrant() {
  if (!process.env.QDRANT_URL) return;
  const col = process.env.QDRANT_COLLECTION || "neura_vector_memories";

  // Collect point IDs from all eval sessions (sessionId is indexed in Qdrant)
  const evalSessions = Object.values(SESSIONS);
  let evalIds = [];

  for (const sess of evalSessions) {
    let offset = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const body = {
        with_payload: false,
        with_vector: false,
        limit: 100,
        filter: { must: [{ key: "sessionId", match: { value: sess } }] }
      };
      if (offset) body.offset = offset;

      let payload;
      try {
        payload = await callQdrant(`/collections/${col}/points/scroll`, {
          method: "POST",
          body: JSON.stringify(body)
        });
      } catch (err) {
        if (err.message?.includes("404")) break;
        throw err;
      }

      const pts = payload?.result?.points || [];
      evalIds.push(...pts.map(p => p.id));
      offset = payload?.result?.next_page_offset;
      if (!offset || pts.length === 0) break;
    }
  }

  if (evalIds.length === 0) {
    console.log("  🗑  No eval Qdrant points to delete");
    return;
  }

  await callQdrant(`/collections/${col}/points/delete`, {
    method: "POST",
    body: JSON.stringify({ points: evalIds })
  });

  console.log(`  🗑  Deleted ${evalIds.length} vector memories from Qdrant`);
}

// ─── Embedding function ───────────────────────────────────────────────────────

async function buildEmbedFn() {
  const apiKey  = process.env.OPENAI_API_KEY;
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model   = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

  if (!apiKey) {
    console.warn("  ⚠️  OPENAI_API_KEY not set — vector memories will be skipped");
    return null;
  }

  return async function embedText(text) {
    const maxRetries = 5;
    let delay = 3000; // start with 3 seconds

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const res = await fetch(`${baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, input: text, encoding_format: "float" })
      });

      if (res.ok) {
        const payload = await res.json();
        return payload?.data?.[0]?.embedding ?? null;
      }

      // Rate limit — wait and retry
      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : delay;
        console.warn(`  ⏳  Rate limited (429), waiting ${Math.round(waitMs / 1000)}s before retry ${attempt}/${maxRetries} …`);
        await new Promise(r => setTimeout(r, waitMs));
        delay = Math.min(delay * 2, 30000); // exponential backoff capped at 30s
        continue;
      }

      const body = await res.text();
      throw new Error(`Embedding API ${res.status}: ${body}`);
    }

    throw new Error(`Embedding API still rate-limited after ${maxRetries} retries`);
  };
}

// ─── Print summary ────────────────────────────────────────────────────────────

function printSummary(results) {
  const sep = "─".repeat(72);
  console.log(`\n${sep}`);
  console.log("  AiNeura Context-Retrieval Evaluation — Seed Summary");
  console.log(sep);
  console.log(`  Namespace:  userId = ${EVAL_USER_ID}`);
  console.log(`  Sessions:   ${Object.values(SESSIONS).join(", ")}`);
  console.log(`  Total records seeded:`);
  console.log(`    Postgres (factual): ${results.postgres.inserted} inserted, ${results.postgres.skipped} already existed`);
  if (results.qdrant) {
    console.log(`    Qdrant (episodic+semantic): ${results.qdrant.inserted} inserted, ${results.qdrant.failed} failed`);
  } else {
    console.log(`    Qdrant: skipped (QDRANT_URL not set)`);
  }
  console.log(`  Grand total: ${results.total} memories`);

  console.log(`\n  Category breakdown:`);
  for (const [label, mems] of Object.entries(CATEGORIES)) {
    const factual  = mems.filter(m => m.memoryType === "factual").length;
    const episodic = mems.filter(m => m.memoryType === "episodic").length;
    const semantic = mems.filter(m => m.memoryType === "semantic").length;
    const details  = [
      factual  ? `${factual} factual`   : null,
      episodic ? `${episodic} episodic` : null,
      semantic ? `${semantic} semantic` : null,
    ].filter(Boolean).join(", ");
    console.log(`    ${label.padEnd(45)} ${String(mems.length).padStart(3)} total  [${details}]`);
  }

  console.log(`\n  Sample IDs by category:`);
  const samples = {
    "Personal":  ["eval-f001", "eval-f007", "eval-f016"],
    "Projects":  ["eval-f021", "eval-f026", "eval-s001"],
    "History":   ["eval-e001", "eval-e012", "eval-e022"],
    "Goals":     ["eval-f041", "eval-f047", "eval-e033"],
    "Events":    ["eval-e036", "eval-e041", "eval-e044"],
    "Recency":   ["eval-f056", "eval-f060", "eval-e055"],
    "Topics":    ["eval-f061", "eval-f066", "eval-f070"],
    "Noise":     ["eval-f071", "eval-f080", "eval-s006"],
  };
  for (const [cat, ids] of Object.entries(samples)) {
    const preview = ids.map(id => {
      const m = MEMORIES.find(x => x.id === id);
      return m ? `${id}: "${m.summary.slice(0, 50)}…"` : id;
    });
    console.log(`    ${cat}:`);
    for (const p of preview) console.log(`      ${p}`);
  }

  console.log(`\n  Reset & recreate:`);
  console.log(`    node tools/seed-context-evaluation-data.js --reset`);
  console.log(`    npm run seed-context-evaluation -- --reset`);
  console.log(`\n  Data is ready for retrieval testing ✓`);
  console.log(sep);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🌱  AiNeura Context-Retrieval Evaluation Seed Script");
  console.log(`    userId: ${EVAL_USER_ID}`);
  console.log(`    Records designed: ${MEMORIES.length}`);
  if (DRY_RUN)  console.log("    Mode: DRY-RUN (no writes)\n");
  if (RESET)    console.log("    Mode: RESET (wipe + reseed)\n");

  if (DRY_RUN) {
    console.log("  📋  Catalogue preview (first 10):");
    for (const m of MEMORIES.slice(0, 10)) {
      console.log(`    ${m.id.padEnd(14)} [${m.memoryType.padEnd(8)}] ${m.summary.slice(0, 60)}`);
    }
    console.log(`    … and ${MEMORIES.length - 10} more\n`);
    printSummary({
      postgres: { inserted: 0, skipped: 0 },
      qdrant:   null,
      total:    0
    });
    return;
  }

  // ── Reset: delete existing eval data ────────────────────────────────────────
  if (RESET) {
    console.log("\n  🔄  Resetting eval data …");
    if (process.env.POSTGRES_URL) await deleteFromPostgres();
    await deleteFromQdrant();
    console.log("  ✅  Reset complete\n");
  }

  // ── Split by store ────────────────────────────────────────────────────────
  const factualMems = MEMORIES.filter(m => m.memoryType === "factual");
  const vectorMems  = MEMORIES.filter(m => m.memoryType !== "factual");

  // ── Postgres write ────────────────────────────────────────────────────────
  let pgResult = { inserted: 0, skipped: 0 };
  if (process.env.POSTGRES_URL) {
    console.log(`\n  📥  Writing ${factualMems.length} factual memories to Postgres …`);
    pgResult = await writeToPostgres(factualMems);
    console.log(`  ✅  Postgres: ${pgResult.inserted} inserted, ${pgResult.skipped} already existed`);
  } else {
    console.warn("  ⚠️  POSTGRES_URL not set — factual memories skipped");
  }

  // ── Qdrant write ──────────────────────────────────────────────────────────
  let qdrantResult = null;
  if (process.env.QDRANT_URL) {
    console.log(`\n  🔢  Embedding & writing ${vectorMems.length} vector memories to Qdrant …`);
    console.log("       (this calls the embedding API for each memory — may take 1-2 minutes)\n");
    const embedFn = await buildEmbedFn();
    if (embedFn) {
      qdrantResult = await writeToQdrant(vectorMems, embedFn);
      console.log(`  ✅  Qdrant: ${qdrantResult.inserted} inserted, ${qdrantResult.failed} failed`);
    } else {
      console.warn("  ⚠️  Embedding function unavailable — Qdrant write skipped");
    }
  } else {
    console.warn("  ⚠️  QDRANT_URL not set — vector memories skipped");
  }

  const total =
    (pgResult.inserted) +
    (qdrantResult?.inserted || 0);

  printSummary({ postgres: pgResult, qdrant: qdrantResult, total });
}

main().catch(err => {
  console.error("\n❌  Seed script failed:", err);
  process.exit(1);
});
