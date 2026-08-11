import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../components/Layout";
import { api } from "../api/client";
import type { EscalationPolicy, EscalationStep, User, NotificationChannel } from "@pulseops/shared-types";

const emptyStep = (): EscalationStep => ({ userId: "", timeoutMinutes: 15, channel: "email" });

export function EscalationPolicies() {
  const [policies, setPolicies] = useState<EscalationPolicy[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<EscalationStep[]>([emptyStep()]);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    api.get<EscalationPolicy[]>("/escalation-policies").then(({ data }) => setPolicies(data));
  }

  useEffect(() => {
    refresh();
    api.get<User[]>("/users").then(({ data }) => setUsers(data));
  }, []);

  function updateStep(i: number, patch: Partial<EscalationStep>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function userName(userId: string) {
    return users.find((u) => u.id === userId)?.name ?? userId;
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (steps.some((s) => !s.userId)) {
      setError("Every step needs a responder selected.");
      return;
    }
    try {
      await api.post("/escalation-policies", { name, steps });
      setName("");
      setSteps([emptyStep()]);
      refresh();
    } catch (err: any) {
      setError(err.response?.data?.error || "Couldn't create the policy.");
    }
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Escalation policies</h1>
          <p className="page-subtitle">
            Who gets paged first, and who's next if they don't acknowledge in time.
          </p>
        </div>
      </div>

      <section className="panel">
        <h2 className="panel-title">Existing policies</h2>
        {policies.length === 0 ? (
          <p className="panel-subtitle">None yet — create one below, then reference its ID when firing a test incident.</p>
        ) : (
          <div className="incident-list">
            {policies.map((p) => (
              <div key={p.id} className="incident-card status-resolved" style={{ opacity: 1 }}>
                <div className="incident-main">
                  <div className="incident-title">{p.name}</div>
                  <div className="incident-meta" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                    {p.steps.map((s, i) => (
                      <span key={i}>
                        Step {i + 1}: {userName(s.userId)} via {s.channel}, escalate after {s.timeoutMinutes}m
                      </span>
                    ))}
                    <span style={{ marginTop: 4 }}>id: {p.id}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Create a policy</h2>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleCreate}>
          <div className="form-row">
            <div className="field">
              <label>Policy name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          </div>

          {steps.map((step, i) => (
            <div className="form-row" key={i}>
              <div className="field">
                <label>Step {i + 1} — responder</label>
                <select value={step.userId} onChange={(e) => updateStep(i, { userId: e.target.value })} required>
                  <option value="" disabled>Select...</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Channel</label>
                <select
                  value={step.channel}
                  onChange={(e) => updateStep(i, { channel: e.target.value as NotificationChannel })}
                >
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                </select>
              </div>
              <div className="field">
                <label>Escalate after (minutes)</label>
                <input
                  type="number"
                  min={1}
                  value={step.timeoutMinutes}
                  onChange={(e) => updateStep(i, { timeoutMinutes: Number(e.target.value) })}
                  required
                />
              </div>
              {steps.length > 1 && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSteps((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  Remove
                </button>
              )}
            </div>
          ))}

          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setSteps((prev) => [...prev, emptyStep()])}>
              Add step
            </button>
            <button type="submit" className="btn btn-primary">Create policy</button>
          </div>
        </form>
      </section>
    </Layout>
  );
}
