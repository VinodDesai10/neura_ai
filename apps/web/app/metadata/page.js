"use client";

import { useMemo, useState } from "react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

const sampleInput =
  "My name is Vinod, and our project AiNeura should treat metadata importance as the main ranking signal. We need confidence to be calculated dynamically, not fixed. Yesterday we discussed improving memory retrieval with Qdrant, Postgres, Redis, and Neo4j.";

const scoreFields = [
  "importance",
  "confidence",
  "domainConfidence",
  "signalStrength",
  "specificity",
  "permanence",
  "actionability"
];

function formatScore(value) {
  return typeof value === "number" ? value.toFixed(2) : "n/a";
}

function scoreWidth(value) {
  return `${Math.max(4, Math.round((Number(value) || 0) * 100))}%`;
}

function scoreTone(value) {
  const numeric = Number(value);
  const clamped = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
  // Hue 145 (green) -> 30 (orange) as score increases.
  const hue = Math.round(145 - clamped * 115);
  return `hsl(${hue} 72% 46%)`;
}

function FieldPill({ label, value }) {
  return (
    <span className="field-pill">
      <strong>{label}</strong>
      {value}
    </span>
  );
}

function ScoreRow({ label, value }) {
  return (
    <div className="score-row">
      <div className="score-label">
        <span>{label}</span>
        <strong>{formatScore(value)}</strong>
      </div>
      <div className="score-track">
        <span
          className="score-fill"
          style={{ width: scoreWidth(value), backgroundColor: scoreTone(value) }}
        />
      </div>
    </div>
  );
}

function MetadataJson({ metadata }) {
  return (
    <details className="metadata-json">
      <summary>Full metadata JSON</summary>
      <pre>{JSON.stringify(metadata, null, 2)}</pre>
    </details>
  );
}

function CandidateCard({ candidate, index }) {
  const metadata = candidate.metadata || {};
  const tags = metadata.tags || [];
  const keywords = metadata.keywords || [];
  const entities = metadata.entities || [];

  return (
    <article className="candidate-card">
      <div className="candidate-heading">
        <div>
          <span className="eyebrow">Candidate {index + 1} — {candidate.memoryType}</span>
          <div className="candidate-summary">{candidate.summary}</div>
        </div>
        <span className={`route-badge ${candidate.route?.store?.toLowerCase() || "unknown"}`}>
          {candidate.route?.store || "Unknown"}
        </span>
      </div>

      <div className="candidate-content">{candidate.content}</div>

      <div className="metadata-pills">
        <span className="field-pill"><strong>Domain</strong>{metadata.domain}</span>
        <span className="field-pill"><strong>Sentiment</strong>{metadata.sentiment}</span>
        <span className="field-pill">
          <strong>Fingerprint</strong>{candidate.fingerprint?.slice(0, 20) || "n/a"}...
        </span>
      </div>

      <div className="score-grid">
        {scoreFields.map((field) => (
          <ScoreRow key={field} label={field} value={metadata[field]} />
        ))}
      </div>

      <div className="metadata-columns">
        <section>
          <h3>Tags</h3>
          <div className="chip-row">
            {tags.length
              ? tags.map((tag) => (
                  <span className="chip" key={tag}>
                    {tag}
                  </span>
                ))
              : <span className="chip">none</span>}
          </div>
        </section>

        <section>
          <h3>Keywords</h3>
          <div className="chip-row">
            {keywords.length
              ? keywords.map((keyword) => (
                  <span className="chip" key={keyword}>
                    {keyword}
                  </span>
                ))
              : <span className="chip">none</span>}
          </div>
        </section>

        <section>
          <h3>Entities</h3>
          <div className="chip-row">
            {entities.length
              ? entities.map((entity) => (
                  <span
                    className="entity-chip"
                    key={`${entity.type}:${entity.value}`}
                  >
                    <span className="entity-type">{entity.type}</span>
                    {entity.value}
                  </span>
                ))
              : <span className="chip">none</span>}
          </div>
        </section>

        <section>
          <h3>Routing Reason</h3>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--text-secondary)" }}>
            {candidate.route?.reason || "No routing reason available."}
          </p>
        </section>
      </div>

      <MetadataJson metadata={metadata} />
    </article>
  );
}

