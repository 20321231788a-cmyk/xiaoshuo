import { describe, expect, it } from "vitest";
import {
  compareCoordinates,
  isCoordinateWithin,
  MemoryGovernor,
  type NarrativeCoordinate,
  type CanonClaim,
  type UserOverride
} from "./memory-governor.js";

function userConfirmation(sourceRevision: number) {
  return {
    confirmationId: `confirm-${sourceRevision}`,
    actor: "user_ui" as const,
    sourceRevision,
    contentHash: "content-hash",
    confirmedAt: "2026-07-11T00:00:00.000Z"
  };
}

describe("MemoryGovernor and NarrativeCoordinate System", () => {
  describe("NarrativeCoordinate Sorting", () => {
    it("should sort coordinates based on chapter, section, and scene hierarchy", () => {
      const c1: NarrativeCoordinate = { chapter: 1 };
      const c2: NarrativeCoordinate = { chapter: 2 };
      const c3: NarrativeCoordinate = { chapter: 2, section: 1 };
      const c4: NarrativeCoordinate = { chapter: 2, section: 2 };
      const c5: NarrativeCoordinate = { chapter: 2, section: 2, scene: 1 };
      const c6: NarrativeCoordinate = { chapter: 2, section: 2, scene: 2 };

      const coords = [c6, c3, c1, c5, c2, c4];
      const sorted = [...coords].sort(compareCoordinates);

      expect(sorted).toEqual([c1, c2, c3, c4, c5, c6]);
    });
  });

  describe("Half-open intervals [from, to)", () => {
    it("should correctly identify if a coordinate is within a half-open interval", () => {
      const from: NarrativeCoordinate = { chapter: 2 };
      const to: NarrativeCoordinate = { chapter: 5 };
      const interval = { from, to };

      expect(isCoordinateWithin({ chapter: 1 }, interval)).toBe(false);
      expect(isCoordinateWithin({ chapter: 2 }, interval)).toBe(true);
      expect(isCoordinateWithin({ chapter: 3 }, interval)).toBe(true);
      expect(isCoordinateWithin({ chapter: 4, section: 9 }, interval)).toBe(true);
      expect(isCoordinateWithin({ chapter: 5 }, interval)).toBe(false);
      expect(isCoordinateWithin({ chapter: 6 }, interval)).toBe(false);
    });

    it("should support open boundaries", () => {
      const intervalFromOnly = { from: { chapter: 3 } };
      expect(isCoordinateWithin({ chapter: 2 }, intervalFromOnly)).toBe(false);
      expect(isCoordinateWithin({ chapter: 4 }, intervalFromOnly)).toBe(true);

      const intervalToOnly = { to: { chapter: 3 } };
      expect(isCoordinateWithin({ chapter: 2 }, intervalToOnly)).toBe(true);
      expect(isCoordinateWithin({ chapter: 3 }, intervalToOnly)).toBe(false);
    });
  });

  describe("Project UUID Isolation", () => {
    it("should isolate claims belonging to different project UUIDs", () => {
      const gov = new MemoryGovernor();
      const p1 = "project-uuid-1";
      const p2 = "project-uuid-2";

      const claim1: CanonClaim = {
        id: "claim-1",
        projectUuid: p1,
        subject: "陆尘",
        predicate: "role",
        object: "主角",
        interval: { from: { chapter: 1 } },
        status: "proposed",
        revision: 0
      };

      const claim2: CanonClaim = {
        id: "claim-2",
        projectUuid: p2,
        subject: "林风",
        predicate: "role",
        object: "配角",
        interval: { from: { chapter: 1 } },
        status: "proposed",
        revision: 0
      };

      gov.addClaim(claim1);
      gov.addClaim(claim2);
      gov.confirmClaim(p1, claim1.id, userConfirmation(0));
      gov.confirmClaim(p2, claim2.id, userConfirmation(0));

      const claimsP1 = gov.getClaims(p1);
      const claimsP2 = gov.getClaims(p2);

      expect(claimsP1).toHaveLength(1);
      expect(claimsP1[0]!.id).toBe("claim-1");

      expect(claimsP2).toHaveLength(1);
      expect(claimsP2[0]!.id).toBe("claim-2");

    });

    it("rejects model drafts that attempt to enter confirmed memory directly", () => {
      const gov = new MemoryGovernor();
      const claim: CanonClaim = {
        id: "claim-confirmed-direct",
        projectUuid: "project-uuid-1",
        subject: "陆尘",
        predicate: "role",
        object: "主角",
        interval: {},
        status: "confirmed",
        revision: 0
      };

      try {
        gov.addClaim(claim);
        throw new Error("Expected confirmed-memory rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: "CONFIRMED_MEMORY_REQUIRES_USER_CONFIRMATION" });
      }
      gov.addClaim({ ...claim, status: "draft" });
      gov.confirmClaim(claim.projectUuid, claim.id, userConfirmation(0));
      expect(gov.getClaims(claim.projectUuid)[0]?.status).toBe("confirmed");
    });
  });

  describe("User Override Revisions and Re-baselining", () => {
    it("should apply override revisions incrementally and bump revision version without modifying baseline", () => {
      const gov = new MemoryGovernor();
      const p1 = "project-uuid-1";

      const claim: CanonClaim = {
        id: "claim-1",
        projectUuid: p1,
        subject: "陆尘",
        predicate: "power",
        object: "练气期",
        interval: { from: { chapter: 1 }, to: { chapter: 10 } },
        status: "proposed",
        revision: 0
      };

      gov.addClaim(claim);
      gov.confirmClaim(p1, claim.id, userConfirmation(0));

      const overrides: UserOverride[] = [
        {
          claimId: "claim-1",
          overrideObject: "筑基期",
          overrideStatus: "confirmed"
        }
      ];

       const view = gov.applyOverrides(p1, overrides);
      expect(view).toHaveLength(1);
      expect(view[0]!.object).toBe("筑基期");
      expect(view[0]!.revision).toBe(2);

      // Verify original baseline is unmodified
      const baseline = gov.getClaims(p1);
      expect(baseline[0]!.object).toBe("练气期");
      expect(baseline[0]!.revision).toBe(1);

    });

    it("should solidify overrides into the baseline and increment version on rebaselining", () => {
      const gov = new MemoryGovernor();
      const p1 = "project-uuid-1";

      const claim: CanonClaim = {
        id: "claim-1",
        projectUuid: p1,
        subject: "林风",
        predicate: "weapon",
        object: "无",
        interval: { from: { chapter: 1 } },
        status: "planned",
        revision: 1
      };

      gov.addClaim(claim);

      const overrides: UserOverride[] = [
        {
          claimId: "claim-1",
          overrideObject: "天心剑",
          overrideStatus: "confirmed",
          overrideInterval: { from: { chapter: 2 } }
        }
      ];

      gov.rebaseline(p1, overrides, userConfirmation(1));

      const baseline = gov.getClaims(p1);
      expect(baseline).toHaveLength(1);
      expect(baseline[0]!.object).toBe("天心剑");
      expect(baseline[0]!.status).toBe("confirmed");
      expect(baseline[0]!.interval.from!.chapter).toBe(2);
      expect(baseline[0]!.revision).toBe(2); // bumped revision
    });

    it("should shift intervals correctly during timeline revisions re-baselining", () => {
      const gov = new MemoryGovernor();
      const p1 = "project-uuid-1";

      const claim: CanonClaim = {
        id: "claim-1",
        projectUuid: p1,
        subject: "陆尘",
        predicate: "location",
        object: "青云宗",
        interval: { from: { chapter: 5 }, to: { chapter: 10 } },
        status: "proposed",
        revision: 0
      };

      gov.addClaim(claim);
      gov.confirmClaim(p1, claim.id, userConfirmation(0));

      // Shift timeline by 2 chapters starting from chapter 4
      gov.shiftTimeline(p1, 4, 2);

      const baseline = gov.getClaims(p1);
      expect(baseline[0]!.interval.from!.chapter).toBe(7); // 5 + 2 = 7
      expect(baseline[0]!.interval.to!.chapter).toBe(12); // 10 + 2 = 12

    });
  });
});
