import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Mirrors the status transition rules enforced in incidents.routes.ts:
 *   firing → acknowledged → resolved
 *   firing → resolved (ack is optional)
 * Invalid: resolved → anything, acknowledged → firing, etc.
 *
 * Extracted as pure logic so unit tests lock the state machine without a DB.
 */
type IncidentStatus = "firing" | "acknowledged" | "resolved";

function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  if (from === "resolved") return false;
  if (to === "firing") return false;
  if (from === "firing" && (to === "acknowledged" || to === "resolved")) return true;
  if (from === "acknowledged" && to === "resolved") return true;
  return false;
}

describe("incident state transitions", () => {
  it("allows firing → acknowledged", () => {
    assert.equal(canTransition("firing", "acknowledged"), true);
  });

  it("allows firing → resolved", () => {
    assert.equal(canTransition("firing", "resolved"), true);
  });

  it("allows acknowledged → resolved", () => {
    assert.equal(canTransition("acknowledged", "resolved"), true);
  });

  it("rejects resolved → acknowledged", () => {
    assert.equal(canTransition("resolved", "acknowledged"), false);
  });

  it("rejects resolved → firing", () => {
    assert.equal(canTransition("resolved", "firing"), false);
  });

  it("rejects acknowledged → firing", () => {
    assert.equal(canTransition("acknowledged", "firing"), false);
  });

  it("rejects same-state no-ops as transitions", () => {
    assert.equal(canTransition("firing", "firing"), false);
    assert.equal(canTransition("acknowledged", "acknowledged"), false);
    assert.equal(canTransition("resolved", "resolved"), false);
  });
});
