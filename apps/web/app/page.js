"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

const statusLabels = {
  ok: "Cloud Memory Online",
  degraded: "Partial Outage",
  "local-fallback": "Local Fallback"
};

const statusToneByKey = {
  ok: "ok",
  degraded: "warn",
  "local-fallback": "warn"
};

function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getOrCreateSessionId() {
  if (typeof window === "undefined") {
    return createId();
  }

  const stored = localStorage.getItem("neura-session-id");
  if (stored) {
    return stored;
  }

  const newSessionId = createId();
  localStorage.setItem("neura-session-id", newSessionId);
  return newSessionId;
}

function getOrCreateMessages() {
  if (typeof window === "undefined") {
    return [
      {
        id: "welcome",
        role: "assistant",
        content:
          "I am AiNeura in demo mode. Ask me something, tell me a fact to remember, or reference something from earlier in the conversation."
      }
    ];
  }

  const sessionId = getOrCreateSessionId();
  const stored = localStorage.getItem(`neura-messages-${sessionId}`);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      return [
        {
          id: "welcome",
          role: "assistant",
          content:
            "I am AiNeura in demo mode. Ask me something, tell me a fact to remember, or reference something from earlier in the conversation."
        }
      ];
    }
  }

  return [
    {
      id: "welcome",
      role: "assistant",
      content:
        "I am AiNeura in demo mode. Ask me something, tell me a fact to remember, or reference something from earlier in the conversation."
    }
  ];
}

function getOrCreateWorkingMemory() {
  if (typeof window === "undefined") {
    return { activeMemories: [], recentContext: [] };
  }

  const sessionId = getOrCreateSessionId();
  const stored = localStorage.getItem(`neura-working-memory-${sessionId}`);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      return { activeMemories: [], recentContext: [] };
    }
  }

  return { activeMemories: [], recentContext: [] };
}

