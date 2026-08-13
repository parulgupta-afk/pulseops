import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import type { PublicStatusResponse } from "@pulseops/shared-types";

// Deliberately outside <Layout> and <ProtectedRoute> — this is the page a
// customer or stakeholder visits with no PulseOps account at all.
export function PublicStatus() {
  const { orgId } = useParams<{ orgId: string }>();
  const [status, setStatus] = useState<PublicStatusResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    api
      .get<PublicStatusResponse>(`/public/status/${orgId}`)
      .then(({ data }) => setStatus(data))
      .catch(() => setError(true));
  }, [orgId]);

  if (error) {
    return (
      <div className="public-status-shell">
        <div className="public-status-card">Status page not found.</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="public-status-shell">
        <div className="public-status-card">Loading...</div>
      </div>
    );
  }

  return (
    <div className="public-status-shell">
      <div className="public-status-card">
        <div className="brand" style={{ marginBottom: 24 }}>
          <span className="brand-pulse" />
          {status.orgName}
        </div>

        <div className={`operational-banner${status.operational ? "" : " degraded"}`}>
          {status.operational ? "✓ All systems operational" : "⚠ Active incident(s) in progress"}
        </div>

        {status.activeIncidents.length > 0 && (
          <>
            <h2 className="panel-title" style={{ marginTop: 28 }}>Active incidents</h2>
            <div className="incident-list">
              {status.activeIncidents.map((i) => (
                <div key={i.id} className={`incident-card status-${i.status}`}>
                  <div className="incident-main">
                    <div className="incident-title">{i.title}</div>
                    {i.description && <div className="incident-meta">{i.description}</div>}
                  </div>
                  <span className={`status-badge ${i.status}`}>
                    <span className="dot" />
                    {i.status}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {status.recentlyResolved.length > 0 && (
          <>
            <h2 className="panel-title" style={{ marginTop: 28 }}>Recently resolved</h2>
            <div className="incident-list">
              {status.recentlyResolved.map((i) => (
                <div key={i.id} className="incident-card status-resolved" style={{ opacity: 1 }}>
                  <div className="incident-main">
                    <div className="incident-title">{i.title}</div>
                    <div className="incident-meta">
                      resolved {i.resolvedAt ? new Date(i.resolvedAt).toLocaleString() : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
