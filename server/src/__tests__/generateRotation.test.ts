import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateRotation } from "../scheduling/generateRotation";
import type { ScheduleMember } from "@pulseops/shared-types";

function member(id: string, name: string, blackoutDates: string[] = []): ScheduleMember {
  return { userId: id, name, blackoutDates };
}

describe("generateRotation", () => {
  it("covers every day with a balanced 3-person roster and respects blackouts", () => {
    const members = [
      member("a", "Alice", ["2026-08-12"]),
      member("b", "Bob", []),
      member("c", "Carol", ["2026-08-15"]),
    ];
    const result = generateRotation(members, "2026-08-10", "2026-08-20", 7);

    // 10 days: 2026-08-10 .. 2026-08-19 inclusive
    const totalAssigned = result.fairnessReport.reduce((s, e) => s + e.totalDays, 0);
    assert.equal(totalAssigned, 10);

    // Alice must not be on 2026-08-12
    for (const shift of result.shifts) {
      if (shift.userId === "a") {
        const start = shift.startsAt.slice(0, 10);
        const end = shift.endsAt.slice(0, 10);
        assert.ok(start !== "2026-08-12");
        // endsAt is exclusive day boundary in ISO; just ensure blackout day isn't interior
        assert.ok(!(start < "2026-08-12" && end > "2026-08-12"));
      }
    }

    // No no_coverage violations when at least one person is free each day
    assert.equal(
      result.violations.filter((v) => v.type === "no_coverage").length,
      0
    );

    // Fairness: each person should get roughly 3–4 days
    for (const entry of result.fairnessReport) {
      assert.ok(entry.totalDays >= 2 && entry.totalDays <= 5, `${entry.name} got ${entry.totalDays}`);
    }
  });

  it("reports no_coverage when everyone is blacked out on the same day", () => {
    const members = [
      member("a", "Alice", ["2026-08-11"]),
      member("b", "Bob", ["2026-08-11"]),
    ];
    const result = generateRotation(members, "2026-08-10", "2026-08-13", 7);
    const gaps = result.violations.filter((v) => v.type === "no_coverage");
    assert.ok(gaps.some((v) => v.date === "2026-08-11"));
  });

  it("relaxes maxConsecutiveDays rather than leaving a day uncovered", () => {
    // Single person, maxConsecutiveDays=1 over 3 days → must relax on day 2+
    const members = [member("solo", "Solo")];
    const result = generateRotation(members, "2026-08-10", "2026-08-13", 1);
    assert.equal(result.fairnessReport[0].totalDays, 3);
    assert.ok(result.violations.some((v) => v.type === "max_consecutive_relaxed"));
  });

  it("returns empty shifts for an empty roster", () => {
    const result = generateRotation([], "2026-08-10", "2026-08-12", 7);
    assert.equal(result.shifts.length, 0);
    assert.ok(result.violations.every((v) => v.type === "no_coverage"));
  });
});
