import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeSlaReport, type IncidentWindow } from "../analytics/sla";

describe("computeSlaReport", () => {
  const windowStart = new Date("2026-01-01T00:00:00Z");
  const windowEnd = new Date("2026-01-02T00:00:00Z"); // 24h = 1440 minutes

  it("reports 100% uptime with no incidents", () => {
    const report = computeSlaReport([], windowStart, windowEnd, 99.9);
    assert.equal(report.uptimePercent, 100);
    assert.equal(report.downtimeMinutes, 0);
    assert.equal(report.incidentCount, 0);
    assert.equal(report.errorBudgetConsumedPercent, 0);
  });

  it("counts a single closed incident as downtime", () => {
    const incidents: IncidentWindow[] = [
      {
        firedAt: new Date("2026-01-01T10:00:00Z"),
        resolvedAt: new Date("2026-01-01T11:00:00Z"), // 60 min
      },
    ];
    const report = computeSlaReport(incidents, windowStart, windowEnd, 99.9);
    assert.equal(report.downtimeMinutes, 60);
    assert.ok(report.uptimePercent < 100);
    assert.equal(report.incidentCount, 1);
  });

  it("merges overlapping incidents so downtime is not double-counted", () => {
    // Two incidents open 10:00–12:00 and 11:00–13:00 → merged 10:00–13:00 = 180 min
    const incidents: IncidentWindow[] = [
      {
        firedAt: new Date("2026-01-01T10:00:00Z"),
        resolvedAt: new Date("2026-01-01T12:00:00Z"),
      },
      {
        firedAt: new Date("2026-01-01T11:00:00Z"),
        resolvedAt: new Date("2026-01-01T13:00:00Z"),
      },
    ];
    const report = computeSlaReport(incidents, windowStart, windowEnd, 99.9);
    assert.equal(report.downtimeMinutes, 180);
    assert.equal(report.incidentCount, 2);
  });

  it("clips open (unresolved) incidents to the window end", () => {
    const incidents: IncidentWindow[] = [
      {
        firedAt: new Date("2026-01-01T23:00:00Z"),
        resolvedAt: null, // still open → 60 min until window end
      },
    ];
    const report = computeSlaReport(incidents, windowStart, windowEnd, 99.9);
    assert.equal(report.downtimeMinutes, 60);
  });

  it("ignores incidents entirely outside the window", () => {
    const incidents: IncidentWindow[] = [
      {
        firedAt: new Date("2025-12-01T00:00:00Z"),
        resolvedAt: new Date("2025-12-01T05:00:00Z"),
      },
    ];
    const report = computeSlaReport(incidents, windowStart, windowEnd, 99.9);
    assert.equal(report.downtimeMinutes, 0);
    assert.equal(report.uptimePercent, 100);
  });
});
