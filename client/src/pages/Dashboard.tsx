import { useEffect, useState, useCallback } from "react";
import { Layout } from "../components/Layout";
import { IncidentCard } from "../components/IncidentCard";
import { api } from "../api/client";
import type { Incident, IncidentStatus } from "@pulseops/shared-types";

// Phase 1: polling. Phase 2 swaps this for a WebSocket subscription so every
// connected client updates in lockstep instead of on its own 5s timer.
const POLL_INTERVAL_MS = 5000;

type Filter = "all" | IncidentStatus;

export function Dashboard() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);

  const fetchIncidents = useCallback(async () => {
    const { data } = await api.get<Incident[]>("/incidents", {
      params: filter === "all" ? {} : { status: filter },
    });
    setIncidents(data);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    fetchIncidents();
    const interval = setInterval(fetchIncidents, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchIncidents]);

  async function handleAcknowledge(id: string) {
    setIncidents((prev) =>
      prev.map((i) => (i.id === id ? { ...i, status: "acknowledged" } : i))
    );
    await api.post(`/incidents/${id}/acknowledge`);
    fetchIncidents();
  }

  async function handleResolve(id: string) {
    setIncidents((prev) => prev.map((i) => (i.id === id ? { ...i, status: "resolved" } : i)));
    await api.post(`/incidents/${id}/resolve`);
    fetchIncidents();
  }

  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "firing", label: "Firing" },
    { key: "acknowledged", label: "Acknowledged" },
    { key: "resolved", label: "Resolved" },
  ];

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Incidents</h1>
          <p className="page-subtitle">Live view of everything firing across your org.</p>
        </div>
      </div>

      <div className="tabs">
        {tabs.map((t) => (
          <div
            key={t.key}
            className={`tab${filter === t.key ? " active" : ""}`}
            onClick={() => setFilter(t.key)}
          >
            {t.label}
          </div>
        ))}
      </div>

      {loading ? (
        <div className="empty-state">Loading incidents...</div>
      ) : incidents.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">Nothing here</div>
          <div>
            No {filter === "all" ? "" : filter} incidents right now. Trigger one with a POST
            to /api/incidents to see it show up live.
          </div>
        </div>
      ) : (
        <div className="incident-list">
          {incidents.map((incident) => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              onAcknowledge={handleAcknowledge}
              onResolve={handleResolve}
            />
          ))}
        </div>
      )}
    </Layout>
  );
}
