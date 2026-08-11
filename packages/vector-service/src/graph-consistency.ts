import { VectorDb } from "./vector-db.js";

export interface GraphBlockingClaim {
  claim: string;
  source_path: string;
  reason: string;
}

export interface GraphConsistencyResult {
  score: number;
  risks: string[];
  blocking_claims: GraphBlockingClaim[];
  suggested_fix: string;
}

interface GraphEntityRow {
  entity_id: string;
  name: string;
}

interface GraphClaimRow {
  subject_entity_id: string;
  predicate: string;
  object_text: string | null;
  source_path: string;
  source_type: string;
  chapter_number: number | null;
  status: string;
  confidence: number | null;
}

export interface CheckDraftConsistencyOptions {
  chapter?: number;
  chapterOutline?: string;
}

const NEGATION_MARKERS = ["不是", "并非", "不属于", "从未", "没有"];

function normalizeText(text: string): string {
  return text.replace(/\s+/g, "");
}

function claimFragments(objectText: string): string[] {
  return objectText
    .split(/[，,。.!！?？；;：:\r\n]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .slice(0, 6);
}

function hasNegatedClaim(text: string, entityName: string, objectText: string): boolean {
  const normalizedDraft = normalizeText(text);
  const normalizedEntity = normalizeText(entityName);

  for (const fragment of claimFragments(objectText)) {
    const normalizedFragment = normalizeText(fragment);
    for (const marker of NEGATION_MARKERS) {
      if (normalizedDraft.includes(`${normalizedEntity}${marker}${normalizedFragment}`)) {
        return true;
      }
      if (normalizedDraft.includes(`${normalizedEntity}${marker}是${normalizedFragment}`)) {
        return true;
      }
    }
  }

  return false;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export class GraphConsistency {
  private readonly db: VectorDb;

  constructor(projectPath: string) {
    this.db = new VectorDb(projectPath);
  }

  checkDraft(text: string, options: CheckDraftConsistencyOptions = {}): GraphConsistencyResult {
    this.db.init();
    const conn = this.db.db;

    const entities = conn.prepare("SELECT entity_id, name FROM graph_entities").all() as GraphEntityRow[];
    const matchedEntities = entities.filter((entity) => text.includes(entity.name));
    const blockingClaims: GraphBlockingClaim[] = [];

    if (matchedEntities.length > 0) {
      const placeholders = matchedEntities.map(() => "?").join(",");
      const claims = conn.prepare(`
        SELECT subject_entity_id, predicate, object_text, source_path, source_type, chapter_number, status, confidence
        FROM graph_claims
        WHERE subject_entity_id IN (${placeholders})
          AND status = 'confirmed'
          AND object_text IS NOT NULL
      `).all(...matchedEntities.map((entity) => entity.entity_id)) as GraphClaimRow[];

      const entityById = new Map(matchedEntities.map((entity) => [entity.entity_id, entity]));
      for (const claim of claims) {
        if (!claim.object_text) {
          continue;
        }
        const entity = entityById.get(claim.subject_entity_id);
        if (!entity) {
          continue;
        }

        if (hasNegatedClaim(text, entity.name, claim.object_text)) {
          blockingClaims.push({
            claim: `[${claim.subject_entity_id}] ${claim.object_text}`,
            source_path: claim.source_path,
            reason: `Draft negates a confirmed ${claim.predicate} claim for ${entity.name}.`
          });
        }
      }
    }

    const risks: string[] = [];
    if (blockingClaims.length > 0) {
      risks.push(`Found ${blockingClaims.length} draft statement(s) that conflict with confirmed graph claims.`);
    }
    return {
      score: clampScore(100 - blockingClaims.length * 25),
      risks,
      blocking_claims: blockingClaims,
      suggested_fix: blockingClaims.length > 0
        ? "Revise the draft to preserve confirmed graph facts or explicitly update/deprecate the source claim first."
        : ""
    };
  }

  close(): void {
    this.db.close();
  }
}
