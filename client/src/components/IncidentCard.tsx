import { Link } from "react-router-dom";
import type { Incident } from "@pulseops/shared-types";

interface Props {
  incident: Incident;
  onAcknowledge: (id: string) => void;
  onResolve: (id: string) => void;
}

function timeAgo(iso: string) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function IncidentCard({ incident, onAcknowledge, onResolve }: Props) {
  return (
    <div className={`incident-card status-${incident.status}`}>
      <div className="incident-main">
        <Link to={`/incidents/${incident.id}`} className="incident-title" style={{ textDecoration: "none" }}>
          {incident.title}
        </Link>
        <div className="incident-meta">
          <span>fired {timeAgo(incident.firedAt)}</span>
          <span>key: {incident.idempotencyKey}</span>
        </div>
      </div>

      <span className={`status-badge ${incident.status}`}>
        <span className="dot" />
        {incident.status}
      </span>

      <div className="incident-actions">
        {incident.status === "firing" && (
          <button className="btn btn-secondary" onClick={() => onAcknowledge(incident.id)}>
            Acknowledge
          </button>
        )}
        {incident.status !== "resolved" && (
          <button className="btn btn-primary" onClick={() => onResolve(incident.id)}>
            Resolve
          </button>
        )}
      </div>
    </div>
  );
}
