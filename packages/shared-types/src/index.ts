// Shared types used by both server and client, so the wire format can't drift.
// Phase 1 covers auth, orgs, users, manual on-call assignment, and incidents.
// Fields that only get populated in later phases (embeddingVector, generatedByAI, etc.)
// are already modeled here so the schema doesn't need to change shape later.

export type Role = "admin" | "responder" | "viewer";

export type IncidentStatus = "firing" | "acknowledged" | "resolved";

export type NotificationChannel = "sms" | "email";

export interface Org {
  id: string;
  name: string;
  plan: string;
  createdAt: string;
}

export interface User {
  id: string;
  orgId: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  createdAt: string;
}

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  role: Role;
}

export interface Schedule {
  id: string;
  orgId: string;
  name: string;
  rotationLengthDays: number;
  maxConsecutiveDays: number;
  blackoutDates: string[]; // ISO dates, per-schedule for Phase 1; per-user in Phase 3
  createdAt: string;
}

export interface ScheduleShift {
  id: string;
  scheduleId: string;
  userId: string;
  startsAt: string;
  endsAt: string;
  // Phase 1: shifts are created manually by an admin.
  // Phase 3: this becomes the output of the constraint-based scheduling algorithm.
  generatedByAlgorithm: boolean;
}

export interface EscalationStep {
  userId: string;
  timeoutMinutes: number;
  channel: NotificationChannel;
}

export interface EscalationPolicy {
  id: string;
  orgId: string;
  name: string;
  steps: EscalationStep[];
  createdAt: string;
}

export interface Incident {
  id: string;
  orgId: string;
  idempotencyKey: string;
  title: string;
  description: string;
  status: IncidentStatus;
  assignedUserId: string | null;
  firedAt: string;
  ackedAt: string | null;
  resolvedAt: string | null;
  // Phase 4: which escalation policy (if any) pages/re-pages this incident,
  // and how far through its steps the worker has gotten.
  escalationPolicyId?: string | null;
  currentEscalationStep?: number;
  // Populated starting Phase 5 (RAG embeddings). Omitted from API responses until then.
  embeddingVector?: number[] | null;
}

export type IncidentEventType =
  | "fired"
  | "paged"
  | "escalated"
  | "acknowledged"
  | "resolved"
  | "note";

export interface IncidentEvent {
  id: string;
  incidentId: string;
  type: IncidentEventType;
  actorId: string | null; // null for system-generated events
  message: string | null;
  timestamp: string;
}

export interface Postmortem {
  id: string;
  incidentId: string;
  content: string;
  generatedByAI: boolean;
  createdAt: string;
}

// ---- Phase 3: constraint-based rotation generator ----

export interface ScheduleMember {
  id: string;
  scheduleId: string;
  userId: string;
  name: string; // joined in from users for display
  blackoutDates: string[]; // ISO dates this person is unavailable — hard constraint
}

export type RotationViolationType =
  | "no_coverage" // every member was blacked out that day — genuinely unfillable
  | "max_consecutive_relaxed"; // had to exceed maxConsecutiveDays because no one else was available

export interface RotationViolation {
  date: string; // ISO date the violation occurred on
  type: RotationViolationType;
  message: string;
}

export interface FairnessReportEntry {
  userId: string;
  name: string;
  totalDays: number;
  weekendDays: number;
}

export interface GenerateRotationRequest {
  startDate: string; // ISO date, inclusive
  endDate: string; // ISO date, exclusive
}

export interface GenerateRotationResponse {
  shifts: ScheduleShift[];
  violations: RotationViolation[];
  fairnessReport: FairnessReportEntry[];
}

// ---- Phase 5: RAG-based incident triage ----

export interface SimilarIncidentSummary {
  incidentId: string;
  title: string;
  similarity: number; // 0-1, higher = more similar
  resolvedAt: string | null;
}

export type TriageSuggestion =
  | { status: "pending" }
  | {
      status: "ready";
      summary: string;
      similarIncidents: SimilarIncidentSummary[];
      createdAt: string;
    };

// ---- API request/response shapes ----

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  orgName: string;
  name: string;
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface CreateIncidentRequest {
  idempotencyKey: string;
  title: string;
  description: string;
  scheduleId?: string;
  escalationPolicyId?: string;
}

export interface CreateEscalationPolicyRequest {
  name: string;
  steps: EscalationStep[];
}

export interface ApiError {
  error: string;
  details?: unknown;
}
