import { createHash } from "node:crypto";

export type VectorHit = {
  path: string;
  source_type: string;
  title: string;
  text: string;
  score: number;
};

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sourceWeight(sourceType: string): number {
  const weights: Record<string, number> = {
    lore: 1.12,
    outline: 1.1,
    style: 1.06,
    genre: 1.04,
    body: 1.0,
    document: 0.96
  };
  return weights[sourceType] ?? 1.0;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left || !right || left.length !== right.length || left.length === 0) {
    return 0.0;
  }
  let dot = 0.0;
  let leftNorm = 0.0;
  let rightNorm = 0.0;
  for (let i = 0; i < left.length; i++) {
    const a = left[i]!;
    const b = right[i]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0.0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function getKeywordTerms(query: string): string[] {
  const lowered = (query || "").toLowerCase();
  const terms: string[] = [];
  const seen = new Set<string>();

  function add(term: string): void {
    const trimmed = term.trim();
    if (trimmed.length < 2 || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    terms.push(trimmed);
  }

  // Split by non-word and non-CJK characters
  const splitted = lowered.split(/[^\w\u4e00-\u9fff]+/);
  for (const part of splitted) {
    if (part) {
      add(part);
    }
  }

  // Regex match for CJK character sequences of length >= 2
  const cjkRuns = lowered.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of cjkRuns) {
    if (run.length <= 8) {
      add(run);
    }
    for (const size of [4, 3, 2]) {
      for (let index = 0; index <= run.length - size; index++) {
        add(run.substring(index, index + size));
        if (terms.length >= 48) {
          return terms;
        }
      }
    }
  }
  return terms.slice(0, 48);
}

export function searchKeywordsInChunks(
  chunks: Array<{ path: string; source_type: string; title: string; text: string }>,
  query: string,
  limit: number
): VectorHit[] {
  const terms = getKeywordTerms(query);
  if (terms.length === 0) {
    return [];
  }

  const hits: VectorHit[] = [];
  for (const chunk of chunks) {
    const lowered = (chunk.text || "").toLowerCase();
    let score = 0.0;
    for (const term of terms) {
      // Count occurrences of term in lowered
      let count = 0;
      let pos = lowered.indexOf(term);
      while (pos !== -1) {
        count++;
        pos = lowered.indexOf(term, pos + term.length);
      }
      if (count > 0) {
        score += count * Math.min(0.18, 0.035 + term.length * 0.018);
      }
    }

    if (score > 0) {
      const weightedScore = score * sourceWeight(chunk.source_type);
      hits.push({
        path: chunk.path,
        source_type: chunk.source_type,
        title: chunk.title,
        text: chunk.text,
        score: Math.min(0.86, weightedScore)
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function mergeHits(first: VectorHit[], second: VectorHit[], topK: number): VectorHit[] {
  const merged = new Map<string, VectorHit>();

  for (const hit of [...first, ...second]) {
    const key = `${hit.path}::${hashText(hit.text)}`;
    const current = merged.get(key);
    if (!current) {
      // Shallow copy hit to avoid mutating the original
      merged.set(key, { ...hit });
    } else {
      if (hit.score > current.score) {
        current.score = hit.score;
      } else {
        current.score = Math.min(1.0, current.score + Math.min(hit.score, 0.08));
      }
    }
  }

  const sortedHits = Array.from(merged.values()).sort((a, b) => b.score - a.score);
  const selected: VectorHit[] = [];
  const seenPaths = new Map<string, number>();

  for (const hit of sortedHits) {
    const count = seenPaths.get(hit.path) || 0;
    if (count >= 2) {
      continue;
    }
    selected.push(hit);
    seenPaths.set(hit.path, count + 1);
    if (selected.length >= topK) {
      break;
    }
  }

  return selected;
}

export function hitExcerptLimit(hit: { source_type: string }, topK: number, maxChars: number): number {
  const fairShare = Math.max(500, Math.floor(maxChars / Math.max(topK, 1)) + 240);
  const sourceCap = hit.source_type === "body" ? 1200 : 900;
  return Math.max(300, Math.min(fairShare, sourceCap, maxChars));
}

export function excerptText(text: string, limit: number): string {
  const trimmed = (text || "").trim();
  return trimmed.length <= limit ? trimmed : trimmed.substring(0, limit).trimEnd() + "\n...";
}

export function prepareQuery(query: string, limit = 4000): string {
  const compact = (query || "").trim().replace(/\s+/g, " ");
  if (compact.length <= limit) {
    return compact;
  }
  const headLimit = Math.floor(limit * 0.65);
  const tailLimit = Math.floor(limit * 0.35);
  const head = compact.substring(0, headLimit).trim();
  const tail = compact.substring(compact.length - tailLimit).trim();
  return `${head}\n...\n${tail}`;
}
