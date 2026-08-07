"use client";

import { useEffect, useRef, useState } from "react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

// Pipeline stages in order
const STAGES = [
  {
    id: "user",
    label: "Your Message",
    sub: "Input",
    icon: "💬",
    color: "#007aff",
    desc: "You send a message. The API receives it and stores a raw event in MongoDB immediately."
  },
  {
    id: "raw",
    label: "Raw Event",
    sub: "MongoDB",
    icon: "🗄️",
    color: "#ff9500",
    desc: "Every turn is persisted as a raw event — the permanent, immutable record of what was said."
  },
  {
    id: "queue",
    label: "Memory Queue",
    sub: "Redis",
    icon: "📥",
    color: "#5856d6",
    desc: "The event is enqueued in Redis for async processing. The chat reply is not blocked by this."
  },
  {
    id: "retrieval",
    label: "Memory Retrieval",
    sub: "Qdrant · Postgres",
    icon: "🔍",
    color: "#30b0c7",
    desc: "The system searches Qdrant for semantically similar memories and Postgres for factual matches."
  },
  {
    id: "working",
    label: "Working Memory",
    sub: "Redis",
    icon: "⚡",
    color: "#34c759",
    desc: "Relevant memories are assembled into working memory in Redis — the conscious layer reads only this."
  },
  {
    id: "response",
    label: "Response",
    sub: "LLM",
    icon: "🧠",
    color: "#af52de",
    desc: "The model generates a reply grounded in working memory. No raw history — only what was surfaced."
  }
];

// Idle = nothing happening, each stage name = that stage is active, "done" = finished

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readChatSessionId() {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("neura-session-id") || "";
}

function importanceColor(score) {
  if (score >= 0.75) return "#007aff";
  if (score >= 0.45) return "#30b0c7";
  return "#aeaeb2";
}

function memTypeColor(type) {
  if (type === "factual")  return { bg: "#e8f9ec", text: "#1a7f37" };
  if (type === "semantic") return { bg: "#eeeeff", text: "#5856d6" };
  return { bg: "#fff4e5", text: "#b45309" };
}

// ── Pipeline Stage Component ──────────────────────────────────────────────────

function PipelineStage({ stage, status }) {
  // status: "idle" | "active" | "done"
  const isActive = status === "active";
  const isDone   = status === "done";

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "6px",
      flex: 1,
      minWidth: 0,
      position: "relative"
    }}>
      {/* Circle */}
      <div style={{
        width: "52px",
        height: "52px",
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "20px",
        background: isDone
          ? stage.color
          : isActive
            ? `${stage.color}22`
            : "var(--surface-3, #f2f2f7)",
        border: `2px solid ${isDone || isActive ? stage.color : "var(--separator-opaque, #c6c6c8)"}`,
        boxShadow: isActive ? `0 0 0 4px ${stage.color}22` : "none",
        transition: "all 300ms cubic-bezier(0.34,1.56,0.64,1)",
        transform: isActive ? "scale(1.12)" : "scale(1)"
      }}>
        {isDone ? "✓" : stage.icon}
      </div>

      {/* Label */}
      <div style={{ textAlign: "center" }}>
        <div style={{
          fontSize: "11px",
          fontWeight: 600,
          color: isDone || isActive ? stage.color : "var(--text-tertiary, #6c6c70)",
          transition: "color 300ms"
        }}>
          {stage.label}
        </div>
        <div style={{
          fontSize: "10px",
          color: "var(--text-quaternary, #aeaeb2)",
          marginTop: "1px"
        }}>
          {stage.sub}
        </div>
      </div>

      {/* Active pulse ring */}
      {isActive && (
        <div style={{
          position: "absolute",
          top: "0",
          left: "50%",
          transform: "translateX(-50%)",
          width: "52px",
          height: "52px",
          borderRadius: "50%",
          border: `2px solid ${stage.color}`,
          animation: "pulseRing 1s ease-out infinite",
          pointerEvents: "none"
        }} />
      )}
    </div>
  );
}

// ── Memory Card ───────────────────────────────────────────────────────────────

