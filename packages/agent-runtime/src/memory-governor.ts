export interface LegacyNarrativeCoordinate {
  chapter: number;
  section?: number;
  scene?: number;
}

/**
 * Stable narrative coordinate for governed memory. `ordinal` is comparable
 * only within the same timeline revision; callers must rebase through the
 * anchor registry before comparing different revisions.
 */
export interface TimelineNarrativeCoordinate {
  schemaVersion: 1;
  timelineId: string;
  anchorId: string;
  ordinal: number;
  timelineRevision: number;
  phase: "before" | "at" | "after";
}

export type NarrativeCoordinate = LegacyNarrativeCoordinate | TimelineNarrativeCoordinate;

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
  status: "draft" | "proposed" | "confirmed" | "planned" | "rejected" | "superseded";
  revision: number;
  /** Stable source identity and version used to invalidate derived memory. */
  sourceRef?: string;
  sourceRevision?: string;
  evidenceRefs?: string[];
  perspective?: "objective" | "narrator" | "character" | "rumor";
  perspectiveEntityId?: string;
  confidence?: number;
  storyTime?: NarrativeCoordinate;
}

export interface UserOverride {
  claimId: string;
  overrideObject?: string;
  overrideStatus?: CanonClaim["status"];
  overrideInterval?: CoordinateInterval;
}

export type MemoryConfirmation = {
  confirmationId: string;
  actor: "user_ui";
  sourceRevision: number;
  contentHash: string;
  confirmedAt: string;
};

export const confirmedMemoryRequiresUserConfirmationCode = "CONFIRMED_MEMORY_REQUIRES_USER_CONFIRMATION";

export class ConfirmedMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmedMemoryError";
    Object.assign(this, { code: confirmedMemoryRequiresUserConfirmationCode });
  }
}

export class NarrativeCoordinateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarrativeCoordinateError";
    Object.assign(this, { code: "MEMORY_NARRATIVE_COORDINATE_INVALID" });
  }
}

export function compareCoordinates(a: NarrativeCoordinate, b: NarrativeCoordinate): number {
  if (isTimelineNarrativeCoordinate(a) || isTimelineNarrativeCoordinate(b)) {
    if (!isTimelineNarrativeCoordinate(a) || !isTimelineNarrativeCoordinate(b)) {
      throw new NarrativeCoordinateError("不能比较 legacy chapter coordinate 与 timeline coordinate");
    }
    if (a.timelineId !== b.timelineId || a.timelineRevision !== b.timelineRevision) {
      throw new NarrativeCoordinateError("不同 timeline 或 timeline revision 必须先通过 anchor registry 重基准");
    }
    if (a.ordinal !== b.ordinal) {
      return a.ordinal - b.ordinal;
    }
    return phaseOrder(a.phase) - phaseOrder(b.phase);
  }
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

export function validateNarrativeCoordinate(value: unknown): NarrativeCoordinate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NarrativeCoordinateError("narrative coordinate 必须是对象");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion === 1 || raw.timelineId !== undefined || raw.timelineRevision !== undefined) {
    const phase = raw.phase;
    if (
      raw.schemaVersion !== 1 ||
      !nonEmptyText(raw.timelineId) ||
      !nonEmptyText(raw.anchorId) ||
      !Number.isInteger(raw.ordinal) ||
      !Number.isInteger(raw.timelineRevision) ||
      (phase !== "before" && phase !== "at" && phase !== "after")
    ) {
      throw new NarrativeCoordinateError("timeline coordinate 缺少稳定 anchor、ordinal、revision 或 phase");
    }
    return {
      schemaVersion: 1,
      timelineId: String(raw.timelineId),
      anchorId: String(raw.anchorId),
      ordinal: Number(raw.ordinal),
      timelineRevision: Number(raw.timelineRevision),
      phase
    };
  }
  if (!Number.isInteger(raw.chapter) || Number(raw.chapter) < 0 ||
    (raw.section !== undefined && (!Number.isInteger(raw.section) || Number(raw.section) < 0)) ||
    (raw.scene !== undefined && (!Number.isInteger(raw.scene) || Number(raw.scene) < 0))) {
    throw new NarrativeCoordinateError("legacy chapter coordinate 无效");
  }
  return {
    chapter: Number(raw.chapter),
    section: raw.section === undefined ? undefined : Number(raw.section),
    scene: raw.scene === undefined ? undefined : Number(raw.scene)
  };
}

