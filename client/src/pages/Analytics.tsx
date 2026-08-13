import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { api } from "../api/client";
import type { FatigueReportEntry, SlaReport } from "@pulseops/shared-types";

export function Analytics() {
  const [fatigue, setFatigue] = useState<FatigueReportEntry[] | null>(null);
  const [sla, setSla] = useState<SlaReport | null>(null);
  const [days, setDays] = useState(30);
  const [target, setTarget] = useState(99.9);

  useEffect(() => {
    api.get<FatigueReportEntry[]>("/analytics/fatigue").then(({ data }) => setFatigue(data));
  }, []);

  useEffect(() => {
    api.get<SlaReport>("/analytics/sla", { params: { days, target } }).then(({ data }) => setSla(data));
  }, [days, target]);

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-subtitle">On-call load and uptime, computed directly from your incident history.</p>
        </div>
      </div>

      <section className="panel">
        <h2 className="panel-title">SLA &amp; error budget</h2>
        <div className="form-row">
          <div className="field">
            <label>Window (days)</label>
            <input type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </div>
          <div className="field">
            <label>Target uptime %</label>
            <input
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={target}
              onChange={(e) => setTarget(Number(e.target.value))}
            />
          </div>
        </div>

        {!sla ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading...</p>
        ) : (
          <>
            <div className="sla-summary">
              <div>
                <div className="sla-value">{sla.uptimePercent.toFixed(4)}%</div>
                <div className="sla-label">Uptime over last {sla.windowDays} days</div>
              </div>
              <div>
                <div className="sla-value">{sla.downtimeMinutes.toFixed(1)}m</div>
                <div className="sla-label">Total downtime</div>
              </div>
              <div>
                <div className="sla-value">{sla.incidentCount}</div>
                <div className="sla-label">Incidents in window</div>
              </div>
            </div>

            <div className="budget-bar-label">
              <span>Error budget consumed</span>
              <span>{sla.errorBudgetConsumedPercent.toFixed(1)}%</span>
            </div>
            <div className="budget-bar-track">
              <div
                className={`budget-bar-fill${sla.errorBudgetConsumedPercent > 100 ? " over" : ""}`}
                style={{ width: `${Math.min(100, sla.errorBudgetConsumedPercent)}%` }}
              />
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8 }}>
              {sla.errorBudgetMinutes.toFixed(1)} minute budget at a {sla.targetPercent}% target over{" "}
              {sla.windowDays} days.
              {sla.errorBudgetConsumedPercent > 100 && " Budget has been exceeded for this window."}
            </p>
          </>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">On-call fatigue</h2>
        <p className="panel-subtitle">
          Responders paged frequently, especially on weekends or outside 8am–8pm UTC, are flagged below.
        </p>
        {!fatigue ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading...</p>
        ) : fatigue.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No pages recorded yet.</p>
        ) : (
          <table className="shift-table">
            <thead>
              <tr>
                <th>Responder</th>
                <th>Total pages</th>
                <th>Weekend pages</th>
                <th>Off-hours pages</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {fatigue.map((f) => (
                <tr key={f.userId}>
                  <td style={{ fontFamily: "var(--font-body)" }}>{f.name}</td>
                  <td>{f.totalPages}</td>
                  <td>{f.weekendPages}</td>
                  <td>{f.offHoursPages}</td>
                  <td>{f.flagged && <span className="status-badge acknowledged"><span className="dot" />At risk</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Layout>
  );
}
