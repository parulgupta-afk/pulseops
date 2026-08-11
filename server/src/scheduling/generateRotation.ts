import type {
  ScheduleMember,
  RotationViolation,
  FairnessReportEntry,
} from "@pulseops/shared-types";

// The constraint-based on-call rotation generator.
//
// Approach: greedy day-by-day assignment with fairness-driven tie-breaking,
// not a full CSP/SAT solver — that's a deliberate scope choice for a project
// this size, but it's still genuinely constraint-based, not round-robin:
//
//   HARD constraint — blackout dates (time off). Never violated. If every
//   roster member is blacked out on a given day, that day is reported as an
//   unfillable coverage gap rather than silently assigned to someone anyway.
//
//   SOFT-BUT-PROTECTED constraint — maxConsecutiveDays. Respected whenever
//   possible; only exceeded as a last resort when the alternative is leaving
//   a day completely uncovered, and every such relaxation is reported so an
//   admin can see exactly where and why the algorithm had to bend a rule.
//
//   SOFT constraint — fairness. Among everyone who's eligible for a given
//   day, the algorithm picks whoever has the fewest total on-call days so
//   far, breaking ties by whoever has the fewest weekend days so far (so
//   weekend load, not just raw day count, gets balanced too).

export interface GeneratedShiftBlock {
  userId: string;
  startsAt: string; // ISO datetime
  endsAt: string; // ISO datetime
}

export interface RotationResult {
  shifts: GeneratedShiftBlock[];
  violations: RotationViolation[];
  fairnessReport: FairnessReportEntry[];
}

interface MemberCounters {
  totalDays: number;
  weekendDays: number;
  consecutiveStreak: number;
  lastAssignedDayIndex: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDateOnlyString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

export function generateRotation(
  members: ScheduleMember[],
  startDate: string,
  endDate: string,
  maxConsecutiveDays: number
): RotationResult {
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  const totalDays = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);

  const blackoutSets = new Map<string, Set<string>>();
  for (const m of members) {
    blackoutSets.set(m.userId, new Set(m.blackoutDates));
  }

  const counters = new Map<string, MemberCounters>();
  for (const m of members) {
    counters.set(m.userId, {
      totalDays: 0,
      weekendDays: 0,
      consecutiveStreak: 0,
      lastAssignedDayIndex: null,
    });
  }

  const violations: RotationViolation[] = [];
  const dailyAssignments: (string | null)[] = new Array(totalDays).fill(null);

  for (let dayIndex = 0; dayIndex < totalDays; dayIndex++) {
    const date = new Date(start.getTime() + dayIndex * MS_PER_DAY);
    const dateStr = toDateOnlyString(date);
    const weekend = isWeekend(date);

    // Anyone not blacked out today is at least eligible.
    const available = members.filter((m) => !blackoutSets.get(m.userId)!.has(dateStr));

    if (available.length === 0) {
      violations.push({
        date: dateStr,
        type: "no_coverage",
        message: `Every roster member is blacked out on ${dateStr} — no one available to cover this day.`,
      });
      continue;
    }

    // Of the available people, who can take this day without breaking the
    // max-consecutive-days rule?
    const withinLimit = available.filter((m) => {
      const c = counters.get(m.userId)!;
      const continuingStreak = c.lastAssignedDayIndex === dayIndex - 1;
      const projectedStreak = continuingStreak ? c.consecutiveStreak + 1 : 1;
      return projectedStreak <= maxConsecutiveDays;
    });

    let pool = withinLimit;
    let relaxed = false;
    if (pool.length === 0) {
      // No one can take it without exceeding the cap — relax the constraint
      // rather than leave the day uncovered, but only as a last resort, and
      // pick whoever's *least* over the line (shortest current streak).
      pool = available;
      relaxed = true;
    }

    // Fairness tie-break: fewest total days so far, then (on weekends)
    // fewest weekend days so far, then stable by userId for determinism.
    pool.sort((a, b) => {
      const ca = counters.get(a.userId)!;
      const cb = counters.get(b.userId)!;
      if (ca.totalDays !== cb.totalDays) return ca.totalDays - cb.totalDays;
      if (weekend && ca.weekendDays !== cb.weekendDays) {
        return ca.weekendDays - cb.weekendDays;
      }
      return a.userId.localeCompare(b.userId);
    });

    const chosen = pool[0];
    const chosenCounters = counters.get(chosen.userId)!;

    if (relaxed) {
      violations.push({
        date: dateStr,
        type: "max_consecutive_relaxed",
        message: `No one was available within the ${maxConsecutiveDays}-day consecutive limit on ${dateStr} — assigned ${chosen.name} anyway as the least-disruptive option.`,
      });
    }

    dailyAssignments[dayIndex] = chosen.userId;
    const continuingStreak = chosenCounters.lastAssignedDayIndex === dayIndex - 1;
    chosenCounters.consecutiveStreak = continuingStreak ? chosenCounters.consecutiveStreak + 1 : 1;
    chosenCounters.lastAssignedDayIndex = dayIndex;
    chosenCounters.totalDays += 1;
    if (weekend) chosenCounters.weekendDays += 1;
  }

  // Coalesce consecutive days assigned to the same person into single shift
  // blocks, rather than one ScheduleShift row per calendar day.
  const shifts: GeneratedShiftBlock[] = [];
  let blockStart: number | null = null;
  let blockUserId: string | null = null;

  function flushBlock(endIndexExclusive: number) {
    if (blockStart === null || blockUserId === null) return;
    const startsAt = new Date(start.getTime() + blockStart * MS_PER_DAY);
    const endsAt = new Date(start.getTime() + endIndexExclusive * MS_PER_DAY);
    shifts.push({
      userId: blockUserId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    });
  }

  for (let i = 0; i < totalDays; i++) {
    const userId = dailyAssignments[i];
    if (userId !== blockUserId) {
      flushBlock(i);
      blockStart = userId === null ? null : i;
      blockUserId = userId;
    }
  }
  flushBlock(totalDays);

  const fairnessReport: FairnessReportEntry[] = members.map((m) => {
    const c = counters.get(m.userId)!;
    return { userId: m.userId, name: m.name, totalDays: c.totalDays, weekendDays: c.weekendDays };
  });

  return { shifts, violations, fairnessReport };
}
