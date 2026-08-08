import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../components/Layout";
import { api } from "../api/client";
import type { Schedule, ScheduleShift, User } from "@pulseops/shared-types";

// Phase 1: admins assign shifts one at a time by picking a person and a time
// range. Phase 3 replaces the "add shift" form with a "generate rotation"
// button that runs the constraint-based scheduling algorithm instead.
export function SchedulePage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shifts, setShifts] = useState<(ScheduleShift & { name: string })[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [currentOncall, setCurrentOncall] = useState<{ name: string } | null>(null);

  const [newScheduleName, setNewScheduleName] = useState("");
  const [shiftUserId, setShiftUserId] = useState("");
  const [shiftStart, setShiftStart] = useState("");
  const [shiftEnd, setShiftEnd] = useState("");

  useEffect(() => {
    api.get<Schedule[]>("/schedules").then(({ data }) => {
      setSchedules(data);
      if (data.length > 0) setSelectedId(data[0].id);
    });
    api.get<User[]>("/users").then(({ data }) => setUsers(data));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    api.get(`/schedules/${selectedId}/shifts`).then(({ data }) => setShifts(data));
    api
      .get(`/schedules/${selectedId}/current-oncall`)
      .then(({ data }) => setCurrentOncall(data))
      .catch(() => setCurrentOncall(null));
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
    const { data } = await api.get(`/schedules/${selectedId}/shifts`);
    setShifts(data);
    api.get(`/schedules/${selectedId}/current-oncall`).then(({ data }) => setCurrentOncall(data)).catch(() => {});
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1 className="page-title">On-call schedule</h1>
          <p className="page-subtitle">
            Manual assignment for now — the constraint-based rotation generator lands in Phase 3.
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
              <div className="oncall-name">{currentOncall ? currentOncall.name : "Nobody — add a shift below"}</div>
            </div>
          </div>

          <form onSubmit={handleAddShift} className="form-row">
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
            <button className="btn btn-primary" type="submit">Add shift</button>
          </form>

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
        </>
      )}
    </Layout>
  );
}
