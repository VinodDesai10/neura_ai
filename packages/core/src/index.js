const STOP_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "do",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "the",
  "this",
  "to",
  "we",
  "what",
  "you"
]);

const LOW_SIGNAL_PHRASES = [
  "hi",
  "hello",
  "thanks",
  "thank you",
  "okay",
  "ok",
  "cool",
  "great"
];

const DOMAIN_RULES = [
  {
    domain: "identity",
    weight: 0.95,
    terms: ["my name is", "i am", "i'm", "we are", "identity", "profile"]
  },
  {
    domain: "memory_system",
    weight: 0.9,
    terms: ["memory", "metadata", "retrieval", "embedding", "working memory", "vector", "qdrant", "neo4j", "postgres", "redis", "mongo"]
  },
  {
    domain: "architecture",
    weight: 0.85,
    terms: ["architecture", "pipeline", "system", "orchestrator", "processor", "storage", "database", "api", "backend"]
  },
  {
    domain: "project",
    weight: 0.82,
    terms: ["project", "capstone", "mvp", "demo", "feature", "roadmap", "requirement"]
  },
  {
    domain: "preference",
    weight: 0.78,
    terms: ["i prefer", "i like", "i dislike", "i want", "we want", "preference", "style"]
  },
  {
    domain: "planning",
    weight: 0.74,
    terms: ["plan", "next step", "todo", "deadline", "schedule", "today", "tomorrow", "yesterday", "last time", "previously"]
  },
  {
    domain: "engineering",
    weight: 0.72,
    terms: ["code", "bug", "test", "deploy", "server", "client", "frontend", "repository", "function", "class"]
  },
  {
    domain: "business",
    weight: 0.66,
    terms: ["customer", "market", "pricing", "revenue", "business", "sales", "startup", "product"]
  },
  {
    domain: "education",
    weight: 0.64,
    terms: ["learn", "study", "course", "college", "exam", "assignment", "teacher", "student"]
  },
  {
    domain: "personal",
    weight: 0.62,
    terms: ["family", "friend", "home", "birthday", "hobby", "personal"]
  }
];