function MemoryCard({ memory, isNew }) {
  const score = memory.metadata?.importance ?? 0;
  const type  = memory.memoryType || "episodic";
  const colors = memTypeColor(type);

  return (
    <div style={{
      background: "var(--surface, #fff)",
      border: "1px solid var(--separator, rgba(60,60,67,0.12))",
      borderRadius: "12px",
      padding: "12px 14px",
      animation: isNew ? "slideIn 400ms cubic-bezier(0.34,1.56,0.64,1)" : "none",
      boxShadow: isNew ? "0 4px 16px rgba(0,122,255,0.10)" : "var(--shadow-xs, 0 1px 3px rgba(0,0,0,0.06))"
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
        <span style={{
          fontSize: "10px", fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.06em", padding: "2px 7px", borderRadius: "20px",
          background: colors.bg, color: colors.text
        }}>
          {type}
        </span>
        <span style={{
          marginLeft: "auto", fontSize: "11px",
          color: importanceColor(score), fontWeight: 600
        }}>
          {score.toFixed ? score.toFixed(2) : "—"}
        </span>
      </div>

      <div style={{ fontSize: "13px", color: "var(--text-primary, #1c1c1e)", lineHeight: 1.5, marginBottom: "8px" }}>
        {memory.summary}
      </div>

      {/* Importance bar */}
      <div style={{ height: "3px", background: "var(--separator, rgba(60,60,67,0.12))", borderRadius: "2px" }}>
        <div style={{
          height: "100%", borderRadius: "2px",
          width: `${Math.min((score || 0) * 100, 100)}%`,
          background: importanceColor(score),
          transition: "width 600ms ease"
        }} />
      </div>

      {memory.metadata?.domain && (
        <div style={{ marginTop: "6px", fontSize: "11px", color: "var(--text-quaternary, #aeaeb2)" }}>
          {memory.metadata.domain}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function RedisMemoryFlowPage() {
  const [sessionId,    setSessionId]    = useState("");
  const [draft,        setDraft]        = useState("");
  const [activeStage,  setActiveStage]  = useState("idle");   // idle | stage id | done
  const [doneStages,   setDoneStages]   = useState([]);
  const [stageDesc,    setStageDesc]    = useState("");
  const [memories,     setMemories]     = useState([]);
  const [newMemoryIds, setNewMemoryIds] = useState(new Set());
  const [recentTurns,  setRecentTurns]  = useState([]);
  const [isSending,    setIsSending]    = useState(false);
  const [lastReply,    setLastReply]    = useState("");
  const [cacheResult,  setCacheResult]  = useState(null); // null | "hit" | "miss"
  const [cacheStats,   setCacheStats]   = useState({ hits: 0, misses: 0 });
  const [error,        setError]        = useState("");
  const stageTimerRef = useRef(null);

  // Sync session from chat page on mount
  useEffect(() => {
    const sid = readChatSessionId();
    setSessionId(sid || "demo-session");
  }, []);

  // Load existing context when session is known
  useEffect(() => {
    if (!sessionId) return;
    loadContext(sessionId);
  }, [sessionId]);

  async function loadContext(sid) {
    try {
      const res = await fetch(`${apiBaseUrl}/api/redis/context?sessionId=${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json();
      const mems = data?.workingMemory?.activeMemories || [];
      setMemories(mems);
      setRecentTurns(data?.recentTurns || []);
    } catch {
      // silent — page still works without existing context
    }
  }

  // Advance to a specific stage and mark all prior stages done
  function goToStage(stageId) {
    const idx = STAGES.findIndex((s) => s.id === stageId);
    if (idx === -1) return;
    setActiveStage(stageId);
    setDoneStages(STAGES.slice(0, idx).map((s) => s.id));
    setStageDesc(STAGES[idx].desc);
  }

  function markAllDone() {
    setActiveStage("done");
    setDoneStages(STAGES.map((s) => s.id));
    setStageDesc("Pipeline complete — working memory is ready for the next message.");
  }

  async function sendMessage(e) {
    e?.preventDefault();
    if (!draft.trim() || isSending) return;

    const message = draft.trim();
    setDraft("");
    setIsSending(true);
    setError("");
    setLastReply("");

    // ── Stages 1–3 happen at the very start of the API call (lock, raw event, enqueue).
    // We advance through them quickly to reflect that reality.
    setDoneStages([]);
    goToStage("user");
    await new Promise((r) => { stageTimerRef.current = setTimeout(r, 300); });
    goToStage("raw");
    await new Promise((r) => { stageTimerRef.current = setTimeout(r, 350); });
    goToStage("queue");

    // ── Stage 4 (retrieval) — we pause here while the real API request runs.
    // The request does the actual Qdrant + Postgres query at this point.
    await new Promise((r) => { stageTimerRef.current = setTimeout(r, 300); });
    goToStage("retrieval");

    let payload;
    try {
      const res = await fetch(`${apiBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message })
      });
      payload = await res.json();
      if (!res.ok) throw new Error(payload.details || payload.error || "Chat failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setActiveStage("idle");
      setDoneStages([]);
      setIsSending(false);
      return;
    }

    // ── Stage 5 (working memory) — response is back, working memory was assembled.
    // If retrieval was a cache hit it was fast; if miss it queried the stores.
    const cacheHit = payload.workingMemory?.retrievalCache?.hit === true;
    setCacheResult(cacheHit ? "hit" : "miss");
    setCacheStats((prev) => ({
      hits:   prev.hits   + (cacheHit ? 1 : 0),
      misses: prev.misses + (cacheHit ? 0 : 1)
    }));
    goToStage("working");
    setStageDesc(
      cacheHit
        ? "✅ Redis cache HIT — retrieval result was already cached. Qdrant and Postgres were skipped entirely."
        : (() => {
            const found = payload.workingMemory?.activeMemories?.length ?? 0;
            const carried = payload.workingMemory?.retrievalCache?.carriedForward ?? 0;
            const fresh = Math.max(0, found - carried);
            if (carried > 0 && fresh > 0)
              return `❌ Cache MISS — queried Qdrant + Postgres, found ${fresh} new memories. Also carried ${carried} memories forward from Redis working memory.`;
            if (carried > 0)
              return `❌ Cache MISS — no new memories from stores, but ${carried} memories carried forward from Redis working memory.`;
            return `❌ Cache MISS — queried Qdrant + Postgres in parallel, found ${found} memories. Result cached in Redis.`;
          })()
    );
    await new Promise((r) => { stageTimerRef.current = setTimeout(r, cacheHit ? 250 : 400); });

    // ── Stage 6 (response) — LLM generated the reply from working memory only.
    goToStage("response");
    setLastReply(payload.reply || "");
    await new Promise((r) => { stageTimerRef.current = setTimeout(r, 300); });

    markAllDone();

    // Update working memory and turns from the response payload directly
    const freshMems = payload.workingMemory?.activeMemories || [];
    const existingIds = new Set(memories.map((m) => m.id || m.fingerprint));
    const newIds = new Set(
      freshMems.map((m) => m.id || m.fingerprint).filter((id) => !existingIds.has(id))
    );
    setNewMemoryIds(newIds);
    setMemories(freshMems);
    setTimeout(() => setNewMemoryIds(new Set()), 2000);

    // Also refresh turns from Redis context
    try {
      const ctxRes = await fetch(`${apiBaseUrl}/api/redis/context?sessionId=${encodeURIComponent(sessionId)}`);
      if (ctxRes.ok) {
        const ctx = await ctxRes.json();
        setRecentTurns(ctx?.recentTurns || []);
      }
    } catch { /* non-critical */ }

    setIsSending(false);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg, #f2f2f7)", fontFamily: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif" }}>

      {/* Keyframe styles */}
      <style>{`
        @keyframes pulseRing {
          0%   { transform: translateX(-50%) scale(1); opacity: 0.7; }
          100% { transform: translateX(-50%) scale(1.7); opacity: 0; }
        }
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(12px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* Header */}
      <header style={{
        height: "56px", background: "rgba(255,255,255,0.85)",
        backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(60,60,67,0.12)",
        display: "flex", alignItems: "center", padding: "0 24px",
        position: "sticky", top: 0, zIndex: 100,
        justifyContent: "space-between"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "18px" }}>⚡</span>
          <span style={{ fontWeight: 700, fontSize: "15px", color: "var(--text-primary, #1c1c1e)" }}>AiNeura</span>
          <span style={{ fontSize: "13px", color: "var(--text-quaternary, #aeaeb2)", marginLeft: "4px" }}>/ Memory Flow</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "12px", color: "var(--text-quaternary, #aeaeb2)" }}>
            Session: <strong style={{ color: "var(--text-tertiary, #6c6c70)", fontFamily: "monospace" }}>
              {sessionId ? sessionId.slice(0, 8) + "…" : "—"}
            </strong>
          </span>
          <button
            onClick={() => { const sid = readChatSessionId(); if (sid) setSessionId(sid); }}
            style={{
              fontSize: "11px", padding: "4px 10px", borderRadius: "8px",
              border: "1px solid rgba(60,60,67,0.2)", background: "white",
              color: "var(--text-secondary, #3c3c43)", cursor: "pointer"
            }}
          >
            Sync Chat Session
          </button>
        </div>
      </header>

      <div style={{ maxWidth: "900px", margin: "0 auto", padding: "28px 20px" }}>

        {/* Page title */}
        <div style={{ marginBottom: "28px" }}>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary, #1c1c1e)", margin: "0 0 6px" }}>
            How memory works
          </h1>
          <p style={{ fontSize: "14px", color: "var(--text-tertiary, #6c6c70)", margin: 0, lineHeight: 1.6 }}>
            Send a message below and watch it travel through every layer of the cognitive pipeline — from raw event to working memory.
          </p>
        </div>

        {/* ── Pipeline ── */}
        <div style={{
          background: "white", borderRadius: "16px",
          border: "1px solid rgba(60,60,67,0.12)",
          padding: "24px 20px 20px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
          marginBottom: "20px"
        }}>
          {/* Stage row */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: "4px", marginBottom: "16px" }}>
            {STAGES.map((stage, i) => {
              const status =
                activeStage === stage.id ? "active" :
                doneStages.includes(stage.id) ? "done" : "idle";
              return (
                <div key={stage.id} style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0 }}>
                  <PipelineStage stage={stage} status={status} />
                  {i < STAGES.length - 1 && (
                    <div style={{
                      height: "2px", flex: "0 0 16px",
                      background: doneStages.includes(STAGES[i + 1]?.id) || activeStage === STAGES[i + 1]?.id
                        ? STAGES[i].color
                        : "var(--separator-opaque, #c6c6c8)",
                      borderRadius: "1px",
                      transition: "background 300ms",
                      marginBottom: "28px"
                    }} />
                  )}
                </div>
              );
            })}
          </div>

          {/* Stage description */}
          <div style={{
            minHeight: "36px", padding: "10px 14px",
            background: "var(--bg, #f2f2f7)", borderRadius: "10px",
            fontSize: "13px", color: "var(--text-secondary, #3c3c43)",
            lineHeight: 1.55, transition: "opacity 200ms"
          }}>
            {stageDesc || "Send a message to watch the pipeline run."}
          </div>
        </div>

        {/* ── Input box ── */}
        <div style={{
          background: "white", borderRadius: "16px",
          border: "1px solid rgba(60,60,67,0.12)",
          padding: "16px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
          marginBottom: "20px"
        }}>
          {error && (
            <div style={{
              padding: "10px 12px", background: "#fff0f0",
              border: "1px solid #ffc5c5", borderRadius: "8px",
              fontSize: "13px", color: "#c0392b", marginBottom: "12px"
            }}>
              {error}
            </div>
          )}

          <form onSubmit={sendMessage} style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(e); } }}
              placeholder="Type something like: My name is Vinod and I love building AI systems…"
              disabled={isSending}
              rows={2}
              style={{
                flex: 1, resize: "none", padding: "10px 12px",
                borderRadius: "10px", border: "1px solid rgba(60,60,67,0.2)",
                fontSize: "14px", fontFamily: "inherit",
                background: isSending ? "var(--bg, #f2f2f7)" : "white",
                color: "var(--text-primary, #1c1c1e)",
                outline: "none"
              }}
            />
            <button
              type="submit"
              disabled={isSending || !draft.trim()}
              style={{
                padding: "10px 20px", borderRadius: "10px",
                background: isSending || !draft.trim() ? "var(--separator-opaque, #c6c6c8)" : "#007aff",
                color: "white", border: "none", fontWeight: 600,
                fontSize: "14px", cursor: isSending || !draft.trim() ? "default" : "pointer",
                transition: "background 200ms", whiteSpace: "nowrap"
              }}
            >
              {isSending ? (
                <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ width: "12px", height: "12px", border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "white", borderRadius: "50%", display: "inline-block", animation: "spin 0.7s linear infinite" }} />
                  Running…
                </span>
              ) : "Send →"}
            </button>
          </form>

          {/* Last reply */}
          {lastReply && (
            <div style={{
              marginTop: "12px", padding: "12px 14px",
              background: "var(--bg, #f2f2f7)", borderRadius: "10px",
              fontSize: "13px", color: "var(--text-secondary, #3c3c43)", lineHeight: 1.6
            }}>
              <div style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-quaternary, #aeaeb2)", marginBottom: "4px" }}>
                AiNeura replied
              </div>
              {lastReply}
            </div>
          )}
        </div>

        {/* ── Two columns: Memories + Recent Turns ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>

          {/* Working memory */}
          <div style={{
            background: "white", borderRadius: "16px",
            border: "1px solid rgba(60,60,67,0.12)",
            padding: "16px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.06)"
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: "14px", color: "var(--text-primary, #1c1c1e)" }}>Working Memory</div>
                <div style={{ fontSize: "11px", color: "var(--text-quaternary, #aeaeb2)", marginTop: "1px" }}>What the model sees right now</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                {cacheResult && (
                  <span style={{
                    fontSize: "11px", fontWeight: 700, padding: "3px 8px",
                    borderRadius: "20px",
                    background: cacheResult === "hit" ? "#e8f9ec" : "#fff4e5",
                    color:      cacheResult === "hit" ? "#1a7f37"  : "#b45309"
                  }}>
                    {cacheResult === "hit" ? "⚡ Redis HIT" : "🔍 Cache MISS"}
                  </span>
                )}
                {(cacheStats.hits > 0 || cacheStats.misses > 0) && (
                  <span style={{ display: "flex", gap: "4px" }}>
                    <span style={{
                      fontSize: "11px", fontWeight: 700, padding: "3px 8px",
                      borderRadius: "20px", background: "#e8f9ec", color: "#1a7f37"
                    }}>
                      {cacheStats.hits} hit{cacheStats.hits !== 1 ? "s" : ""}
                    </span>
                    <span style={{
                      fontSize: "11px", fontWeight: 700, padding: "3px 8px",
                      borderRadius: "20px", background: "#fff4e5", color: "#b45309"
                    }}>
                      {cacheStats.misses} miss{cacheStats.misses !== 1 ? "es" : ""}
                    </span>
                  </span>
                )}
                <span style={{
                  fontSize: "12px", fontWeight: 700, padding: "2px 9px",
                  borderRadius: "20px", background: memories.length ? "#e8f1ff" : "var(--bg, #f2f2f7)",
                  color: memories.length ? "#007aff" : "var(--text-quaternary, #aeaeb2)"
                }}>
                  {memories.length}
                </span>
              </div>
            </div>

            {memories.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {memories.map((mem) => (
                  <MemoryCard
                    key={mem.id || mem.fingerprint}
                    memory={mem}
                    isNew={newMemoryIds.has(mem.id || mem.fingerprint)}
                  />
                ))}
              </div>
            ) : (
              <div style={{
                padding: "32px 16px", textAlign: "center",
                color: "var(--text-quaternary, #aeaeb2)", fontSize: "13px"
              }}>
                <div style={{ fontSize: "28px", marginBottom: "8px" }}>🧠</div>
                <div>No memories surfaced yet.</div>
                <div style={{ fontSize: "11px", marginTop: "4px" }}>Send a message to populate working memory.</div>
              </div>
            )}
          </div>

          {/* Recent turns */}
          <div style={{
            background: "white", borderRadius: "16px",
            border: "1px solid rgba(60,60,67,0.12)",
            padding: "16px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.06)"
          }}>
            <div style={{ marginBottom: "14px" }}>
              <div style={{ fontWeight: 700, fontSize: "14px", color: "var(--text-primary, #1c1c1e)" }}>Recent Turns</div>
              <div style={{ fontSize: "11px", color: "var(--text-quaternary, #aeaeb2)", marginTop: "1px" }}>Last messages stored in Redis</div>
            </div>

            {recentTurns.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {recentTurns.slice(-8).map((turn, i) => (
                  <div key={turn.id || i} style={{
                    display: "flex", gap: "8px", alignItems: "flex-start",
                    padding: "8px 10px", borderRadius: "8px",
                    background: turn.role === "user" ? "var(--bg, #f2f2f7)" : "#f0f7ff"
                  }}>
                    <span style={{
                      fontSize: "10px", fontWeight: 700, textTransform: "uppercase",
                      letterSpacing: "0.06em", minWidth: "32px",
                      color: turn.role === "user" ? "var(--text-tertiary, #6c6c70)" : "#007aff"
                    }}>
                      {turn.role === "user" ? "You" : "AI"}
                    </span>
                    <span style={{
                      fontSize: "12px", color: "var(--text-secondary, #3c3c43)",
                      lineHeight: 1.5, flex: 1,
                      overflow: "hidden", display: "-webkit-box",
                      WebkitLineClamp: 2, WebkitBoxOrient: "vertical"
                    }}>
                      {typeof turn.content === "string"
                        ? turn.content.slice(0, 140) + (turn.content.length > 140 ? "…" : "")
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{
                padding: "32px 16px", textAlign: "center",
                color: "var(--text-quaternary, #aeaeb2)", fontSize: "13px"
              }}>
                <div style={{ fontSize: "28px", marginBottom: "8px" }}>💬</div>
                <div>No turns yet.</div>
                <div style={{ fontSize: "11px", marginTop: "4px" }}>Turns appear here after your first message.</div>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