export default function MetadataPage() {
  const [draft, setDraft] = useState(sampleInput);
  const [role, setRole] = useState("user");
  const [preview, setPreview] = useState(null);
  const [debugState, setDebugState] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const routeCounts = useMemo(() => {
    const counts = {};

    for (const candidate of preview?.candidates || []) {
      const store = candidate.route?.store || "Unknown";
      counts[store] = (counts[store] || 0) + 1;
    }

    return counts;
  }, [preview]);

  async function runPreview(event) {
    event.preventDefault();

    setIsLoading(true);
    setError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/debug/metadata-preview`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sessionId: "metadata-preview",
          role,
          message: draft
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.details || payload.error || "Preview failed");
      }

      setPreview(payload);
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Metadata preview failed."
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function loadDebugState() {
    setError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/debug/state`);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.details || payload.error || "Debug state failed");
      }

      setDebugState(payload);
    } catch (debugError) {
      setError(
        debugError instanceof Error ? debugError.message : "Debug state could not be loaded."
      );
    }
  }

  return (
    <div className="shell">
      <header className="top-nav">
        <div className="nav-brand">⚡ AiNeura — Metadata Lab</div>
        <div />
      </header>

      <div style={{ padding: "20px" }}>
        {/* Hero stats bar */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            marginBottom: "20px"
          }}
        >
          <div>
            <div
              style={{
                fontSize: "11px",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                color: "var(--text-muted)",
                marginBottom: "6px"
              }}
            >
              AiNeura / Metadata Lab
            </div>
            <h1 style={{ margin: 0, fontSize: "1.6rem", color: "var(--text-primary)" }}>
              Inspect every memory candidate before it becomes memory.
            </h1>
          </div>

          <div className="panel" style={{ display: "flex", gap: "24px", padding: "16px 24px" }}>
            <div style={{ textAlign: "center" }}>
              <strong style={{ fontSize: "2rem", color: "var(--accent-violet)" }}>
                {preview?.candidates?.length || 0}
              </strong>
              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>Candidates</div>
            </div>
            {Object.entries(routeCounts).map(([store, count]) => (
              <div style={{ textAlign: "center" }} key={store}>
                <strong style={{ fontSize: "2rem", color: "var(--accent-cyan)" }}>{count}</strong>
                <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{store}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Workbench row */}
        <div
          className="page-2col"
          style={{ marginBottom: "20px", alignItems: "flex-start" }}
        >
          <form className="panel col-wide" onSubmit={runPreview}>
            <div className="section-heading">
              <h2>Test Input</h2>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                style={{
                  background: "var(--surface)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  padding: "4px 8px"
                }}
              >
                <option value="user">User message</option>
                <option value="assistant">Assistant reply</option>
              </select>
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{
                width: "100%",
                minHeight: "120px",
                background: "var(--surface-raised)",
                color: "var(--text-primary)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                padding: "12px",
                fontFamily: "inherit",
                fontSize: "14px",
                resize: "vertical"
              }}
            />
            <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
              <button className="primary-btn" type="submit" disabled={isLoading}>
                {isLoading ? "Generating..." : "Generate Metadata"}
              </button>
              <button
                className="ghost-btn"
                type="button"
                onClick={() => setDraft(sampleInput)}
              >
                Use Sample
              </button>
              <button className="ghost-btn" type="button" onClick={loadDebugState}>
                Load Stored Memory
              </button>
            </div>
            {error && (
              <div className="error-banner" style={{ marginTop: "12px" }}>
                {error}
              </div>
            )}
          </form>

          <div className="panel col-narrow">
            <div className="section-heading">
              <h2>What This Shows</h2>
            </div>
            <ul
              style={{
                margin: 0,
                paddingLeft: "16px",
                color: "var(--text-secondary)",
                fontSize: "13px",
                lineHeight: "1.8"
              }}
            >
              <li>Candidate segmentation from a single message</li>
              <li>Dynamic importance and confidence scoring</li>
              <li>Domain inference (not always general)</li>
              <li>Factual → Postgres, Semantic/Episodic → Qdrant</li>
              <li>Tags, keywords, entities extraction</li>
              <li>Fingerprint deduplication</li>
            </ul>
          </div>
        </div>

        {/* Candidate cards list */}
        <div className="candidate-list">
          {preview?.candidates?.length ? (
            preview.candidates.map((candidate, index) => (
              <CandidateCard
                key={`${candidate.fingerprint}-${index}`}
                candidate={candidate}
                index={index}
              />
            ))
          ) : (
            <div className="panel empty-state">
              Generate metadata to see candidates, scores, domains, tags, entities, and routing.
            </div>
          )}
        </div>

        {/* Debug state section if loaded */}
        {debugState && (
          <div className="panel" style={{ marginTop: "20px" }}>
            <div className="section-heading">
              <h2>Stored Memory Snapshot</h2>
              <button className="ghost-btn" type="button" onClick={loadDebugState}>
                Refresh
              </button>
            </div>
            <div className="stored-grid">
              <div className="stored-cell">
                <div className="stored-value">{debugState.factualMemories?.length || 0}</div>
                <div className="stored-label">Factual / Postgres</div>
              </div>
              <div className="stored-cell">
                <div className="stored-value">{debugState.vectorMemories?.length || 0}</div>
                <div className="stored-label">Vector / Qdrant</div>
              </div>
              <div className="stored-cell">
                <div className="stored-value">{debugState.rawEvents?.length || 0}</div>
                <div className="stored-label">Raw Events</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