const ENTITY_PATTERNS = [
  { type: "email", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { type: "url", regex: /\bhttps?:\/\/[^\s]+/gi },
  { type: "date", regex: /\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/gi },
  { type: "version", regex: /\bv?\d+\.\d+(?:\.\d+)?\b/gi },
  { type: "phone", regex: /\b(?:\+1|1)?[-.\s]?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/gi },
  { type: "mentions", regex: /\B@[a-zA-Z0-9_]+\b/g },
  { type: "hashtag", regex: /\B#[a-zA-Z0-9_]+\b/g },
  { type: "code_block", regex: /`[^`]+`/g },
  { type: "file_path", regex: /(?:\/[\w.-]+)+|C:\\(?:[\\w.-]+\\)+[\w.-]+/g }
];

function tokenize(content) {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term && !STOP_TERMS.has(term));
}

function hasLowSignalContent(content) {
  const lower = content.toLowerCase().trim();

  return LOW_SIGNAL_PHRASES.includes(lower) || lower.length < 8;
}

function clampScore(score) {
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function countMatches(content, terms) {
  const lower = content.toLowerCase();

  return terms.reduce(
    (count, term) => count + (lower.includes(term) ? 1 : 0),
    0
  );
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

// Enhanced pattern sets for memory type classification
const FACTUAL_PATTERNS = [
  // Identity assertions
  /\b(my name is|i am|i'm|we are|i'm a|i am a)\b/i,
  // Preferences
  /\b(i prefer|i like|i dislike|i want|we want|i don't want)\b/i,
  // Project/ownership
  /\b(my project|our project|our goal|my goal|i own|we own)\b/i,
  // Stable characteristics
  /\b(i'm based in|i live in|i work at|i study at|my role is)\b/i,
  // Decisions made
  /\b(i decided|we decided|i chose|we chose)\b/i,
  // Persistent facts
  /\b(my email|my phone|my username|my password|my url|my domain)\b/i,
  // Family/relationships
  /\b(my (mother|father|sibling|spouse|partner|daughter|son))\b/i,
  // Education/credentials
  /\b(i studied|i graduated|i majored|my degree|my certification)\b/i
];

const EPISODIC_PATTERNS = [
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
  // Recent actions
  /\b(i (built|created|added|fixed|changed|updated).*yesterday|today|last)\b/i,
  // Session-specific
  /\b(in this conversation|in this session|just now|moments ago|a few minutes ago)\b/i,
  // Timeline progression
  /\b(first|then|next|after that|later|afterward)\b/i
];

const SEMANTIC_PATTERNS = [
  // General knowledge
  /\b(generally|usually|typically|normally|in general)\b/i,
  // Conceptual
  /\b(concept of|idea|approach|method|strategy|pattern)\b/i,
  // Reasoning
  /\b(because|since|therefore|thus|which means)\b/i,
  // Technical knowledge
  /\b(react|nodejs|database|api|architecture|algorithm)\b/i,
  // Universal statements
  /\b((all|most|many|some)([\s\w]+)?(is|are|require|need|benefit from|involve))\b/i,
  // Definitions
  /\b((is defined as|refers to|means|implies|represents|signifies))\b/i,
  // Best practices
  /\b(best practice|good practice|standard|convention|rule|principle)\b/i
];

function scoreMemoryTypeMatch(content, patterns) {
  let matchCount = 0;
  for (const pattern of patterns) {
    if (pattern.test(content)) {
      matchCount++;
    }
  }
  return matchCount;
}

export function classifyMemoryType(content) {
  const lower = content.toLowerCase();

  const factualScore = scoreMemoryTypeMatch(lower, FACTUAL_PATTERNS);
  const episodicScore = scoreMemoryTypeMatch(lower, EPISODIC_PATTERNS);
  const semanticScore = scoreMemoryTypeMatch(lower, SEMANTIC_PATTERNS);

  // Return standard format for backward compatibility
  if (factualScore > 0 && factualScore >= episodicScore) {
    return "factual";
  }

  if (episodicScore > 0) {
    return "episodic";
  }

  return "semantic";
}

export function classifyMemoryTypeWithConfidence(content) {
  const lower = content.toLowerCase();

  const factualScore = scoreMemoryTypeMatch(lower, FACTUAL_PATTERNS);
  const episodicScore = scoreMemoryTypeMatch(lower, EPISODIC_PATTERNS);
  const semanticScore = scoreMemoryTypeMatch(lower, SEMANTIC_PATTERNS);

  // Use the same priority logic as classifyMemoryType so results are consistent:
  // factual wins if it has any match and is >= episodic,
  // episodic wins if it has any match and beats factual,
  // semantic is the explicit fallback when neither factual nor episodic fire.
  let primaryType;
  let maxScore;

  if (factualScore > 0 && factualScore >= episodicScore) {
    primaryType = "factual";
    maxScore = factualScore;
  } else if (episodicScore > 0) {
    primaryType = "episodic";
    maxScore = episodicScore;
  } else {
    primaryType = "semantic";
    maxScore = semanticScore;
  }

  // Calculate confidence (0-1).
  // totalMatches uses raw semanticScore (no artificial floor) so the denominator
  // is honest.
  const totalMatches = factualScore + episodicScore + semanticScore;
  const confidence = Math.min(1, maxScore / Math.max(1, totalMatches - 1) + 0.3);

  // Alternatives: other types that actually matched.
  const scoreEntries = [
    { type: "factual", score: factualScore },
    { type: "episodic", score: episodicScore },
    { type: "semantic", score: semanticScore }
  ]
    .filter(e => e.type !== primaryType && e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  return {
    memoryType: primaryType,
    confidence: clampScore(confidence),
    alternatives: scoreEntries.map(e => ({
      type: e.type,
      confidence: clampScore(Math.min(1, (e.score / Math.max(1, totalMatches - 1)) + 0.2))
    })),
    debug: { factualScore, episodicScore, semanticScore }
  };
}

export function summarizeMemoryCandidate(content) {
  return content.length <= 140 ? content : `${content.slice(0, 137)}...`;
}

function inferTags(content) {
  const lower = content.toLowerCase();
  const tags = [];

  if (lower.includes("project") || lower.includes("capstone")) {
    tags.push("project");
  }

  if (lower.includes("memory") || lower.includes("retrieval") || lower.includes("embedding")) {
    tags.push("memory");
  }

  if (lower.includes("architecture") || lower.includes("pipeline") || lower.includes("system")) {
    tags.push("architecture");
  }

  if (lower.includes("name is") || lower.includes("i am") || lower.includes("i'm")) {
    tags.push("identity");
  }

  if (lower.includes("prefer") || lower.includes("like") || lower.includes("want")) {
    tags.push("preference");
  }

  if (lower.includes("plan") || lower.includes("decision") || lower.includes("next step")) {
    tags.push("planning");
  }

  if (lower.includes("bug") || lower.includes("code") || lower.includes("test")) {
    tags.push("engineering");
  }

  return unique(tags);
}

function inferKeywords(content, limit = 8) {
  const tokens = tokenize(content);
  const counts = new Map();
  const docLength = tokens.length;

  // Calculate term frequencies
  for (const term of tokens) {
    if (term.length < 3) {
      continue;
    }
    counts.set(term, (counts.get(term) || 0) + 1);
  }

  // TF-IDF scoring: prefer terms that appear multiple times and are diverse
  const scored = [...counts.entries()].map(([term, count]) => {
    // Term frequency (normalized)
    const tf = count / Math.max(1, docLength);
    // Inverse frequency weight (rare terms boost score)
    const idfLike = Math.log(1 + 1 / count);
    // Entropy penalty (too common = lower)
    const frequency = count / docLength;
    const entropy = frequency * Math.log(frequency + 1);

    return {
      term,
      score: tf * idfLike * (1 - entropy * 0.1),
      count
    };
  })
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, limit)
    .map(e => e.term);

  return scored;
}

function inferEntities(content) {
  const entities = [];
  const ignoredNames = new Set([
    "A",
    "I",
    "My",
    "Our",
    "The",
    "This",
    "That",
    "We",
    "You"
  ]);

  for (const pattern of ENTITY_PATTERNS) {
    for (const match of content.matchAll(pattern.regex)) {
      entities.push({
        type: pattern.type,
        value: match[0]
      });
    }
  }

  const properNames = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) || [];

  for (const name of properNames) {
    if (!ignoredNames.has(name)) {
      entities.push({
        type: "name_or_title",
        value: name
      });
    }
  }

  return unique(entities.map((entity) => `${entity.type}:${entity.value}`))
    .slice(0, 10)
    .map((entry) => {
      const separator = entry.indexOf(":");

      return {
        type: entry.slice(0, separator),
        value: entry.slice(separator + 1)
      };
    });
}

function scoreSpecificity(content) {
  const terms = tokenize(content);
  const entities = inferEntities(content);
  let score = 0.2;

  if (terms.length >= 6) {
    score += 0.15;
  }

  if (terms.length >= 14) {
    score += 0.12;
  }

  if (entities.length > 0) {
    score += 0.18;
  }

  if (/\b\d+\b/.test(content)) {
    score += 0.12;
  }

  if (/\b(because|so that|means|requires|must|should|will|decided)\b/i.test(content)) {
    score += 0.14;
  }

  return clampScore(score);
}

function scorePermanence(content, memoryType) {
  const lower = content.toLowerCase();
  let score = memoryType === "factual" ? 0.68 : memoryType === "semantic" ? 0.54 : 0.42;

  if (countMatches(lower, ["my name is", "i am", "i'm", "we are", "i prefer", "we want", "our project"]) > 0) {
    score += 0.18;
  }

  if (countMatches(lower, ["today", "tomorrow", "yesterday", "currently", "now", "temporary"]) > 0) {
    score -= 0.14;
  }

  if (countMatches(lower, ["always", "usually", "default", "primary", "major"]) > 0) {
    score += 0.08;
  }

  return clampScore(score);
}

function scoreActionability(content) {
  const lower = content.toLowerCase();
  let score = 0.15;

  if (countMatches(lower, ["need to", "have to", "must", "should", "lets", "let's", "work on", "add", "fix", "build", "change", "improve"]) > 0) {
    score += 0.35;
  }

  if (countMatches(lower, ["next step", "todo", "deadline", "plan", "decision"]) > 0) {
    score += 0.2;
  }

  if (lower.includes("?")) {
    score -= 0.1;
  }

  return clampScore(score);
}

function inferSentiment(content) {
  const lower = content.toLowerCase();
  const positive = countMatches(lower, [
    "like",
    "prefer",
    "good",
    "great",
    "best",
    "clear",
    "improve",
    "working"
  ]);
  const negative = countMatches(lower, [
    "dislike",
    "bad",
    "issue",
    "problem",
    "bug",
    "failed",
    "wrong",
    "not working"
  ]);

  if (positive > negative) {
    return "positive";
  }

  if (negative > positive) {
    return "negative";
  }

  return "neutral";
}

function scoreSignalStrength(content, memoryType, tags) {
  const terms = tokenize(content);
  let score = 0.25;

  if (memoryType === "factual") {
    score += 0.2;
  } else if (memoryType === "episodic") {
    score += 0.14;
  } else {
    score += 0.08;
  }

  score += Math.min(0.16, terms.length * 0.01);
  score += Math.min(0.16, tags.length * 0.04);

  if (hasLowSignalContent(content)) {
    score -= 0.3;
  }

  if (/\b(maybe|perhaps|not sure|i think|probably)\b/i.test(content)) {
    score -= 0.08;
  }

  return clampScore(score);
}

export function inferMemoryDomain(content) {
  const scored = DOMAIN_RULES.map((rule) => ({
    domain: rule.domain,
    score: Math.min(1, rule.weight * countMatches(content, rule.terms))
  }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const lower = content.toLowerCase();

  if (/\b(my name is|i am|i'm|we are)\b/.test(lower)) {
    return {
      domain: "identity",
      domainConfidence: 0.95,
      alternateDomains: scored
        .filter((entry) => entry.domain !== "identity")
        .slice(0, 3)
        .map((entry) => entry.domain)
    };
  }

  if (/\b(i prefer|i like|i dislike|i want|we want)\b/.test(lower)) {
    return {
      domain: "preference",
      domainConfidence: 0.9,
      alternateDomains: scored
        .filter((entry) => entry.domain !== "preference")
        .slice(0, 3)
        .map((entry) => entry.domain)
    };
  }

  return {
    domain: best?.domain || "general",
    domainConfidence: best ? clampScore(Math.min(0.95, best.score)) : 0.35,
    alternateDomains: scored.slice(1, 4).map((entry) => entry.domain)
  };
}

export function scoreMemoryConfidence({ content, role, memoryType, tags, domainConfidence }) {
  const lower = content.toLowerCase();
  const specificity = scoreSpecificity(content);
  let score = role === "user" ? 0.58 : 0.44;

  score += specificity * 0.18;
  score += domainConfidence * 0.12;
  score += Math.min(0.08, tags.length * 0.02);

  if (memoryType === "factual") {
    score += 0.08;
  }

  // High-confidence factual indicators
  const factualIndicators = countMatches(lower, ["my name is", "i prefer", "i want", "we want", "our project"]);
  if (factualIndicators > 0) {
    score += Math.min(0.12, factualIndicators * 0.05);
  }

  if (lower.includes("?")) {
    score -= 0.16;
  }

  // Uncertainty penalties (scale with severity)
  const uncertaintyTerms = ["maybe", "perhaps", "not sure", "i think", "probably", "might"];
  const uncertaintyCount = countMatches(lower, uncertaintyTerms);
  if (uncertaintyCount > 0) {
    score -= Math.min(0.2, uncertaintyCount * 0.08);
  }

  if (role === "assistant" && !/\b(decision|plan|architecture|next step|we should)\b/i.test(lower)) {
    score -= 0.08;
  }

  return clampScore(score);
}

export function scoreMemoryImportance(content, role, memoryType, timestamp = null) {
  const tags = inferTags(content);
  const { domainConfidence } = inferMemoryDomain(content);
  const signalStrength = scoreSignalStrength(content, memoryType, tags);
  const specificity = scoreSpecificity(content);
  const permanence = scorePermanence(content, memoryType);
  const actionability = scoreActionability(content);
  const confidence = scoreMemoryConfidence({
    content,
    role,
    memoryType,
    tags,
    domainConfidence
  });

  let score =
    signalStrength * 0.28 +
    confidence * 0.2 +
    specificity * 0.16 +
    permanence * 0.16 +
    actionability * 0.12 +
    domainConfidence * 0.08;

  if (role === "user") {
    score += 0.06;
  }

  if (memoryType === "factual") {
    score += 0.08;
  }

  if (memoryType === "episodic") {
    score += 0.04;
  }

  if (
    /\b(my name is|project|capstone|goal|want|architecture|decision|must|important|major)\b/i.test(
      content
    )
  ) {
    score += 0.08;
  }

  if (content.length > 220) {
    score += 0.03;
  }

  if (content.trim().endsWith("?")) {
    score -= 0.08;
  }

  // Apply temporal decay only to episodic memories (older = less important)
  if (timestamp && memoryType === "episodic") {
    const ageMs = Date.now() - new Date(timestamp).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    // Decay: 48h → 0.8x, 7d → 0.6x, 30d → 0.3x
    const decayFactor = Math.exp(-0.015 * Math.min(ageHours, 720));
    score *= decayFactor;
  }

  return clampScore(score);
}

export function shouldStoreMemory({ role, content, memoryType }) {
  const lower = content.toLowerCase().trim();

  if (!lower || hasLowSignalContent(lower)) {
    return false;
  }

  if (
    lower.startsWith("what do you remember") ||
    lower.startsWith("do you remember") ||
    lower.startsWith("can you remember") ||
    lower.startsWith("what do you know")
  ) {
    return false;
  }

  if (role === "assistant") {
    if (
      lower.startsWith("aineura demo response:") ||
      lower.includes("currently running with a local fallback responder")
    ) {
      return false;
    }

    return (
      lower.includes("plan") ||
      lower.includes("decision") ||
      lower.includes("architecture") ||
      lower.includes("we should") ||
      lower.includes("next step")
    );
  }

  if (memoryType === "semantic") {
    return lower.length > 24;
  }

  return true;
}

export function extractMemoryCandidates(event) {
  const content = event.content.trim();

  if (!content) {
    return [];
  }

  const segments = content
    .split(/(?<=[.!?])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const baseSegments = segments.length ? segments : [content];

  return baseSegments
    .map((segment, index) => {
      const classification = classifyMemoryTypeWithConfidence(segment);
      const memoryType = classification.memoryType;
      const classificationConfidence = classification.confidence;
      const tags = inferTags(segment);
      const domainResult = inferMemoryDomain(segment);
      const confidence = scoreMemoryConfidence({
        content: segment,
        role: event.role,
        memoryType,
        tags,
        domainConfidence: domainResult.domainConfidence
      });

      return {
        memoryType,
        content: segment,
        summary: summarizeMemoryCandidate(segment),
        metadata: {
          importance: scoreMemoryImportance(segment, event.role, memoryType, event.createdAt),
          confidence,
          timestamp: event.createdAt,
          domain: domainResult.domain,
          domainConfidence: domainResult.domainConfidence,
          alternateDomains: domainResult.alternateDomains,
          tags,
          role: event.role,
          schemaVersion: 3,
          generatedBy: "heuristic-metadata-v3",
          extractionMethod: "enhanced-pattern-scoring-analysis",
          source: {
            eventId: event.id,
            sessionId: event.sessionId,
            segmentIndex: index
          },
          signalStrength: scoreSignalStrength(segment, memoryType, tags),
          specificity: scoreSpecificity(segment),
          permanence: scorePermanence(segment, memoryType),
          actionability: scoreActionability(segment),
          sentiment: inferSentiment(segment),
          keywords: inferKeywords(segment),
          entities: inferEntities(segment),
          // NEW: Classification details
          classificationConfidence,
          alternativeClassifications: classification.alternatives,
          classificationDebug: classification.debug
        }
      };
    })
    .filter((candidate) =>
      shouldStoreMemory({
        role: event.role,
        content: candidate.content,
        memoryType: candidate.memoryType
      })
    );
}

export function computeMemoryFingerprint(content) {
  return tokenize(content)
    .sort()
    .join(" ");
}

export function scoreQueryOverlap(query, content) {
  const queryTerms = tokenize(query);
  const contentTerms = new Set(tokenize(content));

  return queryTerms.reduce((score, term) => score + (contentTerms.has(term) ? 1 : 0), 0);
}

export function buildContextPrompt({ userMessage, activeMemories, recentContext }) {
  const memoryBlock = activeMemories.length
    ? activeMemories
        .map(
          (memory, index) =>
            `${index + 1}. [${memory.memoryType}] ${memory.summary}`
        )
        .join("\n")
    : "None";

  const recentBlock = recentContext.length
    ? recentContext
        .map((entry) => `${entry.role}: ${entry.content}`)
        .join("\n")
    : "None";

  return [
    `You are AiNeura, an intelligent assistant with persistent memory across all conversations.

CRITICAL RULES:
- The memories below are things you already know about the user from past conversations. Treat them as background knowledge — like a friend who remembers things about you.
- NEVER repeat or recite memory content unprompted. Only use it when it is directly relevant to what the user just said.
- If the user says "hi" or "hello", respond naturally and conversationally. Do NOT introduce yourself using their name or dump memory facts at them.
- Only mention something from memory if the user asks about it, or if it genuinely helps answer their current message.
- Never say "Based on my memories..." or "I remember that...". Just respond naturally, the way a knowledgeable friend would.
- Be warm, concise, and helpful.`,
    `What you know about this user (use as silent background context only):\n${memoryBlock}`,
    `Recent conversation:\n${recentBlock}`,
    `User: ${userMessage}`
  ].join("\n\n");
}

// NEW: Compute semantic relationship strength between two memory contents
export function computeMemoryRelatedness(content1, content2) {
  const tokens1 = new Set(tokenize(content1));
  const tokens2 = new Set(tokenize(content2));

  // Jaccard similarity
  const intersection = [...tokens1].filter(t => tokens2.has(t)).length;
  const union = new Set([...tokens1, ...tokens2]).size;
  const jaccardScore = union > 0 ? intersection / union : 0;

  // Entity overlap
  const entities1 = inferEntities(content1).map(e => e.value.toLowerCase());
  const entities2 = inferEntities(content2).map(e => e.value.toLowerCase());
  const entityOverlap = entities1.filter(e => entities2.includes(e)).length;
  const entityScore = Math.min(1, (entityOverlap + 0.5) / Math.max(entities1.length, entities2.length, 1));

  // Domain alignment
  const domain1 = inferMemoryDomain(content1);
  const domain2 = inferMemoryDomain(content2);
  const domainScore = domain1.domain === domain2.domain ? 1 : 0;

  // Weighted combination
  return jaccardScore * 0.5 + entityScore * 0.3 + domainScore * 0.2;
}
