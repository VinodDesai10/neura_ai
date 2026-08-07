"use client";

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

const WELCOME_MESSAGE = {
  id: "welcome",
  role: "assistant",
  content:
    "I am AiNeura in demo mode. Ask me something, tell me a fact to remember, or reference something from earlier in the conversation."
};

const SUGGESTED_PROMPTS = [
  "What can you remember from our previous conversations?",
  "Tell me something interesting about memory and AI.",
  "What is your cognitive architecture?",
  "Explain how your working memory works."
];

// ─── ID helpers ──────────────────────────────────────────────────────────────

function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Markdown renderer (no deps) ─────────────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return "";

  const lines = text.split("\n");
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      output.push(
        `<pre class="md-pre"><code class="md-code-block">${escHtml(codeLines.join("\n"))}</code></pre>`
      );
      i++;
      continue;
    }

    // Heading
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    if (h3) { output.push(`<h3 class="md-h3">${inlineMarkdown(h3[1])}</h3>`); i++; continue; }
    if (h2) { output.push(`<h2 class="md-h2">${inlineMarkdown(h2[1])}</h2>`); i++; continue; }
    if (h1) { output.push(`<h1 class="md-h1">${inlineMarkdown(h1[1])}</h1>`); i++; continue; }

    // Unordered list
    if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(`<li>${inlineMarkdown(lines[i].replace(/^[-*] /, ""))}</li>`);
        i++;
      }
      output.push(`<ul class="md-ul">${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(`<li>${inlineMarkdown(lines[i].replace(/^\d+\. /, ""))}</li>`);
        i++;
      }
      output.push(`<ol class="md-ol">${items.join("")}</ol>`);
      continue;
    }

    // Blank line → spacer
    if (line.trim() === "") {
      output.push(`<div class="md-spacer"></div>`);
      i++;
      continue;
    }

    // Paragraph
    output.push(`<p class="md-p">${inlineMarkdown(line)}</p>`);
    i++;
  }

  return output.join("");
}

function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdown(str) {
  return escHtml(str)
    // bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // inline code
    .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
}

// ─── Session registry ─────────────────────────────────────────────────────────

function readSessionRegistry() {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem("neura-sessions") || "[]"); }
  catch { return []; }
}

function writeSessionRegistry(sessions) {
  if (typeof window === "undefined") return;
  localStorage.setItem("neura-sessions", JSON.stringify(sessions));
}

function registerSession(sessionId, title) {
  const sessions = readSessionRegistry();
  const existing = sessions.findIndex((s) => s.id === sessionId);
  const now = new Date().toISOString();

  if (existing !== -1) {
    sessions[existing].updatedAt = now;
    if (title) sessions[existing].title = title;
    const [entry] = sessions.splice(existing, 1);
    sessions.unshift(entry);
  } else {
    sessions.unshift({ id: sessionId, title: title || "New chat", createdAt: now, updatedAt: now });
  }

  writeSessionRegistry(sessions);
  return sessions;
}

function unregisterSession(sessionId) {
  const sessions = readSessionRegistry().filter((s) => s.id !== sessionId);
  writeSessionRegistry(sessions);
  return sessions;
}

// ─── Date grouping ────────────────────────────────────────────────────────────

function groupSessionsByDate(sessions) {
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yest  = today - 86400000;
  const week  = today - 6 * 86400000;

  const groups = { Today: [], Yesterday: [], "Last 7 days": [], Older: [] };

  for (const s of sessions) {
    const t = new Date(s.updatedAt || s.createdAt).getTime();
    if      (t >= today) groups["Today"].push(s);
    else if (t >= yest)  groups["Yesterday"].push(s);
    else if (t >= week)  groups["Last 7 days"].push(s);
    else                 groups["Older"].push(s);
  }

  return Object.entries(groups).filter(([, items]) => items.length > 0);
}

// ─── Per-session storage ──────────────────────────────────────────────────────

function loadMessages(sessionId) {
  if (typeof window === "undefined") return [WELCOME_MESSAGE];
  try {
    const stored = localStorage.getItem(`neura-messages-${sessionId}`);
    return stored ? JSON.parse(stored) : [WELCOME_MESSAGE];
  } catch { return [WELCOME_MESSAGE]; }
}

function saveMessages(sessionId, messages) {
  if (typeof window === "undefined") return;
  localStorage.setItem(`neura-messages-${sessionId}`, JSON.stringify(messages));
}

function loadWorkingMemory(sessionId) {
  if (typeof window === "undefined") return { activeMemories: [], recentContext: [] };
  try {
    const stored = localStorage.getItem(`neura-working-memory-${sessionId}`);
    return stored ? JSON.parse(stored) : { activeMemories: [], recentContext: [] };
  } catch { return { activeMemories: [], recentContext: [] }; }
}

function saveWorkingMemory(sessionId, memory) {
  if (typeof window === "undefined") return;
  localStorage.setItem(`neura-working-memory-${sessionId}`, JSON.stringify(memory));
}

function deleteSessionData(sessionId) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(`neura-messages-${sessionId}`);
  localStorage.removeItem(`neura-working-memory-${sessionId}`);
}

function getActiveSessionId() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("neura-session-id");
}

function setActiveSessionId(sessionId) {
  if (typeof window === "undefined") return;
  localStorage.setItem("neura-session-id", sessionId);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function HomePage() {
  const messagesEndRef  = useRef(null);
  const textareaRef     = useRef(null);
  const healthTimerRef  = useRef(null);

  const [sessionId,     setSessionId]     = useState("");
  const [sessions,      setSessions]      = useState([]);
  const [messages,      setMessages]      = useState([WELCOME_MESSAGE]);
  const [draft,         setDraft]         = useState("");
  const [memoryState,   setMemoryState]   = useState({ activeMemories: [], recentContext: [] });
  const [storageHealth, setStorageHealth] = useState(null);
  const [healthError,   setHealthError]   = useState("");
  const [isSending,     setIsSending]     = useState(false);
  const [isHydrated,    setIsHydrated]    = useState(false);
  const [rightOpen,     setRightOpen]     = useState(true);
  const [copiedId,      setCopiedId]      = useState(null);

  // ── Hydrate ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let sid = getActiveSessionId();
    if (!sid) { sid = createId(); setActiveSessionId(sid); }

    const msgs = loadMessages(sid);
    const wm   = loadWorkingMemory(sid);
    const reg  = readSessionRegistry();

    const hasRealMessages = msgs.some((m) => m.id !== "welcome");
    if (hasRealMessages && !reg.find((s) => s.id === sid)) {
      const updated = registerSession(sid, deriveTitle(msgs));
      setSessions(updated);
    } else {
      setSessions(reg);
    }

    setSessionId(sid);
    setMessages(msgs);
    setMemoryState(wm);
    setIsHydrated(true);
    refreshStorageHealth();

    // Poll health every 30s
    healthTimerRef.current = setInterval(refreshStorageHealth, 30000);
    return () => clearInterval(healthTimerRef.current);
  }, []);

  // ── Persist ───────────────────────────────────────────────────────────────────
  useEffect(() => { if (sessionId) saveMessages(sessionId, messages); }, [messages, sessionId]);
  useEffect(() => { if (sessionId) saveWorkingMemory(sessionId, memoryState); }, [memoryState, sessionId]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSending]);

  // ── Auto-resize textarea ──────────────────────────────────────────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [draft]);

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function deriveTitle(msgs) {
    const firstUser = msgs.find((m) => m.role === "user");
    if (!firstUser) return "New chat";
    const text = firstUser.content.trim().replace(/\s+/g, " ");
    return text.length > 48 ? text.slice(0, 48).replace(/\s\S*$/, "") + "…" : text;
  }

  async function refreshStorageHealth() {
    try {
      const res = await fetch(`${apiBaseUrl}/health/storage`);
      setStorageHealth(await res.json());
      setHealthError("");
    } catch {
      setHealthError("API status unavailable");
    }
  }

  async function fetchWorkingMemorySnapshot(sid) {
    try {
      const res = await fetch(`${apiBaseUrl}/api/redis/context?sessionId=${encodeURIComponent(sid)}`);
      if (!res.ok) return null;
      return (await res.json()).workingMemory || null;
    } catch { return null; }
  }

  async function copyText(text, id) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch { /* ignore */ }
  }

  // ─── Session actions ──────────────────────────────────────────────────────────

  function startNewSession() {
    const newId = createId();
    setActiveSessionId(newId);
    setSessionId(newId);
    setMessages([WELCOME_MESSAGE]);
    setMemoryState({ activeMemories: [], recentContext: [] });
    setDraft("");
  }

  function switchSession(sid) {
    if (sid === sessionId) return;
    setActiveSessionId(sid);
    setSessionId(sid);
    setMessages(loadMessages(sid));
    setMemoryState(loadWorkingMemory(sid));
    setDraft("");
  }

  function deleteSession(sid) {
    deleteSessionData(sid);
    const updated = unregisterSession(sid);
    setSessions(updated);
    if (sid === sessionId) {
      const next = updated[0];
      next ? switchSession(next.id) : startNewSession();
    }
  }

  // ─── Send message ─────────────────────────────────────────────────────────────

  async function sendMessage(event) {
    event?.preventDefault();
    if (!draft.trim()) return;

    const nextUserMessage = { id: createId(), role: "user", content: draft.trim(), createdAt: new Date().toISOString() };
    const nextMessages = [...messages, nextUserMessage];
    setMessages(nextMessages);
    setDraft("");
    setIsSending(true);

    const isFirstMessage = !messages.some((m) => m.role === "user");
    if (isFirstMessage) {
      const updated = registerSession(sessionId,
        nextUserMessage.content.length > 48
          ? nextUserMessage.content.slice(0, 48).replace(/\s\S*$/, "") + "…"
          : nextUserMessage.content
      );
      setSessions(updated);
    }

    try {
      const res = await fetch(`${apiBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: nextUserMessage.content })
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.details || payload.error || "Chat request failed");

      const withReply = [
        ...nextMessages,
        { id: createId(), role: "assistant", content: payload.reply || "No response received.", createdAt: new Date().toISOString() }
      ];
      setMessages(withReply);

      const wm = payload.workingMemory
        || await fetchWorkingMemorySnapshot(sessionId)
        || { activeMemories: [], recentContext: [] };
      setMemoryState(wm);

      setSessions(registerSession(sessionId, null));
      refreshStorageHealth();
    } catch (error) {
      setMessages((cur) => [
        ...cur,
        {
          id: createId(),
          role: "assistant",
          content: error instanceof Error
            ? `The chat pipeline hit an issue: ${error.message}`
            : "The API is not reachable yet. Start the backend service to enable the chat pipeline.",
          createdAt: new Date().toISOString()
        }
      ]);
    } finally {
      setIsSending(false);
    }
  }

  // ─── Derived ──────────────────────────────────────────────────────────────────

  const healthTone  = healthError ? "warn" : statusToneByKey[storageHealth?.status] || "pending";
  const healthLabel = healthError ? "API Unavailable" : statusLabels[storageHealth?.status] || "Checking...";
  const isNewSession = !messages.some((m) => m.role === "user");
  const groupedSessions = groupSessionsByDate(sessions);

  function memTypeCls(t) {
    if (t === "factual")  return "factual";
    if (t === "semantic") return "semantic";
    return "episodic";
  }

  function importanceColor(score) {
    if (score >= 0.75) return "var(--blue)";
    if (score >= 0.45) return "var(--teal)";
    return "var(--text-quaternary)";
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="shell">

      {/* ── Top nav ── */}
      <header className="top-nav">
        <div className="nav-brand">
          <span className="nav-logo">⚡</span>
          <span className="nav-name">AiNeura</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--text-secondary)" }}>
            <span className={`dot dot-${healthTone}`} />
            {healthLabel}
          </span>
          {/* Toggle right sidebar */}
          <button
            type="button"
            className="ghost-btn"
            onClick={() => setRightOpen((v) => !v)}
            title={rightOpen ? "Hide memory panel" : "Show memory panel"}
            style={{ padding: "0 10px", fontSize: "14px" }}
          >
            {rightOpen ? "▶" : "◀"} Memory
          </button>
        </div>
      </header>

      {/* ── Layout ── */}
      <div className="page-3col">

        {/* ── Left sidebar ── */}
        <aside className="col-left" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>

          <button type="button" className="new-chat-btn" onClick={startNewSession}>
            <span style={{ fontSize: "16px", lineHeight: 1 }}>+</span>
            New Chat
          </button>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {sessions.length === 0 ? (
              <p style={{ fontSize: "12px", color: "var(--text-quaternary)", textAlign: "center", marginTop: "24px", padding: "0 8px" }}>
                No past chats yet.<br />Start a conversation!
              </p>
            ) : (
              groupedSessions.map(([group, items]) => (
                <div key={group} style={{ marginBottom: "8px" }}>
                  <div className="session-group-label">{group}</div>
                  {items.map((session) => (
                    <div
                      key={session.id}
                      className={`sidebar-session-item${session.id === sessionId ? " active" : ""}`}
                      onClick={() => switchSession(session.id)}
                    >
                      <div className="sidebar-session-title">{session.title}</div>
                      <button
                        type="button"
                        className="sidebar-session-delete"
                        title="Delete chat"
                        onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
                      >✕</button>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* System status */}
          <div className="panel" style={{ flexShrink: 0 }}>
            <div className="panel-title">System Status</div>
            {["mongo", "postgres", "qdrant", "redis", "neo4j"].map((service) => {
              const state = storageHealth?.storage?.[service];
              const isOk  = state?.ok;
              return (
                <div className="service-row" key={service}>
                  <span className={`dot ${isOk ? "dot-ok" : "dot-pending"}`} />
                  <span style={{ flex: 1, textTransform: "capitalize", fontSize: "13px", color: "var(--text-secondary)" }}>
                    {service}
                  </span>
                  <span style={{ fontSize: "11px", color: isOk ? "var(--green)" : "var(--text-quaternary)" }}>
                    {isOk ? "ok" : "—"}
                  </span>
                </div>
              );
            })}
            {healthError && <p style={{ margin: "8px 0 4px", fontSize: "12px", color: "var(--red)" }}>{healthError}</p>}
            <button type="button" className="ghost-btn" onClick={refreshStorageHealth} style={{ marginTop: "12px", width: "100%" }}>
              Refresh
            </button>
          </div>
        </aside>

        {/* ── Chat ── */}
        <section className="col-main">

          {/* Empty state */}
          {isHydrated && isNewSession ? (
            <div className="chat-empty-state">
              <div className="chat-empty-logo">⚡</div>
              <h2 className="chat-empty-title">What's on your mind?</h2>
              <p className="chat-empty-sub">AiNeura remembers across conversations. Try one of these:</p>
              <div className="chat-empty-prompts">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="chat-empty-prompt-btn"
                    onClick={() => { setDraft(prompt); textareaRef.current?.focus(); }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="chat-scroll">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`msg ${message.role === "user" ? "msg-user" : "msg-assistant"}`}
                >
                  <div className="msg-role">{message.role === "user" ? "You" : "AiNeura"}</div>

                  {message.role === "assistant" ? (
                    <div className="msg-content-wrapper">
                      <div
                        className="msg-content msg-content-md"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                      />
                      <button
                        type="button"
                        className={`msg-copy-btn${copiedId === message.id ? " copied" : ""}`}
                        onClick={() => copyText(message.content, message.id)}
                        title="Copy message"
                      >
                        {copiedId === message.id ? "✓ Copied" : "Copy"}
                      </button>
                    </div>
                  ) : (
                    <div className="msg-content">{message.content}</div>
                  )}
                </div>
              ))}

              {isSending && (
                <div className="msg msg-assistant">
                  <div className="msg-role">AiNeura</div>
                  <div className="typing-dots"><span /><span /><span /></div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}

          {/* Composer */}
          <div className="composer-bar">
            <textarea
              ref={textareaRef}
              className="composer-textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(e); }
              }}
              placeholder="Ask me something… (Shift+Enter for new line)"
              disabled={isSending}
              rows={1}
            />
            <button
              type="button"
              className="composer-send"
              onClick={sendMessage}
              disabled={isSending || !draft.trim()}
            >↑</button>
          </div>

          {isHydrated && (
            <div style={{ padding: "4px 20px 8px" }}>
              <small style={{ color: "var(--text-quaternary)", fontVariantNumeric: "tabular-nums" }}>
                Session: {sessionId.slice(0, 8)}…
              </small>
            </div>
          )}
        </section>

        {/* ── Right sidebar: Working Memory ── */}
        {rightOpen && (
          <aside className="col-right">
            <div className="panel">
              <div className="panel-title">
                Working Memory
                <span className="panel-badge">{memoryState.activeMemories.length}</span>
              </div>

              <div className="mem-list">
                {memoryState.activeMemories.length ? (
                  memoryState.activeMemories.map((memory) => {
                    const score = memory.metadata?.importance ?? memory.score ?? 0;
                    return (
                      <div className="mem-card" key={memory.id}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "5px" }}>
                          <span className={`mem-type-badge ${memTypeCls(memory.memoryType)}`}>
                            {memory.memoryType || "episodic"}
                          </span>
                          <span style={{ marginLeft: "auto", fontSize: "11px", color: "var(--text-quaternary)", fontVariantNumeric: "tabular-nums" }}>
                            {score.toFixed(2)}
                          </span>
                        </div>
                        <div className="mem-summary">{memory.summary}</div>
                        {/* Importance bar */}
                        <div className="mem-score-track" style={{ marginTop: "6px" }}>
                          <div
                            className="mem-score-fill"
                            style={{
                              width: `${Math.min(score * 100, 100)}%`,
                              background: importanceColor(score)
                            }}
                          />
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="empty-state" style={{ padding: "20px 8px" }}>
                    <span style={{ fontSize: "22px" }}>🧠</span>
                    <span>No memories surfaced yet</span>
                    <span style={{ fontSize: "11px", maxWidth: "160px", textAlign: "center", lineHeight: 1.5 }}>
                      Memories appear here once you start chatting
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="panel" style={{ marginTop: "12px" }}>
              <div className="panel-title">Recent Context</div>
              {memoryState.recentContext?.length ? (
                <div className="turn-list">
                  {memoryState.recentContext.map((turn, idx) => (
                    <div className="turn-item" key={turn.id || idx}>
                      <span className="turn-role">{turn.role === "user" ? "You" : "AI"}</span>
                      <span className="turn-content">
                        {typeof turn.content === "string"
                          ? turn.content.slice(0, 120) + (turn.content.length > 120 ? "…" : "")
                          : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty-state" style={{ padding: "16px 8px" }}>No recent context</p>
              )}
            </div>
          </aside>
        )}

      </div>
    </div>
  );
}
