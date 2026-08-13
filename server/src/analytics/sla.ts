export interface IncidentWindow {
  firedAt: Date;
  resolvedAt: Date | null;
}

export interface SlaReport {
  windowDays: number;
  targetPercent: number;
  uptimePercent: number;
  downtimeMinutes: number;
  errorBudgetMinutes: number;
  errorBudgetConsumedPercent: number; // can exceed 100 if the budget was blown
  incidentCount: number;
}

// Pure function so it's testable in isolation, same reasoning as the Phase 3
// scheduling algorithm: no DB, no I/O, just "given these incidents and this
// window, what's the uptime?" — easy to assert against by hand.
//
// "Downtime" here means "time during which at least one incident was open"
// (firing or acknowledged, i.e. not yet resolved) — a simplification, since
// this data model has no notion of a "service" that could be partially
// degraded vs. fully down, or of overlapping incidents affecting different
// systems. Every open incident counts as full downtime for the whole org.
export function computeSlaReport(
  incidents: IncidentWindow[],
  windowStart: Date,
  windowEnd: Date,
  targetPercent: number
): SlaReport {
  const windowMs = windowEnd.getTime() - windowStart.getTime();
  const windowDays = windowMs / (1000 * 60 * 60 * 24);

  // Clip each incident's open interval to the window, then merge overlaps so
  // two incidents open at the same time don't get double-counted as downtime.
  const intervals = incidents
    .map((i) => {
      const start = Math.max(i.firedAt.getTime(), windowStart.getTime());
      const end = Math.min((i.resolvedAt ?? windowEnd).getTime(), windowEnd.getTime());
      return [start, end] as [number, number];
    })
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  let downtimeMs = 0;
  let mergedStart: number | null = null;
  let mergedEnd: number | null = null;

  for (const [start, end] of intervals) {
    if (mergedStart === null) {
      mergedStart = start;
      mergedEnd = end;
    } else if (start <= (mergedEnd as number)) {
      mergedEnd = Math.max(mergedEnd as number, end);
    } else {
      downtimeMs += (mergedEnd as number) - mergedStart;
      mergedStart = start;
      mergedEnd = end;
    }
  }
  if (mergedStart !== null) {
    downtimeMs += (mergedEnd as number) - mergedStart;
  }

  const downtimeMinutes = downtimeMs / 60000;
  const windowMinutes = windowMs / 60000;
  const uptimePercent = windowMinutes > 0 ? ((windowMinutes - downtimeMinutes) / windowMinutes) * 100 : 100;

  const errorBudgetMinutes = ((100 - targetPercent) / 100) * windowMinutes;
  const errorBudgetConsumedPercent =
    errorBudgetMinutes > 0 ? (downtimeMinutes / errorBudgetMinutes) * 100 : downtimeMinutes > 0 ? Infinity : 0;

  return {
    windowDays: Math.round(windowDays * 10) / 10,
    targetPercent,
    uptimePercent: Math.round(uptimePercent * 10000) / 10000,
    downtimeMinutes: Math.round(downtimeMinutes * 100) / 100,
    errorBudgetMinutes: Math.round(errorBudgetMinutes * 100) / 100,
    errorBudgetConsumedPercent: Math.round(errorBudgetConsumedPercent * 100) / 100,
    incidentCount: incidents.length,
  };
}
