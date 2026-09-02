/**
 * tools/eval-ground-truth.js
 *
 * GROUND TRUTH for the Context/Memory Retrieval Evaluation.
 *
 * ⚠️  IMPORTANT — READ BEFORE MODIFYING:
 *   This file defines the EXPECTED set of memories for each query.
 *   EXPECTED must be defined BEFORE running any retrieval.
 *   Do NOT change expected sets after seeing retrieval results.
 *   Every expected memory must have a written justification.
 *
 * Convention:
 *   Each entry has:
 *     id          – stable query identifier (Q01 … Q40)
 *     query       – realistic natural-language query string
 *     sessionId   – session used when calling the retrieval pipeline
 *     expected    – array of { memoryId, reason } objects
 *     category    – which aspect of retrieval this query tests
 *
 * Total: 40 queries across all 8 seed categories.
 *
 * Generated: 2026-09-01  (before any retrieval was run)
 */

export const GROUND_TRUTH = [

  // ─── Block 1: Exact factual recall (personal identity) ───────────────────

  {
    id: "Q01",
    query: "What is my name and where do I live?",
    sessionId: "eval-session-personal",
    category: "exact-factual-recall",
    expected: [
      { memoryId: "eval-f001", reason: "Directly states user's name (Arjun Mehta) and age." },
      { memoryId: "eval-f002", reason: "Directly states user's location (Koramangala, Bengaluru)." },
    ]
  },

  {
    id: "Q02",
    query: "Tell me about my educational background and work history.",
    sessionId: "eval-session-personal",
    category: "exact-factual-recall",
    expected: [
      { memoryId: "eval-f018", reason: "States B.Tech CS from IIT Bombay 2015." },
      { memoryId: "eval-f003", reason: "States current job: senior SE at PaySwift fintech startup." },
      { memoryId: "eval-f060", reason: "States when user joined PaySwift (2 years ago as senior engineer)." },
    ]
  },

  {
    id: "Q03",
    query: "What programming languages do I use and for how long?",
    sessionId: "eval-session-personal",
    category: "exact-factual-recall",
    expected: [
      { memoryId: "eval-f004", reason: "Directly states Python and TypeScript for 8+ years." },
    ]
  },

  {
    id: "Q04",
    query: "What are my dietary restrictions and food preferences?",
    sessionId: "eval-session-personal",
    category: "exact-factual-recall",
    expected: [
      { memoryId: "eval-f007", reason: "Directly states user is vegetarian and allergic to peanuts." },
      { memoryId: "eval-f006", reason: "States favourite breakfast: idli with sambar." },
    ]
  },

  // ─── Block 2: Project and technical context ───────────────────────────────

  {
    id: "Q05",
    query: "What project am I currently working on at PaySwift?",
    sessionId: "eval-session-projects",
    category: "project-technical-context",
    expected: [
      { memoryId: "eval-f021", reason: "Directly states user is building payment gateway SDK." },
      { memoryId: "eval-f022", reason: "Describes SDK technology stack (TypeScript, React, Vue)." },
      { memoryId: "eval-f026", reason: "States user owns the fraud detection microservice." },
    ]
  },

  {
    id: "Q06",
    query: "What is the tech stack and infrastructure for the PaySwift backend?",
    sessionId: "eval-session-projects",
    category: "project-technical-context",
    expected: [
      { memoryId: "eval-f023", reason: "Describes PostgreSQL + Redis stack for transactions and caching." },
      { memoryId: "eval-f025", reason: "Describes AWS ECS Fargate deployment with auto-scaling." },
      { memoryId: "eval-f024", reason: "Describes JWT authentication with 15-min TTL." },
      { memoryId: "eval-f039", reason: "States 99.95% availability SLO for payment API." },
    ]
  },

  {
    id: "Q07",
    query: "What is the fraud detection service and how does it work?",
    sessionId: "eval-session-projects",
    category: "project-technical-context",
    expected: [
      { memoryId: "eval-f026", reason: "States user owns the fraud detection microservice with rule-based engine." },
      { memoryId: "eval-f030", reason: "States fraud detection handles ~50K transactions/day." },
      { memoryId: "eval-s002", reason: "Semantic memory about rule-based fraud detection and ML improvements." },
      { memoryId: "eval-f054", reason: "Goal to migrate fraud detection rules to OPA policy-as-code." },
    ]
  },

  {
    id: "Q08",
    query: "What payment methods does PaySwift support?",
    sessionId: "eval-session-projects",
    category: "project-technical-context",
    expected: [
      { memoryId: "eval-f037", reason: "Directly lists supported payment methods: UPI, credit/debit cards, BNPL." },
    ]
  },

  {
    id: "Q09",
    query: "What tools and frameworks do I use for testing?",
    sessionId: "eval-session-projects",
    category: "project-technical-context",
    expected: [
      { memoryId: "eval-f036", reason: "Directly states Vitest for unit tests and Playwright for E2E." },
      { memoryId: "eval-f028", reason: "Mentions test coverage target 80%, currently 73%." },
    ]
  },

  {
    id: "Q10",
    query: "What monitoring and observability tools does PaySwift use?",
    sessionId: "eval-session-projects",
    category: "project-technical-context",
    expected: [
      { memoryId: "eval-f029", reason: "Directly states Datadog for monitoring with latency/error/payment dashboards." },
      { memoryId: "eval-f040", reason: "States OpenTelemetry for distributed tracing." },
    ]
  },

  // ─── Block 3: Semantic / paraphrased recall ───────────────────────────────

  {
    id: "Q11",
    query: "What consistency challenges do payment systems face?",
    sessionId: "eval-session-projects",
    category: "semantic-paraphrased-recall",
    expected: [
      { memoryId: "eval-s001", reason: "Semantic memory about consistency guarantees, idempotency keys, distributed locks in payments." },
    ]
  },

  {
    id: "Q12",
    query: "How can I improve the reliability of my TypeScript API boundaries?",
    sessionId: "eval-session-projects",
    category: "semantic-paraphrased-recall",
    expected: [
      { memoryId: "eval-s003", reason: "Semantic memory about TypeScript strict mode and zod runtime validation for API type safety." },
      { memoryId: "eval-f004", reason: "States user's 8+ years TypeScript experience (context)." },
    ]
  },

  {
    id: "Q13",
    query: "What do I need to know about database connection management under load?",
    sessionId: "eval-session-projects",
    category: "semantic-paraphrased-recall",
    expected: [
      { memoryId: "eval-s004", reason: "Semantic memory about connection pooling (PgBouncer) to prevent connection storms." },
      { memoryId: "eval-f023", reason: "States PaySwift uses PostgreSQL — directly relevant context." },
    ]
  },

  {
    id: "Q14",
    query: "What happened during the security incident with our OAuth implementation?",
    sessionId: "eval-session-history",
    category: "semantic-paraphrased-recall",
    expected: [
      { memoryId: "eval-e012", reason: "Directly describes the PKCE bypass vulnerability in OAuth flow." },
    ]
  },

  // ─── Block 4: Episodic / past-event recall ────────────────────────────────

  {
    id: "Q15",
    query: "What production incidents have we had recently?",
    sessionId: "eval-session-history",
    category: "episodic-recall",
    expected: [
      { memoryId: "eval-e002", reason: "Production incident: payment webhook timing out due to missing DB index." },
      { memoryId: "eval-e014", reason: "December deployment caused 45-minute outage due to misconfigured feature flag." },
      { memoryId: "eval-e016", reason: "Race condition in webhook dedup logic causing double-processed payments." },
    ]
  },

  {
    id: "Q16",
    query: "What did we discuss in the last sprint retrospective?",
    sessionId: "eval-session-history",
    category: "episodic-recall",
    expected: [
      { memoryId: "eval-e004", reason: "Directly describes sprint retrospective discussion about slow PR review cycles." },
    ]
  },

  {
    id: "Q17",
    query: "What is the status of new team members I recently onboarded?",
    sessionId: "eval-session-history",
    category: "episodic-recall",
    expected: [
      { memoryId: "eval-e005", reason: "States Nikhil was onboarded last Tuesday, ramping up on payment service." },
      { memoryId: "eval-e035", reason: "States Megha (senior backend, Kafka/Go) was hired and joins next month." },
    ]
  },

  {
    id: "Q18",
    query: "Tell me about the BNPL feature we shipped.",
    sessionId: "eval-session-history",
    category: "episodic-recall",
    expected: [
      { memoryId: "eval-e006", reason: "Directly describes BNPL launch to production after 3 months development." },
      { memoryId: "eval-f037", reason: "Factual: payment gateway supports BNPL." },
    ]
  },

  {
    id: "Q19",
    query: "What is the update from my 1:1 with my manager?",
    sessionId: "eval-session-history",
    category: "episodic-recall",
    expected: [
      { memoryId: "eval-e008", reason: "Directly describes 1:1 with Anjali mentioning on-track staff engineer promotion." },
      { memoryId: "eval-e019", reason: "Annual performance review 4.2/5 qualifying for 15% salary increment." },
    ]
  },

  {
    id: "Q20",
    query: "What architectural decisions have we made recently?",
    sessionId: "eval-session-history",
    category: "episodic-recall",
    expected: [
      { memoryId: "eval-e028", reason: "Team adopted ADR practice for documenting architectural decisions." },
      { memoryId: "eval-e030", reason: "Added circuit breakers for all third-party payment integrations post-incident." },
      { memoryId: "eval-e009", reason: "Completed MongoDB→PostgreSQL migration for transactions service." },
    ]
  },

  // ─── Block 5: Goals and tasks ─────────────────────────────────────────────

  {
    id: "Q21",
    query: "What are my current engineering goals for this quarter?",
    sessionId: "eval-session-goals",
    category: "goals-tasks",
    expected: [
      { memoryId: "eval-f041", reason: "Primary Q3 goal: reduce payment failure rate from 2.1% to < 1.5%." },
      { memoryId: "eval-f043", reason: "Task: hire 2 senior backend engineers by Q3 end." },
      { memoryId: "eval-f044", reason: "Plan: refactor payment routing logic before next major release." },
    ]
  },

  {
    id: "Q22",
    query: "What certifications and courses am I working toward?",
    sessionId: "eval-session-goals",
    category: "goals-tasks",
    expected: [
      { memoryId: "eval-f042", reason: "Goal: AWS Solutions Architect Professional cert by year-end." },
      { memoryId: "eval-e031", reason: "Booked AWS architect exam for October 15." },
      { memoryId: "eval-f045", reason: "Reading 1 tech book/month; currently reading DDIA by Kleppmann." },
    ]
  },

  {
    id: "Q23",
    query: "What engineering improvements am I planning to make to our infrastructure?",
    sessionId: "eval-session-goals",
    category: "goals-tasks",
    expected: [
      { memoryId: "eval-f052", reason: "Plan: add structured logging with correlation IDs across all services." },
      { memoryId: "eval-f050", reason: "Task: set up on-call rotation for payment team." },
      { memoryId: "eval-f046", reason: "Task: improve API documentation coverage from 40%." },
    ]
  },

  {
    id: "Q24",
    query: "What personal fitness goals am I working on?",
    sessionId: "eval-session-goals",
    category: "goals-tasks",
    expected: [
      { memoryId: "eval-f047", reason: "Training for marathon in November, running 5 days/week." },
      { memoryId: "eval-e033", reason: "Ran half-marathon in 2:08 as a training milestone." },
      { memoryId: "eval-e044", reason: "Registered for Bengaluru marathon November 17, bib #4523." },
    ]
  },

  // ─── Block 6: Dates and upcoming events ──────────────────────────────────

  {
    id: "Q25",
    query: "What important events or deadlines do I have coming up in November?",
    sessionId: "eval-session-events",
    category: "dates-events",
    expected: [
      { memoryId: "eval-e037", reason: "Father's 65th birthday on November 3." },
      { memoryId: "eval-e044", reason: "Bengaluru marathon on November 17." },
      { memoryId: "eval-e041", reason: "PCI-DSS audit November 10-12; documentation due November 1." },
    ]
  },

  {
    id: "Q26",
    query: "What is the status of hiring Megha and when does she join?",
    sessionId: "eval-session-events",
    category: "dates-events",
    expected: [
      { memoryId: "eval-e035", reason: "States Megha was hired (Kafka/Go experience) to join next month." },
      { memoryId: "eval-e047", reason: "States Megha joins October 1; onboarding plan due September 25." },
    ]
  },

  {
    id: "Q27",
    query: "When is the company offsite and what am I presenting?",
    sessionId: "eval-session-events",
    category: "dates-events",
    expected: [
      { memoryId: "eval-e049", reason: "Company offsite Coorg October 25-27; user presenting 2025 tech roadmap." },
    ]
  },

  {
    id: "Q28",
    query: "What trip have I planned for the end of the year?",
    sessionId: "eval-session-events",
    category: "dates-events",
    expected: [
      { memoryId: "eval-e043", reason: "Japan trip booked December 20 – January 1; first visit to Japan." },
    ]
  },

  // ─── Block 7: Recency – recent memories ──────────────────────────────────

  {
    id: "Q29",
    query: "What have I been working on today or in the last few hours?",
    sessionId: "eval-session-recency",
    category: "recency-recent",
    expected: [
      { memoryId: "eval-f056", reason: "Just approved BNPL refund flow PR for merge (1h ago)." },
      { memoryId: "eval-f057", reason: "Sent weekly engineering update email this morning (2h ago)." },
      { memoryId: "eval-e051", reason: "Stand-up: velocity attack fraud rule ready for QA (3h ago)." },
      { memoryId: "eval-f058", reason: "Fixed broken CI test blocking all PR merges (5h ago)." },
    ]
  },

  // ─── Block 8: Recency – older memories ───────────────────────────────────

  {
    id: "Q30",
    query: "When did I join PaySwift and what was it like then?",
    sessionId: "eval-session-recency",
    category: "recency-old",
    expected: [
      { memoryId: "eval-f060", reason: "States joined PaySwift as senior engineer January 2 years ago; 30 engineers at the time." },
      { memoryId: "eval-f059", reason: "Launched first PaySwift checkout SDK (credit card only) 6 months ago — historical milestone." },
    ]
  },

  {
    id: "Q31",
    query: "What major infrastructure migrations have we done in the past year?",
    sessionId: "eval-session-recency",
    category: "recency-old",
    expected: [
      { memoryId: "eval-e053", reason: "Migrated AWS from us-east-1 to ap-south-1 for India latency 3 months ago." },
      { memoryId: "eval-e009", reason: "Completed MongoDB→PostgreSQL migration for transactions service." },
    ]
  },

  // ─── Block 9: Same-topic cluster (health/diet) ───────────────────────────

  {
    id: "Q32",
    query: "What are my diet and nutrition habits?",
    sessionId: "eval-session-topics",
    category: "same-topic-cluster",
    expected: [
      { memoryId: "eval-f007", reason: "User is vegetarian and allergic to peanuts." },
      { memoryId: "eval-f061", reason: "Follows 16:8 intermittent fasting: noon–8 PM." },
      { memoryId: "eval-f062", reason: "Avoids refined sugar and white flour; uses jaggery and whole wheat." },
      { memoryId: "eval-f065", reason: "Doctor recommended 140g+ protein for muscle recovery." },
      { memoryId: "eval-f067", reason: "Doesn't drink alcohol; stopped 2 years ago." },
    ]
  },

  {
    id: "Q33",
    query: "What is my health and fitness routine?",
    sessionId: "eval-session-topics",
    category: "same-topic-cluster",
    expected: [
      { memoryId: "eval-f014", reason: "Goes to gym 3x/week for strength training." },
      { memoryId: "eval-f069", reason: "Sleeps 7-8 hours; schedule 11 PM to 6:30 AM." },
      { memoryId: "eval-f068", reason: "Drinks 3+ litres of water daily, especially on running days." },
      { memoryId: "eval-f063", reason: "Takes vitamin D3 2000IU and omega-3 1g daily." },
      { memoryId: "eval-f070", reason: "Resting heart rate improved from 72 to 58 BPM over 8 months training." },
    ]
  },

  // ─── Block 10: Multiple relevant memories (complex context) ──────────────

  {
    id: "Q34",
    query: "What is the state of my fraud detection work — what exists, what is broken, and what needs to change?",
    sessionId: "eval-session-projects",
    category: "multi-memory-complex",
    expected: [
      { memoryId: "eval-f026", reason: "User owns fraud detection microservice with rule-based engine." },
      { memoryId: "eval-f030", reason: "Fraud detection processes ~50K transactions/day." },
      { memoryId: "eval-s002", reason: "Rule-only fraud detection has high false positives; combining with ML improves accuracy." },
      { memoryId: "eval-f054", reason: "Goal to migrate fraud detection rules to OPA policy-as-code." },
      { memoryId: "eval-e001", reason: "Discussed fraud detection architecture; decided to add velocity attack rule." },
    ]
  },

  {
    id: "Q35",
    query: "What is my career progression and promotion status?",
    sessionId: "eval-session-history",
    category: "multi-memory-complex",
    expected: [
      { memoryId: "eval-f003", reason: "Current role: senior software engineer at PaySwift." },
      { memoryId: "eval-e008", reason: "1:1 with Anjali: on track for staff engineer promotion." },
      { memoryId: "eval-e019", reason: "Annual review 4.2/5; qualifies for 15% salary increment." },
      { memoryId: "eval-f038", reason: "User is tech lead for a team of 5 engineers." },
    ]
  },

  // ─── Block 11: Distractor / noise queries ────────────────────────────────

  {
    id: "Q36",
    query: "What do I know about quantum computing?",
    sessionId: "eval-session-noise",
    category: "noise-distractor",
    expected: [
      { memoryId: "eval-s006", reason: "Noise memory about quantum computing — only relevant memory for this topic." },
    ]
  },

  {
    id: "Q37",
    query: "Tell me about my personal interests and hobbies outside work.",
    sessionId: "eval-session-noise",
    category: "noise-distractor",
    expected: [
      { memoryId: "eval-f077", reason: "Supports RCB cricket team; attended 3 IPL matches." },
      { memoryId: "eval-f076", reason: "Uses Kindle Paperwhite for reading." },
      { memoryId: "eval-f084", reason: "Signed up for pottery class in HSR Layout." },
      { memoryId: "eval-f086", reason: "Planted balcony herb garden." },
    ]
  },

  // ─── Block 12: No-relevant-memory queries ────────────────────────────────

  {
    id: "Q38",
    query: "What is the recipe for making sourdough bread?",
    sessionId: "eval-session-noise",
    category: "no-relevant-memory",
    expected: [
      { memoryId: "eval-f072", reason: "Only seeded memory mentioning sourdough bread; loosely relevant." },
    ]
  },

  // ─── Block 13: Cross-session retrieval ───────────────────────────────────

  {
    id: "Q39",
    query: "What are all my upcoming important deadlines and milestones before year-end?",
    sessionId: "eval-session-goals",
    category: "cross-session-multi",
    expected: [
      { memoryId: "eval-e031", reason: "AWS exam booked for October 15." },
      { memoryId: "eval-f042", reason: "AWS cert goal by year-end." },
      { memoryId: "eval-e044", reason: "Bengaluru marathon November 17." },
      { memoryId: "eval-e043", reason: "Japan trip December 20–January 1." },
      { memoryId: "eval-f048", reason: "Goal: launch personal finance app with 500 beta users by year-end." },
    ]
  },

  {
    id: "Q40",
    query: "What has my team been building and what did we recently ship?",
    sessionId: "eval-session-history",
    category: "multi-memory-complex",
    expected: [
      { memoryId: "eval-e006", reason: "Shipped BNPL feature to production after 3 months development." },
      { memoryId: "eval-f021", reason: "Currently building payment gateway checkout SDK." },
      { memoryId: "eval-e025", reason: "Upgraded Node.js 20→22 across monorepo last sprint." },
      { memoryId: "eval-f037", reason: "Payment gateway supports UPI, credit/debit cards, BNPL." },
    ]
  },
];

// ─── Validation at load time ──────────────────────────────────────────────────

const ids = GROUND_TRUTH.map(q => q.id);
const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupIds.length > 0) {
  throw new Error(`Duplicate query IDs in ground truth: ${dupIds.join(", ")}`);
}

// Every expected entry must have both memoryId and reason
for (const qt of GROUND_TRUTH) {
  for (const exp of qt.expected) {
    if (!exp.memoryId || !exp.reason) {
      throw new Error(`Query ${qt.id}: expected entry missing memoryId or reason`);
    }
  }
}

export const TOTAL_QUERIES      = GROUND_TRUTH.length;
export const TOTAL_EXPECTED_IDS = GROUND_TRUTH.reduce((acc, q) => acc + q.expected.length, 0);
