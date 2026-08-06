"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatDate(value) {
  if (!value) {
    return "n/a";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function Metric({ label, value }) {
  return (
    <div className="metric-box">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export default function RedisContextPage() {
  const [sessionId, setSessionId] = useState("");
  const [draft, setDraft] = useState("");
  const [context, setContext] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [cleanupInProgress, setCleanupInProgress] = useState(false);

  const workingMemory = context?.workingMemory || {
    activeMemories: [],
    recentContext: []
  };
  const recentTurns = context?.recentTurns || [];
  const queue = context?.memoryQueue || [];
  const stateEntries = useMemo(
    () => Object.entries(context?.sessionState || {}),
    [context]
  );

  function readChatSessionId() {
    if (typeof window === "undefined") {
      return "";
    }

    return localStorage.getItem("neura-session-id") || "";
  }

  async function refreshContext() {
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/redis/context?sessionId=${encodeURIComponent(sessionId)}`
      );
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.details || payload.error || "Redis context failed");
      }

      setContext(payload);
      setError("");
    } catch (contextError) {
      setError(
        contextError instanceof Error
          ? contextError.message
          : "Redis context is unavailable."
      );
    }
  }

  async function refreshSessions() {
    setIsLoadingSessions(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/redis/sessions`);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.details || payload.error || "Sessions fetch failed");
      }

      setSessions(payload.sessions || []);
    } catch (sessionsError) {
      console.error("Failed to load sessions:", sessionsError);
    } finally {
      setIsLoadingSessions(false);
    }
  }

  async function cleanupSession(prefix) {
    if (!window.confirm(`Delete all keys for "${prefix}"? This cannot be undone.`)) {
      return;
    }

    setCleanupInProgress(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/redis/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix })
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.details || payload.error || "Cleanup failed");
      }

      await refreshSessions();
      await refreshContext();
    } catch (cleanupError) {
      alert(
        cleanupError instanceof Error
          ? `Cleanup failed: ${cleanupError.message}`
          : "Cleanup failed"
      );
    } finally {
      setCleanupInProgress(false);
    }
  }

  useEffect(() => {
    const chatSessionId = readChatSessionId();
    setSessionId(chatSessionId || "demo-session");
  }, []);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    refreshContext();
    refreshSessions();
  }, [sessionId]);

  useEffect(() => {
    if (!autoRefresh) {
      return undefined;
    }

    const timer = setInterval(() => {
      refreshContext();
      refreshSessions();
    }, 1500);
    return () => clearInterval(timer);
  }, [autoRefresh, sessionId]);

  async function sendInteraction(event) {
    event.preventDefault();

    if (!draft.trim()) {
      return;
    }

    const nextMessage = {
      id: createId(),
      role: "user",
      content: draft.trim()
    };

    setMessages((current) => [...current, nextMessage]);
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
          message: nextMessage.content
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
      await refreshContext();
      await refreshSessions();
    } catch (chatError) {
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "assistant",
          content:
            chatError instanceof Error
              ? `Interaction failed: ${chatError.message}`
              : "Interaction failed."
        }
      ]);
    } finally {
      setIsSending(false);
    }
  }

  const isTestSession = sessionId === "demo-session" || sessionId === "all-db-test";

  return (
    <div className="shell">
      <header className="top-nav">
        <div className="nav-brand">⚡ AiNeura</div>
        <nav className="nav-tabs">
          <Link href="/" className="nav-tab">Chat</Link>
          <Link href="/redis" className="nav-tab active">Memory Flow</Link>
          <Link href="/metadata" className="nav-tab">Metadata Lab</Link>
        </nav>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          {autoRefresh && (
            <span className="nav-live">
              <span className="dot dot-ok" />
              Live
            </span>
          )}
          <label className="auto-refresh-toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            {" "}Auto-refresh
          </label>
          <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>Session:</span>
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            style={{
              background: "var(--surface)",
              color: "var(--text-primary)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              padding: "4px 8px",
              fontSize: "12px",
              width: "180px"
            }}
          />
          <button className="ghost-btn" onClick={refreshContext}>
            Refresh
          </button>
          <button
            className="ghost-btn"
            onClick={() => {
              const chatSessionId = readChatSessionId();
              if (chatSessionId) {
                setSessionId(chatSessionId);
              }
            }}
            title="Use the same session id as the Chat page"
          >
            Use Chat Session
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner">{error}</div>
      )}

      {isTestSession && (
        <div className="error-banner" style={{ background: "rgba(124,106,247,0.08)", borderColor: "var(--accent)", color: "var(--text-primary)" }}>
          <strong>Test Session</strong> — You are viewing a test/demo session. This will not reflect real user data.{" "}
          <button
            className="ghost-btn"
            onClick={() => cleanupSession(sessionId)}
            disabled={cleanupInProgress}
            style={{ marginLeft: "12px" }}
          >
            {cleanupInProgress ? "Deleting..." : "Delete This Session"}
          </button>
        </div>
      )}

      <div style={{ padding: "16px 20px" }}>
        {/* Pipeline flow visualization */}
        <div className="pipeline-flow">
          <div className="pipeline-stage">
            <span>Raw Event</span>
            <small>MongoDB</small>
          </div>
          <div className="pipeline-arrow">→</div>
          <div className="pipeline-stage">
            <span>Memory Queue</span>
            <small>Redis</small>
          </div>
          <div className="pipeline-arrow">→</div>
          <div className="pipeline-stage">
            <span>Processing</span>
            <small>Worker</small>
          </div>
          <div className="pipeline-arrow">→</div>
          <div className="pipeline-stage">
            <span>Indexed</span>
            <small>Qdrant / Postgres</small>
          </div>
          <div className="pipeline-arrow">→</div>
          <div className="pipeline-stage active">
            <span>Working Memory</span>
            <small>Redis</small>
          </div>
        </div>

        {/* Metrics row */}
        <div className="metrics-row">
          <div className="metric-box">
            <strong>{workingMemory.activeMemories.length}</strong>
            <span>Active Memories</span>
          </div>
          <div className="metric-box">
            <strong>{recentTurns.length}</strong>
            <span>Recent Turns</span>
          </div>
          <div className="metric-box">
            <strong>{queue.length}</strong>
            <span>Queued Jobs</span>
          </div>
          <div className="metric-box">
            <strong>{sessions.length}</strong>
            <span>Sessions</span>
          </div>
          <div className="metric-box">
            <strong>{formatDate(context?.updatedAt)}</strong>
            <span>Last Updated</span>
          </div>
        </div>

        {/* Two-column layout */}
        <div className="page-2col" style={{ marginTop: "16px" }}>
          {/* Wide column */}
          <div className="col-wide">
            {/* Active sessions panel */}
            <div className="panel">
              <div className="section-heading">
                <h2>Active Sessions</h2>
                <span className="panel-badge">{sessions.length}</span>
              </div>
              <div className="session-list">
                {isLoadingSessions ? (
                  <div className="empty-state">Loading sessions…</div>
                ) : sessions.length > 0 ? (
                  sessions.map((session) => (
                    <div
                      key={session.sessionId}
                      className={`session-item${sessionId === session.sessionId ? " active" : ""}`}
                      onClick={() => setSessionId(session.sessionId)}
                      style={{ cursor: "pointer" }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {session.sessionId}
                        </div>
                        <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>
                          {session.memoryCount} memories · {session.turnCount} turns
                        </div>
                      </div>
                      <button
                        className="ghost-btn"
                        style={{ fontSize: "11px", padding: "2px 8px" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          cleanupSession(session.sessionId);
                        }}
                        disabled={cleanupInProgress}
                      >
                        Delete
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">No active sessions yet.</div>
                )}
              </div>
            </div>

            {/* Working memory panel */}
            <div className="panel" style={{ marginTop: "12px" }}>
              <div className="section-heading">
                <h2>Working Memory</h2>
                <span className="panel-badge">
                  TTL {workingMemory.ttlSeconds != null ? `${workingMemory.ttlSeconds}s` : "n/a"}
                </span>
              </div>
              {workingMemory.activeMemories.length > 0 ? (
                workingMemory.activeMemories.map((memory) => (
                  <div className="memory-card" key={memory.id || memory.fingerprint}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                      <span className="route-badge redis">Redis</span>
                      <span className="mem-type-badge" style={{ textTransform: "capitalize" }}>
                        {memory.memoryType || "unknown"}
                      </span>
                      <span style={{ marginLeft: "auto", fontSize: "11px", color: "var(--text-muted)" }}>
                        importance: <strong style={{ color: "var(--text-primary)" }}>
                          {memory.metadata?.importance?.toFixed?.(2) ?? "n/a"}
                        </strong>
                      </span>
                    </div>
                    <p style={{ margin: "0 0 4px", fontSize: "13px", color: "var(--text-primary)" }}>
                      {memory.summary}
                    </p>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                      {memory.metadata?.domain || "general"}
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state">No surfaced memories in Redis yet.</div>
              )}
            </div>

            {/* Recent turns panel */}
            <div className="panel" style={{ marginTop: "12px" }}>
              <div className="section-heading">
                <h2>Recent Turns</h2>
              </div>
              <div className="turn-list">
                {recentTurns.length > 0 ? (
                  recentTurns.map((turn) => (
                    <div
                      className="turn-item"
                      key={turn.id || `${turn.role}-${turn.createdAt}`}
                    >
                      <span className="turn-role">{turn.role}</span>
                      <span className="turn-content">{turn.content}</span>
                      <span className="turn-time">{formatDate(turn.createdAt)}</span>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">No recent turns recorded for this session.</div>
                )}
              </div>
            </div>
          </div>

          {/* Narrow column */}
          <div className="col-narrow">
            {/* Send interaction panel */}
            <div className="panel">
              <div className="section-heading">
                <h2>Send Interaction</h2>
              </div>
              <form onSubmit={sendInteraction}>
                <textarea
                  className="composer-textarea"
                  style={{ minHeight: "80px" }}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Write a message and watch Redis context update."
                />
                <button
                  className="primary-btn"
                  style={{ marginTop: "8px", width: "100%" }}
                  type="submit"
                  disabled={isSending}
                >
                  {isSending ? "Sending…" : "Send"}
                </button>
              </form>
              <div style={{ marginTop: "12px" }}>
                {messages.slice(-4).map((message) => (
                  <div
                    key={message.id}
                    className={`msg ${message.role === "user" ? "msg-user" : "msg-assistant"}`}
                  >
                    <div className="msg-role">{message.role}</div>
                    <div className="msg-content">{message.content}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Session state panel */}
            <div className="panel" style={{ marginTop: "12px" }}>
              <div className="section-heading">
                <h2>Session State</h2>
              </div>
              <div className="state-table">
                {stateEntries.length > 0 ? (
                  stateEntries.map(([key, value]) => (
                    <div
                      key={key}
                      style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: "12px" }}
                    >
                      <span style={{ color: "var(--text-muted)" }}>{key}</span>
                      <strong style={{ color: "var(--text-primary)" }}>{String(value)}</strong>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">No session state yet.</div>
                )}
              </div>
            </div>

            {/* Memory queue panel */}
            <div className="panel" style={{ marginTop: "12px" }}>
              <div className="section-heading">
                <h2>Memory Queue</h2>
              </div>
              <div className="queue-list">
                {queue.length > 0 ? (
                  queue.map((job) => (
                    <div className="queue-item" key={job.id}>
                      <strong>{job.role}</strong>
                      <span style={{ fontSize: "11px", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {job.eventId}
                      </span>
                      <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: "auto" }}>
                        {formatDate(job.enqueuedAt)}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">No pending memory jobs.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
