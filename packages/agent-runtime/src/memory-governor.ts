export interface NarrativeCoordinate {
  chapter: number;
  section?: number;
  scene?: number;
}

export interface CoordinateInterval {
  from?: NarrativeCoordinate;
  to?: NarrativeCoordinate;
}

export interface CanonClaim {
  id: string;
  projectUuid: string;
  subject: string;
  predicate: string;
  object: string;
  interval: CoordinateInterval;
  status: "confirmed" | "planned" | "superseded";
  revision: number;
}

export interface UserOverride {
  claimId: string;
  overrideObject?: string;
  overrideStatus?: "confirmed" | "planned" | "superseded";
  overrideInterval?: CoordinateInterval;
}

export function compareCoordinates(a: NarrativeCoordinate, b: NarrativeCoordinate): number {
  if (a.chapter !== b.chapter) {
    return a.chapter - b.chapter;
  }
  const aSec = a.section ?? 0;
  const bSec = b.section ?? 0;
  if (aSec !== bSec) {
    return aSec - bSec;
  }
  const aScene = a.scene ?? 0;
  const bScene = b.scene ?? 0;
  return aScene - bScene;
}

export function isCoordinateWithin(
  coord: NarrativeCoordinate,
  interval: CoordinateInterval
): boolean {
  if (interval.from) {
    if (compareCoordinates(coord, interval.from) < 0) {
      return false;
    }
  }
  if (interval.to) {
    if (compareCoordinates(coord, interval.to) >= 0) {
      return false;
    }
  }
  return true;
}

export class MemoryGovernor {
  private claims: Map<string, CanonClaim> = new Map();

  constructor() {}

  /**
   * 添加一个 CanonClaim
   */
  addClaim(claim: CanonClaim): void {
    this.claims.set(claim.id, {
      ...claim,
      interval: {
        from: claim.interval.from ? { ...claim.interval.from } : undefined,
        to: claim.interval.to ? { ...claim.interval.to } : undefined
      }
    });
  }

  /**
   * 获取指定项目的原始 CanonClaim 列表
   */
  getClaims(projectUuid: string): CanonClaim[] {
    return Array.from(this.claims.values())
      .filter((c) => c.projectUuid === projectUuid)
      .map((c) => this.cloneClaim(c));
  }

  /**
   * 获取应用用户覆盖修正后的 claims 视图（不修改原始数据）
   */
  applyOverrides(projectUuid: string, overrides: UserOverride[]): CanonClaim[] {
    const projectClaims = this.getClaims(projectUuid);
    const claimMap = new Map(projectClaims.map((c) => [c.id, c]));

    for (const ovr of overrides) {
      const claim = claimMap.get(ovr.claimId);
      if (claim) {
        if (ovr.overrideObject !== undefined) {
          claim.object = ovr.overrideObject;
        }
        if (ovr.overrideStatus !== undefined) {
          claim.status = ovr.overrideStatus;
        }
        if (ovr.overrideInterval !== undefined) {
          claim.interval = {
            from: ovr.overrideInterval.from ? { ...ovr.overrideInterval.from } : undefined,
            to: ovr.overrideInterval.to ? { ...ovr.overrideInterval.to } : undefined
          };
        }
        claim.revision += 1;
      }
    }

    return Array.from(claimMap.values());
  }

  /**
   * 将覆盖修正彻底合并至正典中，重构为新的基准版本
   */
  rebaseline(projectUuid: string, overrides: UserOverride[]): void {
    for (const ovr of overrides) {
      const claim = this.claims.get(ovr.claimId);
      if (claim && claim.projectUuid === projectUuid) {
        if (ovr.overrideObject !== undefined) {
          claim.object = ovr.overrideObject;
        }
        if (ovr.overrideStatus !== undefined) {
          claim.status = ovr.overrideStatus;
        }
        if (ovr.overrideInterval !== undefined) {
          claim.interval = {
            from: ovr.overrideInterval.from ? { ...ovr.overrideInterval.from } : undefined,
            to: ovr.overrideInterval.to ? { ...ovr.overrideInterval.to } : undefined
          };
        }
        claim.revision += 1;
      }
    }
  }

  /**
   * 时间线平移：当在 fromChapter 处插入或删除章节时，平移所有 claims 的时间区间
   */
  shiftTimeline(projectUuid: string, fromChapter: number, shiftAmount: number): void {
    for (const claim of this.claims.values()) {
      if (claim.projectUuid !== projectUuid) {
        continue;
      }
      if (claim.interval.from && claim.interval.from.chapter >= fromChapter) {
        claim.interval.from.chapter += shiftAmount;
      }
      if (claim.interval.to && claim.interval.to.chapter >= fromChapter) {
        claim.interval.to.chapter += shiftAmount;
      }
    }
  }

  private cloneClaim(c: CanonClaim): CanonClaim {
    return {
      ...c,
      interval: {
        from: c.interval.from ? { ...c.interval.from } : undefined,
        to: c.interval.to ? { ...c.interval.to } : undefined
      }
    };
  }
}