export function validateCoordinateInterval(value: unknown): CoordinateInterval {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NarrativeCoordinateError("coordinate interval 必须是对象");
  }
  const raw = value as Record<string, unknown>;
  const interval = {
    from: raw.from === undefined ? undefined : validateNarrativeCoordinate(raw.from),
    to: raw.to === undefined ? undefined : validateNarrativeCoordinate(raw.to)
  };
  if (interval.from && interval.to && compareCoordinates(interval.from, interval.to) >= 0) {
    throw new NarrativeCoordinateError("coordinate interval 必须是半开区间 [from, to) 且 from < to");
  }
  return interval;
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
    if (claim.status === "confirmed") {
      throw new ConfirmedMemoryError("模型或 workflow 不能直接创建 confirmed memory；请先保存为 draft/proposed 并执行用户二次确认。");
    }
    this.claims.set(claim.id, {
      ...claim,
      evidenceRefs: claim.evidenceRefs ? [...claim.evidenceRefs] : undefined,
      storyTime: claim.storyTime ? cloneCoordinate(claim.storyTime) : undefined,
      interval: cloneInterval(claim.interval)
    });
  }

  /** The only promotion path into confirmed memory. */
  confirmClaim(projectUuid: string, claimId: string, confirmation: MemoryConfirmation): void {
    this.assertUserConfirmation(confirmation);
    const claim = this.claims.get(claimId);
    if (!claim || claim.projectUuid !== projectUuid) {
      throw new Error("未找到当前项目的 memory claim");
    }
    if (claim.status === "confirmed") {
      return;
    }
    if (claim.status !== "draft" && claim.status !== "proposed" && claim.status !== "planned") {
      throw new ConfirmedMemoryError("只有 draft/proposed memory 可以确认进入 confirmed");
    }
    if (confirmation.sourceRevision !== claim.revision) {
      throw new ConfirmedMemoryError("memory confirmation 的 source revision 已过期");
    }
    claim.status = "confirmed";
    claim.revision += 1;
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
  rebaseline(projectUuid: string, overrides: UserOverride[], confirmation?: MemoryConfirmation): void {
    for (const ovr of overrides) {
      const claim = this.claims.get(ovr.claimId);
      if (claim && claim.projectUuid === projectUuid) {
        if (ovr.overrideStatus === "confirmed" && claim.status !== "confirmed") {
          this.assertUserConfirmation(confirmation);
          if (confirmation!.sourceRevision !== claim.revision) {
            throw new ConfirmedMemoryError("memory confirmation 的 source revision 已过期");
          }
        }
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
      if (isLegacyNarrativeCoordinate(claim.interval.from) && claim.interval.from.chapter >= fromChapter) {
        claim.interval.from.chapter += shiftAmount;
      }
      if (isLegacyNarrativeCoordinate(claim.interval.to) && claim.interval.to.chapter >= fromChapter) {
        claim.interval.to.chapter += shiftAmount;
      }
    }
  }

  private cloneClaim(c: CanonClaim): CanonClaim {
    return {
      ...c,
      evidenceRefs: c.evidenceRefs ? [...c.evidenceRefs] : undefined,
      storyTime: c.storyTime ? cloneCoordinate(c.storyTime) : undefined,
      interval: cloneInterval(c.interval)
    };
  }

  private assertUserConfirmation(confirmation: MemoryConfirmation | undefined): asserts confirmation is MemoryConfirmation {
    if (
      !confirmation
      || confirmation.actor !== "user_ui"
      || !confirmation.confirmationId.trim()
      || !confirmation.contentHash.trim()
      || !confirmation.confirmedAt.trim()
      || !Number.isInteger(confirmation.sourceRevision)
      || confirmation.sourceRevision < 0
    ) {
      throw new ConfirmedMemoryError("confirmed memory 需要有效的用户二次确认事件");
    }
  }
}

export function isTimelineNarrativeCoordinate(value: NarrativeCoordinate | undefined): value is TimelineNarrativeCoordinate {
  return Boolean(value && "timelineId" in value);
}

export function isLegacyNarrativeCoordinate(value: NarrativeCoordinate | undefined): value is LegacyNarrativeCoordinate {
  return Boolean(value && "chapter" in value);
}

function cloneCoordinate(value: NarrativeCoordinate): NarrativeCoordinate {
  return isTimelineNarrativeCoordinate(value) ? { ...value } : { ...value };
}

function cloneInterval(interval: CoordinateInterval): CoordinateInterval {
  return {
    from: interval.from ? cloneCoordinate(interval.from) : undefined,
    to: interval.to ? cloneCoordinate(interval.to) : undefined
  };
}

function phaseOrder(phase: TimelineNarrativeCoordinate["phase"]): number {
  return phase === "before" ? 0 : phase === "at" ? 1 : 2;
}

function nonEmptyText(value: unknown): boolean {
  return typeof value === "string" && Boolean(value.trim());
}