export default function HomePage() {
  const messagesEndRef = useRef(null);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState([
    {
      id: "welcome",
      role: "assistant",
      content:
        "I am AiNeura in demo mode. Ask me something, tell me a fact to remember, or reference something from earlier in the conversation."
    }
  ]);
  const [draft, setDraft] = useState("");
  const [memoryState, setMemoryState] = useState({
    activeMemories: [],
    recentContext: []
  });
  const [storageHealth, setStorageHealth] = useState(null);
  const [healthError, setHealthError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [showStatus, setShowStatus] = useState(true);
  const [showMemory, setShowMemory] = useState(true);

  async function refreshStorageHealth() {
    try {
      const response = await fetch(`${apiBaseUrl}/health/storage`);
      const payload = await response.json();

      setStorageHealth(payload);
      setHealthError("");
    } catch (error) {
      setHealthError("API status unavailable");
    }
  }

  async function fetchWorkingMemorySnapshot(nextSessionId) {
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/redis/context?sessionId=${encodeURIComponent(nextSessionId)}`
      );
      const payload = await response.json();

      if (!response.ok) {
        return null;
      }

      return payload.workingMemory || null;
    } catch {
      return null;
    }
  }

  // Initialize client-side state after hydration
  useEffect(() => {
    const newSessionId = getOrCreateSessionId();
    setSessionId(newSessionId);
    setMessages(getOrCreateMessages());
    setMemoryState(getOrCreateWorkingMemory());
    setIsHydrated(true);
    refreshStorageHealth();
  }, []);

  useEffect(() => {
    localStorage.setItem(`neura-messages-${sessionId}`, JSON.stringify(messages));
  }, [messages, sessionId]);

  // Persist working memory to localStorage so it syncs across tabs
  useEffect(() => {
    if (sessionId) {
      localStorage.setItem(`neura-working-memory-${sessionId}`, JSON.stringify(memoryState));
    }
  }, [memoryState, sessionId]);

  // Listen for storage changes from other tabs
  useEffect(() => {
    const sessionId = getOrCreateSessionId();

    function handleStorageChange(event) {
      if (event.key === `neura-working-memory-${sessionId}` && event.newValue) {
        try {
          const newMemoryState = JSON.parse(event.newValue);
          setMemoryState(newMemoryState);
        } catch {
          // Ignore parse errors
        }
      }
      if (event.key === `neura-messages-${sessionId}` && event.newValue) {
        try {
          const newMessages = JSON.parse(event.newValue);
          setMessages(newMessages);
        } catch {
          // Ignore parse errors
        }
      }
    }

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSending]);

  async function sendMessage(event) {
    event.preventDefault();

    if (!draft.trim()) {
      return;
    }

    const nextUserMessage = {
      id: createId(),
      role: "user",
      content: draft.trim()
    };

    setMessages((current) => [...current, nextUserMessage]);
    setDraft("");
    setIsSending(true);

    try {
      const response = await fetch(`${apiBaseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sessionId,
          message: nextUserMessage.content
        })
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.details || payload.error || "Chat request failed");
      }

      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "assistant",
          content: payload.reply || "No response received."
        }
      ]);
      const fallbackWorkingMemory = await fetchWorkingMemorySnapshot(sessionId);
      setMemoryState(
        payload.workingMemory ||
          fallbackWorkingMemory || { activeMemories: [], recentContext: [] }
      );
      refreshStorageHealth();
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "assistant",
          content:
            error instanceof Error
              ? `The chat pipeline hit an issue: ${error.message}`
              : "The API is not reachable yet. Start the backend service to enable the chat pipeline."
        }
      ]);
    } finally {
      setIsSending(false);
    }
  }

  // Derive the status tone for the header pill
  const healthTone = healthError
    ? "warn"
    : statusToneByKey[storageHealth?.status] || "pending";
  const healthLabel = healthError
    ? "API Unavailable"
    : statusLabels[storageHealth?.status] || "Checking...";

  // Map memoryType string to CSS modifier class
  function memTypeCls(memoryType) {
    if (memoryType === "factual") return "factual";
    if (memoryType === "semantic") return "semantic";
    return "episodic";
  }

  return (
    <div className="shell">
      {/* ── Top navigation bar ── */}
      <header className="top-nav">
        <div className="nav-brand">
          <span className="nav-logo">⚡</span>
          <span className="nav-name">AiNeura</span>
        </div>

        <nav className="nav-tabs">
          <Link href="/" className="nav-tab active">Chat</Link>
          <Link href="/redis" className="nav-tab">Memory Flow</Link>
          <Link href="/metadata" className="nav-tab">Metadata Lab</Link>
        </nav>

        {/* Storage health status pill */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--text-secondary)" }}>
            <span className={`dot dot-${healthTone}`} />
            {healthLabel}
          </span>
        </div>
      </header>

      {/* ── Three-column layout ── */}
      <div className="page-3col">

        {/* ── Left sidebar: System Status ── */}
        <aside className="col-left">
          <div className="panel">
            <div className="panel-title">System Status</div>

            {["mongo", "postgres", "qdrant", "redis", "neo4j"].map((service) => {
              const state = storageHealth?.storage?.[service];
              const isOk = state?.ok;
              return (
                <div className="service-row" key={service}>
                  <span className={`dot ${isOk ? "dot-ok" : "dot-pending"}`} />
                  <span style={{ flex: 1, textTransform: "capitalize", fontSize: "13px", color: "var(--text-secondary)" }}>
                    {service}
                  </span>
                  <span style={{ fontSize: "11px", color: isOk ? "var(--status-ok)" : "var(--text-muted)" }}>
                    {isOk ? "ok" : "—"}
                  </span>
                </div>
              );
            })}

            {healthError && (
              <p style={{ margin: "8px 0 4px", fontSize: "12px", color: "var(--status-warn)" }}>
                {healthError}
              </p>
            )}

            <button
              type="button"
              className="ghost-btn"
              onClick={refreshStorageHealth}
              style={{ marginTop: "12px", width: "100%" }}
            >
              Refresh
            </button>
          </div>
        </aside>

        {/* ── Centre column: Chat ── */}
        <section className="col-main" style={{ display: "flex", flexDirection: "column" }}>
          {/* Scrollable message feed */}
          <div className="chat-scroll">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`msg ${message.role === "user" ? "msg-user" : "msg-assistant"}`}
              >
                <div className="msg-role">
                  {message.role === "user" ? "You" : "AiNeura"}
                </div>
                <div className="msg-content">{message.content}</div>
              </div>
            ))}

            {/* Typing indicator while waiting for reply */}
            {isSending && (
              <div className="typing-dots">
                <span />
                <span />
                <span />
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Message composer */}
          <div className="composer-bar">
            <textarea
              className="composer-textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage(e);
                }
              }}
              placeholder="Ask me something… (Shift+Enter for new line)"
              disabled={isSending}
              rows={3}
            />
            <button
              type="button"
              className="composer-send"
              onClick={sendMessage}
              disabled={isSending || !draft.trim()}
            >
              {isSending ? "Sending…" : "Send"}
            </button>
          </div>

          {/* Session footer */}
          {isHydrated && (
            <div style={{ padding: "8px 16px", display: "flex", gap: "12px", alignItems: "center" }}>
              <small style={{ color: "var(--text-muted)" }}>
                Session: {sessionId.slice(0, 8)}…
              </small>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  const newSessionId = createId();
                  localStorage.removeItem(`neura-messages-${sessionId}`);
                  localStorage.removeItem(`neura-working-memory-${sessionId}`);
                  localStorage.setItem("neura-session-id", newSessionId);
                  setSessionId(newSessionId);
                  setMessages([
                    {
                      id: "welcome",
                      role: "assistant",
                      content:
                        "I am AiNeura in demo mode. Ask me something, tell me a fact to remember, or reference something from earlier in the conversation."
                    }
                  ]);
                  setMemoryState({ activeMemories: [], recentContext: [] });
                }}
              >
                New Session
              </button>
            </div>
          )}
        </section>

        {/* ── Right sidebar: Working Memory + Recent Context ── */}
        <aside className="col-right">
          {/* Working Memory panel */}
          <div className="panel">
            <div className="panel-title">
              Working Memory{" "}
              <span className="panel-badge">{memoryState.activeMemories.length}</span>
            </div>

            <div className="mem-list">
              {memoryState.activeMemories.length ? (
                memoryState.activeMemories.map((memory) => (
                  <div className="mem-card" key={memory.id}>
                    <span className={`mem-type-badge ${memTypeCls(memory.memoryType)}`}>
                      {memory.memoryType || "episodic"}
                    </span>
                    <div className="mem-summary">{memory.summary}</div>
                    {memory.score != null && (
                      <div className="mem-meta">score: {memory.score.toFixed(3)}</div>
                    )}
                  </div>
                ))
              ) : (
                <p className="empty-state">No active memories</p>
              )}
            </div>
          </div>

          {/* Recent Context panel */}
          <div className="panel" style={{ marginTop: "12px" }}>
            <div className="panel-title">Recent Context</div>

            {memoryState.recentContext && memoryState.recentContext.length ? (
              <div className="turn-list">
                {memoryState.recentContext.map((turn, idx) => (
                  <div className="turn-item" key={turn.id || idx}>
                    <span className="turn-role">
                      {turn.role === "user" ? "You" : "AI"}
                    </span>
                    <span className="turn-content">
                      {typeof turn.content === "string"
                        ? turn.content.slice(0, 120) + (turn.content.length > 120 ? "…" : "")
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-state">No recent context</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
