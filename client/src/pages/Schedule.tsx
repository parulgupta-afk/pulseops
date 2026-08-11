import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../components/Layout";
import { api } from "../api/client";
import type {
  Schedule,
  ScheduleShift,
  ScheduleMember,
  User,
  RotationViolation,
  FairnessReportEntry,
} from "@pulseops/shared-types";

export function SchedulePage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shifts, setShifts] = useState<(ScheduleShift & { name: string })[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [members, setMembers] = useState<ScheduleMember[]>([]);
  const [currentOncall, setCurrentOncall] = useState<{ name: string } | null>(null);

  const [newScheduleName, setNewScheduleName] = useState("");
  const [shiftUserId, setShiftUserId] = useState("");
  const [shiftStart, setShiftStart] = useState("");
  const [shiftEnd, setShiftEnd] = useState("");

  const [rosterUserId, setRosterUserId] = useState("");
  const [rosterBlackouts, setRosterBlackouts] = useState("");

  const [genStart, setGenStart] = useState("");
  const [genEnd, setGenEnd] = useState("");
  const [generating, setGenerating] = useState(false);
  const [violations, setViolations] = useState<RotationViolation[] | null>(null);
  const [fairness, setFairness] = useState<FairnessReportEntry[] | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Schedule[]>("/schedules").then(({ data }) => {
      setSchedules(data);
      if (data.length > 0) setSelectedId(data[0].id);
    });
    api.get<User[]>("/users").then(({ data }) => setUsers(data));
  }, []);

  function refreshShifts(id: string) {
    api.get(`/schedules/${id}/shifts`).then(({ data }) => setShifts(data));
    api
      .get(`/schedules/${id}/current-oncall`)
      .then(({ data }) => setCurrentOncall(data))
      .catch(() => setCurrentOncall(null));
  }

  function refreshMembers(id: string) {
    api.get<ScheduleMember[]>(`/schedules/${id}/members`).then(({ data }) => setMembers(data));
  }

  useEffect(() => {
    if (!selectedId) return;
    refreshShifts(selectedId);
    refreshMembers(selectedId);
    setViolations(null);
    setFairness(null);
    setGenError(null);
  }, [selectedId]);

  async function handleCreateSchedule(e: FormEvent) {
    e.preventDefault();
    const { data } = await api.post<Schedule>("/schedules", { name: newScheduleName });
    setSchedules((prev) => [data, ...prev]);
    setSelectedId(data.id);
    setNewScheduleName("");
  }

  async function handleAddShift(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    await api.post(`/schedules/${selectedId}/shifts`, {
      userId: shiftUserId,
      startsAt: new Date(shiftStart).toISOString(),
      endsAt: new Date(shiftEnd).toISOString(),
    });
    refreshShifts(selectedId);
  }

  async function handleAddRosterMember(e: FormEvent) {
    e.preventDefault();
    if (!selectedId || !rosterUserId) return;
    const blackoutDates = rosterBlackouts
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    await api.post(`/schedules/${selectedId}/members`, { userId: rosterUserId, blackoutDates });
    setRosterUserId("");
    setRosterBlackouts("");
    refreshMembers(selectedId);
  }

  async function handleRemoveMember(memberId: string) {
    if (!selectedId) return;
    await api.delete(`/schedules/${selectedId}/members/${memberId}`);
    refreshMembers(selectedId);
  }

  async function handleGenerate(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setGenerating(true);
    setGenError(null);
    setViolations(null);
    setFairness(null);
    try {
      const { data } = await api.post(`/schedules/${selectedId}/generate`, {
        startDate: genStart,
        endDate: genEnd,
      });
      setViolations(data.violations);
      setFairness(data.fairnessReport);
      refreshShifts(selectedId);
    } catch (err: any) {
      setGenError(err.response?.data?.error || "Couldn't generate a rotation. Check the dates and try again.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">On-call schedule</h1>
          <p className="page-subtitle">
            Build a roster with each person's time off, then generate a fair rotation automatically.
          </p>
        </div>
      </div>

      {schedules.length === 0 ? (
        <form onSubmit={handleCreateSchedule} className="form-row">
          <div className="field">
            <label>New schedule name</label>
            <input value={newScheduleName} onChange={(e) => setNewScheduleName(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit">Create schedule</button>
        </form>
      ) : (
        <>
          <div className="form-row">
            <div className="field">
              <label>Schedule</label>
              <select value={selectedId ?? ""} onChange={(e) => setSelectedId(e.target.value)}>
                {schedules.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="oncall-banner">
            <div>
              <div className="oncall-label">Currently on-call</div>
              <div className="oncall-name">{currentOncall ? currentOncall.name : "Nobody — generate a rotation or add a shift below"}</div>
            </div>
          </div>

          <section className="panel">
            <h2 className="panel-title">Roster &amp; time off</h2>
            <p className="panel-subtitle">
              Blackout dates are a hard constraint — the algorithm will never schedule someone on a day they've listed here.
            </p>

            {members.length > 0 && (
              <table className="shift-table" style={{ marginBottom: 16 }}>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Blackout dates</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id}>
                      <td style={{ fontFamily: "var(--font-body)" }}>{m.name}</td>
                      <td>{m.blackoutDates.length > 0 ? m.blackoutDates.join(", ") : "—"}</td>
                      <td>
                        <button className="btn btn-secondary" onClick={() => handleRemoveMember(m.id)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <form onSubmit={handleAddRosterMember} className="form-row">
              <div className="field">
                <label>Add to roster</label>
                <select value={rosterUserId} onChange={(e) => setRosterUserId(e.target.value)} required>
                  <option value="" disabled>Select a person...</option>
                  {users
                    .filter((u) => !members.some((m) => m.userId === u.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                </select>
              </div>
              <div className="field" style={{ flex: 2 }}>
                <label>Blackout dates (comma-separated, YYYY-MM-DD)</label>
                <input
                  placeholder="2026-08-20, 2026-08-21"
                  value={rosterBlackouts}
                  onChange={(e) => setRosterBlackouts(e.target.value)}
                />
              </div>
              <button className="btn btn-secondary" type="submit">Add</button>
            </form>
          </section>

          <section className="panel">
            <h2 className="panel-title">Generate rotation</h2>
            <p className="panel-subtitle">
              Runs the constraint-based scheduler over the roster above for the date range you pick, replacing any
              previously auto-generated shifts in that window.
            </p>

            <form onSubmit={handleGenerate} className="form-row">
              <div className="field">
                <label>From</label>
                <input type="date" value={genStart} onChange={(e) => setGenStart(e.target.value)} required />
              </div>
              <div className="field">
                <label>Until (exclusive)</label>
                <input type="date" value={genEnd} onChange={(e) => setGenEnd(e.target.value)} required />
              </div>
              <button className="btn btn-primary" type="submit" disabled={generating}>
                {generating ? "Generating..." : "Generate rotation"}
              </button>
            </form>

            {genError && <div className="auth-error">{genError}</div>}

            {violations && (
              <div className={`violations-panel${violations.length === 0 ? " clean" : ""}`}>
                {violations.length === 0 ? (
                  <div>✓ Full coverage with no constraint violations.</div>
                ) : (
                  <>
                    <div className="violations-title">{violations.length} constraint violation(s):</div>
                    <ul>
                      {violations.map((v, i) => (
                        <li key={i}>
                          <span className="violation-type">{v.type === "no_coverage" ? "No coverage" : "Consecutive-day limit relaxed"}</span>
                          {" — "}{v.message}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            {fairness && fairness.length > 0 && (
              <table className="shift-table" style={{ marginTop: 16 }}>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Total on-call days</th>
                    <th>Weekend days</th>
                  </tr>
                </thead>
                <tbody>
                  {fairness.map((f) => (
                    <tr key={f.userId}>
                      <td style={{ fontFamily: "var(--font-body)" }}>{f.name}</td>
                      <td>{f.totalDays}</td>
                      <td>{f.weekendDays}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="panel">
            <h2 className="panel-title">Shifts</h2>
            <details style={{ marginBottom: 16 }}>
              <summary style={{ cursor: "pointer", color: "var(--text-muted)", fontSize: 13 }}>
                Add a manual shift instead
              </summary>
              <form onSubmit={handleAddShift} className="form-row" style={{ marginTop: 12 }}>
                <div className="field">
                  <label>Responder</label>
                  <select value={shiftUserId} onChange={(e) => setShiftUserId(e.target.value)} required>
                    <option value="" disabled>Select...</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Starts</label>
                  <input type="datetime-local" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} required />
                </div>
                <div className="field">
                  <label>Ends</label>
                  <input type="datetime-local" value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} required />
                </div>
                <button className="btn btn-secondary" type="submit">Add shift</button>
              </form>
            </details>

            <table className="shift-table">
              <thead>
                <tr>
                  <th>Responder</th>
                  <th>Starts</th>
                  <th>Ends</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontFamily: "var(--font-body)" }}>{s.name}</td>
                    <td>{new Date(s.startsAt).toLocaleString()}</td>
                    <td>{new Date(s.endsAt).toLocaleString()}</td>
                    <td>{s.generatedByAlgorithm ? "algorithm" : "manual"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </Layout>
  );
}
