import { useEffect, useState, useCallback } from "react";
import { Layout } from "../components/Layout";
import { IncidentCard } from "../components/IncidentCard";
import { api } from "../api/client";
import { getSocket } from "../api/socket";
import type { Incident, IncidentStatus } from "@pulseops/shared-types";

type Filter = "all" | IncidentStatus;

export function Dashboard() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);

  // Initial load only — after this, state updates come from the socket, not
  // from re-fetching. Re-runs when the filter changes since that's a
  // different query (?status=...), not something the socket stream can filter for us.
  const fetchIncidents = useCallback(async () => {
    const { data } = await api.get<Incident[]>("/incidents", {
      params: filter === "all" ? {} : { status: filter },
    });
    setIncidents(data);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    fetchIncidents();
  }, [fetchIncidents]);

  // Real-time subscription: every connected client (this is the "everyone
  // watching the same war room screen" behavior from the spec) gets pushed
  // the same incident:created / incident:updated events the moment the
  // server publishes them, no polling involved.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    setLive(socket.connected);
    const onConnect = () => setLive(true);
    const onDisconnect = () => setLive(false);

    const onCreated = (incident: Incident) => {
      setIncidents((prev) => {
        if (prev.some((i) => i.id === incident.id)) return prev;
        return matchesFilter(incident, filter) ? [incident, ...prev] : prev;
      });
    };

    const onUpdated = (incident: Incident) => {
      setIncidents((prev) => {
        const exists = prev.some((i) => i.id === incident.id);
        if (!matchesFilter(incident, filter)) {
          // No longer belongs in this filtered view (e.g. viewing "Firing"
          // and it just got acknowledged) — drop it.
          return prev.filter((i) => i.id !== incident.id);
        }
        if (!exists) return [incident, ...prev];
        return prev.map((i) => (i.id === incident.id ? incident : i));
      });
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("incident:created", onCreated);
    socket.on("incident:updated", onUpdated);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("incident:created", onCreated);
      socket.off("incident:updated", onUpdated);
    };
  }, [filter]);

  async function handleAcknowledge(id: string) {
    // Optimistic update — the socket event will confirm/correct it a moment later.
    setIncidents((prev) =>
      prev.map((i) => (i.id === id ? { ...i, status: "acknowledged" } : i))
    );
    await api.post(`/incidents/${id}/acknowledge`);
  }

  async function handleResolve(id: string) {
    setIncidents((prev) => prev.map((i) => (i.id === id ? { ...i, status: "resolved" } : i)));
    await api.post(`/incidents/${id}/resolve`);
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
        <div className="live-indicator" title={live ? "Connected — updates are real-time" : "Disconnected"}>
          <span className={`live-dot${live ? " on" : ""}`} />
          {live ? "Live" : "Reconnecting..."}
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
            to /api/incidents and it'll show up here instantly.
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

function matchesFilter(incident: Incident, filter: Filter): boolean {
  return filter === "all" || incident.status === filter;
}
