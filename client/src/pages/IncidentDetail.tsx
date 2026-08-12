import { useEffect, useState, useCallback, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { Layout } from "../components/Layout";
import { api } from "../api/client";
import { getSocket } from "../api/socket";
import type { Incident, IncidentEvent, TriageSuggestion } from "@pulseops/shared-types";

const EVENT_LABELS: Record<string, string> = {
  fired: "Fired",
  paged: "Paged",
  escalated: "Escalated",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  note: "Note",
};

export function IncidentDetail() {
  const { id } = useParams<{ id: string }>();
  const [incident, setIncident] = useState<Incident | null>(null);
  const [events, setEvents] = useState<IncidentEvent[]>([]);
  const [triage, setTriage] = useState<TriageSuggestion | null>(null);
  const [noteText, setNoteText] = useState("");
  const [submittingNote, setSubmittingNote] = useState(false);

  const refresh = useCallback(() => {
    if (!id) return;
    api.get<Incident>(`/incidents/${id}`).then(({ data }) => setIncident(data));
    api.get<IncidentEvent[]>(`/incidents/${id}/events`).then(({ data }) => setEvents(data));
    api.get<TriageSuggestion>(`/incidents/${id}/triage`).then(({ data }) => setTriage(data));
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live-updates: incident state changes (ack/resolve/escalation) and the
  // triage suggestion finishing both arrive over the same socket used on
  // the dashboard — no polling needed here either.
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !id) return;

    const onUpdated = (updated: Incident) => {
      if (updated.id === id) {
        setIncident(updated);
        api.get<IncidentEvent[]>(`/incidents/${id}/events`).then(({ data }) => setEvents(data));
      }
    };
    const onTriageReady = (payload: { incidentId: string }) => {
      if (payload.incidentId === id) {
        api.get<TriageSuggestion>(`/incidents/${id}/triage`).then(({ data }) => setTriage(data));
      }
    };

    socket.on("incident:updated", onUpdated);
    socket.on("incident:triage-ready", onTriageReady);
    return () => {
      socket.off("incident:updated", onUpdated);
      socket.off("incident:triage-ready", onTriageReady);
    };
  }, [id]);

  async function handleAcknowledge() {
    if (!id) return;
    await api.post(`/incidents/${id}/acknowledge`);
  }

  async function handleResolve() {
    if (!id) return;
    await api.post(`/incidents/${id}/resolve`);
  }

  async function handleAddNote(e: FormEvent) {
    e.preventDefault();
    if (!id || !noteText.trim()) return;
    setSubmittingNote(true);
    try {
      await api.post(`/incidents/${id}/notes`, { message: noteText });
      setNoteText("");
      api.get<IncidentEvent[]>(`/incidents/${id}/events`).then(({ data }) => setEvents(data));
    } finally {
      setSubmittingNote(false);
    }
  }

  if (!incident) {
    return (
      <Layout>
        <div className="empty-state">Loading incident...</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <Link to="/" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>
        ← Back to incidents
      </Link>

      <div className="page-header" style={{ marginTop: 10 }}>
        <div>
          <h1 className="page-title">{incident.title}</h1>
          <p className="page-subtitle">{incident.description || "No description provided."}</p>
        </div>
        <span className={`status-badge ${incident.status}`}>
          <span className="dot" />
          {incident.status}
        </span>
      </div>

      <div className="incident-actions" style={{ marginBottom: 24 }}>
        {incident.status === "firing" && (
          <button className="btn btn-secondary" onClick={handleAcknowledge}>Acknowledge</button>
        )}
        {incident.status !== "resolved" && (
          <button className="btn btn-primary" onClick={handleResolve}>Resolve</button>
        )}
      </div>

      <section className="panel">
        <h2 className="panel-title">AI triage suggestion</h2>
        <p className="panel-subtitle">
          Grounded in similar past incidents from your own history — retrieved via pgvector similarity search.
        </p>
        {!triage || triage.status === "pending" ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Generating... this runs in the background and usually takes a few seconds.
          </p>
        ) : triage.similarIncidents.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>{triage.summary}</p>
        ) : (
          <>
            <p style={{ fontSize: 14, marginBottom: 14 }}>{triage.summary}</p>
            <div className="incident-list">
              {triage.similarIncidents.map((s) => (
                <div key={s.incidentId} className="incident-card status-resolved" style={{ opacity: 1 }}>
                  <div className="incident-main">
                    <Link to={`/incidents/${s.incidentId}`} className="incident-title" style={{ textDecoration: "none" }}>
                      {s.title}
                    </Link>
                    <div className="incident-meta">
                      <span>{Math.round(s.similarity * 100)}% similar</span>
                      {s.resolvedAt && <span>resolved {new Date(s.resolvedAt).toLocaleDateString()}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Timeline</h2>
        <div className="timeline">
          {events.map((e) => (
            <div key={e.id} className="timeline-item">
              <span className="timeline-dot" />
              <div>
                <div className="timeline-label">{EVENT_LABELS[e.type] || e.type}</div>
                {e.message && <div className="timeline-message">{e.message}</div>}
                <div className="timeline-time">{new Date(e.timestamp).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>

        <form onSubmit={handleAddNote} className="form-row" style={{ marginTop: 16 }}>
          <div className="field" style={{ flex: 3 }}>
            <label>Add a note (feeds future AI triage for similar incidents)</label>
            <input
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="e.g. Restarted the connection pool and raised max_connections"
            />
          </div>
          <button className="btn btn-secondary" type="submit" disabled={submittingNote || !noteText.trim()}>
            Add note
          </button>
        </form>
      </section>
    </Layout>
  );
}
