import { VectorDb } from "./vector-db.js";
import { GraphConsistency, type GraphBlockingClaim } from "./graph-consistency.js";


function parseChapterNumber(text: string): number | undefined {
  const matchArabic = text.match(/(?:第)?\s*(\d+)\s*(?:章|集)/);
  if (matchArabic && matchArabic[1]) {
    return parseInt(matchArabic[1], 10);
  }
  const matchChinese = text.match(/(?:第)?\s*([一二三四五六七八九十百千万]+)\s*(?:章|集)/);
  if (matchChinese && matchChinese[1]) {
    const charMap: Record<string, number> = {
      一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10
    };
    const ch = matchChinese[1];
    if (ch.length === 1) {
      return charMap[ch];
    }
    if (ch.startsWith("十") && ch.length === 2) {
      const last = charMap[ch[1]!];
      return last ? 10 + last : 10;
    }
    if (ch.endsWith("十") && ch.length === 2) {
      const first = charMap[ch[0]!];
      return first ? first * 10 : 10;
    }
  }
  return undefined;
}


export interface GraphEntity {
  id?: number;
  entity_id: string;
  name: string;
  type: string;
  description: string;
  source_path: string;
  status: string;
}

export interface GraphRelation {
  id?: number;
  source_entity_id: string;
  predicate: string;
  target_entity_id: string;
  description: string;
  source_path: string;
  status: string;
}

export interface GraphClaim {
  id?: number;
  subject_entity_id: string;
  predicate: string;
  object_text: string;
  object_entity_id?: string;
  source_path: string;
  source_type: string;
  chapter_number?: number;
  status: string;
  confidence?: number;
  evidence_chunk_id?: number;
}

export class GraphContext {
  private readonly projectPath: string;
  private readonly db: VectorDb;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.db = new VectorDb(projectPath);
  }


  /**
   * 基于规则解析单个 Chunk 的文本内容，提取实体、关系和 Claims
   */
  extractGraphData(
    chunkId: number,
    text: string,
    sourceType: string,
    sourcePath: string,
    chunkTitle: string
  ): { entities: GraphEntity[]; relations: GraphRelation[]; claims: GraphClaim[] } {
    const entities: GraphEntity[] = [];
    const relations: GraphRelation[] = [];
    const claims: GraphClaim[] = [];

    const normalizedPath = sourcePath.replace(/\\/g, "/");

    // 1. 设定集、设定库、题材库、风格库抽取
    if (sourceType === "lore" || sourceType === "style" || sourceType === "genre") {
      let currentEntity: GraphEntity | null = null;
      let type = "term";

      if (sourceType === "style") {
        type = "style_rule";
      } else if (sourceType === "genre") {
        type = "genre_rule";
      } else {
        // 根据路径/文件名猜测实体类别
        if (normalizedPath.includes("角色") || normalizedPath.includes("人物")) {
          type = "character";
        } else if (normalizedPath.includes("地点") || normalizedPath.includes("地图") || normalizedPath.includes("场景")) {
          type = "location";
        } else if (normalizedPath.includes("势力") || normalizedPath.includes("宗门") || normalizedPath.includes("组织")) {
          type = "organization";
        } else if (normalizedPath.includes("道具") || normalizedPath.includes("法宝") || normalizedPath.includes("物品")) {
          type = "item";
        }
      }

      const lines = text.split(/\r?\n/);
      let descLines: string[] = [];

      const flushEntity = () => {
        if (currentEntity) {
          currentEntity.description = descLines.join("\n").trim();
          entities.push(currentEntity);

          claims.push({
            subject_entity_id: currentEntity.entity_id,
            predicate: "description",
            object_text: currentEntity.description,
            source_path: sourcePath,
            source_type: sourceType,
            status: "confirmed",
            evidence_chunk_id: chunkId
          });
          currentEntity = null;
          descLines = [];
        }
      };

      for (const line of lines) {
        const match = line.match(/^(#{1,4})\s+(.+)$/);
        if (match) {
          flushEntity();
          const name = match[2]!.trim().replace(/[\[\]【】]/g, "");
          const entityId = `${type}:${name}`;
          currentEntity = {
            entity_id: entityId,
            name,
            type,
            description: "",
            source_path: sourcePath,
            status: "confirmed"
          };
        } else if (line.trim()) {
          descLines.push(line);
        }
      }
      flushEntity();

      // 如果整个 chunk 没有任何 Markdown 标题，将其整体作为以文件名命名的实体
      if (entities.length === 0 && text.trim()) {
        const basename = sourcePath.split("/").pop() || "unknown";
        const name = basename.replace(/\.(txt|md)$/i, "");
        const entityId = `${type}:${name}`;
        entities.push({
          entity_id: entityId,
          name,
          type,
          description: text.trim(),
          source_path: sourcePath,
          status: "confirmed"
        });
        claims.push({
          subject_entity_id: entityId,
          predicate: "description",
          object_text: text.trim(),
          source_path: sourcePath,
          source_type: sourceType,
          status: "confirmed",
          evidence_chunk_id: chunkId
        });
      }
    }

    // 2. 大纲抽取
    else if (sourceType === "outline") {
      // 提取章节编号或大纲关键段落
      const chapterNum = parseChapterNumber(chunkTitle);

      const cleanText = text.trim();
      const entityId = `chapter_plan:${chunkTitle || "大纲片段"}`;

      entities.push({
        entity_id: entityId,
        name: chunkTitle || "大纲片段",
        type: "chapter_plan",
        description: cleanText,
        source_path: sourcePath,
        status: "planned"
      });

      claims.push({
        subject_entity_id: entityId,
        predicate: "plot_plan",
        object_text: cleanText,
        source_path: sourcePath,
        source_type: sourceType,
        chapter_number: chapterNum,
        status: "planned",
        evidence_chunk_id: chunkId
      });
    }

    // 3. 正文事实抽取
    else if (sourceType === "body") {
      const chapterNum = parseChapterNumber(sourcePath);

      const entityId = `event:chapter_${chapterNum || "unknown"}`;
      entities.push({
        entity_id: entityId,
        name: chunkTitle || `第${chapterNum}章事件`,
        type: "event",
        description: text.trim(),
        source_path: sourcePath,
        status: "confirmed"
      });

      claims.push({
        subject_entity_id: entityId,
        predicate: "occurrence",
        object_text: text.trim(),
        source_path: sourcePath,
        source_type: sourceType,
        chapter_number: chapterNum,
        status: "confirmed",
        evidence_chunk_id: chunkId
      });
    }

    return { entities, relations, claims };
  }

  /**
   * 重新扫描数据库中的 chunks 并增量构建图谱数据
   */
  rebuildGraph(): void {
    this.db.init();
    const conn = this.db.db;

    this.db.transaction(() => {
      // 1. 清空旧数据
      conn.prepare("DELETE FROM graph_entities").run();
      conn.prepare("DELETE FROM graph_relations").run();
      conn.prepare("DELETE FROM graph_claims").run();
      conn.prepare("DELETE FROM graph_communities").run();

      // 2. 读取所有的 chunks
      const chunks = conn.prepare("SELECT id, path, source_type, title, text FROM chunks").all() as Array<{
        id: number;
        path: string;
        source_type: string;
        title: string;
        text: string;
      }>;

      // 3. 提取并插入实体与 Claims
      const stmtEntity = conn.prepare(`
        INSERT OR REPLACE INTO graph_entities(entity_id, name, type, description, source_path, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const stmtClaim = conn.prepare(`
        INSERT INTO graph_claims(subject_entity_id, predicate, object_text, object_entity_id, source_path, source_type, chapter_number, status, confidence, evidence_chunk_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Math.floor(Date.now() / 1000);
      const allExtractedEntities: GraphEntity[] = [];

      for (const chunk of chunks) {
        const { entities, claims } = this.extractGraphData(
          chunk.id,
          chunk.text,
          chunk.source_type,
          chunk.path,
          chunk.title
        );

        for (const ent of entities) {
          stmtEntity.run(ent.entity_id, ent.name, ent.type, ent.description, ent.source_path, ent.status, now, now);
          allExtractedEntities.push(ent);
        }

        for (const clm of claims) {
          stmtClaim.run(
            clm.subject_entity_id,
            clm.predicate,
            clm.object_text || null,
            clm.object_entity_id || null,
            clm.source_path,
            clm.source_type,
            clm.chapter_number || null,
            clm.status,
            clm.confidence || 1.0,
            clm.evidence_chunk_id || null,
            now,
            now
          );
        }
      }

      // 4. 正文提及关系二阶段抽取
      const stmtRelation = conn.prepare(`
        INSERT INTO graph_relations(source_entity_id, predicate, target_entity_id, description, source_path, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const registeredEntities = allExtractedEntities.filter(
        (ent) => ent.type === "character" || ent.type === "location" || ent.type === "organization" || ent.type === "item"
      );

      for (const chunk of chunks) {
        if (chunk.source_type !== "body") {
          continue;
        }

        const chapterNum = parseChapterNumber(chunk.path);
        const eventId = `event:chapter_${chapterNum || "unknown"}`;

        for (const ent of registeredEntities) {
          if (chunk.text.includes(ent.name)) {
            stmtRelation.run(ent.entity_id, "appears_in", eventId, `在第${chapterNum}章中出场/被提到。`, chunk.path, "confirmed", now, now);
            stmtClaim.run(
              ent.entity_id,
              "appears_in",
              null,
              eventId,
              chunk.path,
              "body",
              chapterNum || null,
              "confirmed",
              1.0,
              chunk.id,
              now,
              now
            );
          }
        }
      }

      // 5. 生成 Community 摘要
      const stmtCommunity = conn.prepare(`
        INSERT OR REPLACE INTO graph_communities(type, summary, updated_at)
        VALUES (?, ?, ?)
      `);

      const plotClaims = conn.prepare("SELECT object_text FROM graph_claims WHERE predicate = 'plot_plan'").all() as Array<{ object_text: string }>;
      const charEntities = conn.prepare("SELECT name, description FROM graph_entities WHERE type = 'character'").all() as Array<{ name: string; description: string }>;

      const plotSummary = plotClaims.length
        ? plotClaims.map((c, i) => `[计划 ${i + 1}]: ${c.object_text.slice(0, 150)}...`).join("\n")
        : "暂无故事计划。";

      const charSummary = charEntities.length
        ? charEntities.map((e) => `- ${e.name}: ${e.description.slice(0, 100)}...`).join("\n")
        : "暂无角色登记。";

      stmtCommunity.run("main_plot_summary", `【大纲剧情总结】\n${plotSummary}`, now);
      stmtCommunity.run("character_arc_summary", `【登场人物大纲】\n${charSummary}`, now);
    });
  }

  /**
   * 仅针对已修改的 paths 增量删除并重构 claims/entities
   */
  updatePaths(paths: string[]): void {
    if (paths.length === 0) {
      return;
    }
    this.db.init();
    const conn = this.db.db;

    this.db.transaction(() => {
      const now = Math.floor(Date.now() / 1000);

      // 1. 将被修改 paths 的旧 claims 标记为 superseded，并物理删除受影响 path 的旧 entities/relations
      for (const p of paths) {
        conn.prepare(`
          UPDATE graph_claims
          SET status = 'superseded', updated_at = ?
          WHERE source_path = ? AND status != 'superseded'
        `).run(now, p);

        conn.prepare("DELETE FROM graph_entities WHERE source_path = ?").run(p);
        conn.prepare("DELETE FROM graph_relations WHERE source_path = ?").run(p);

        // 2. 从 chunks 中查出该 path 现在的 chunks 并提取
        const chunks = conn.prepare("SELECT id, path, source_type, title, text FROM chunks WHERE path = ?").all(p) as Array<{
          id: number;
          path: string;
          source_type: string;
          title: string;
          text: string;
        }>;

        const stmtEntity = conn.prepare(`
          INSERT OR REPLACE INTO graph_entities(entity_id, name, type, description, source_path, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const stmtClaim = conn.prepare(`
          INSERT INTO graph_claims(subject_entity_id, predicate, object_text, object_entity_id, source_path, source_type, chapter_number, status, confidence, evidence_chunk_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const chunk of chunks) {
          const { entities, claims } = this.extractGraphData(
            chunk.id,
            chunk.text,
            chunk.source_type,
            chunk.path,
            chunk.title
          );

          for (const ent of entities) {
            stmtEntity.run(ent.entity_id, ent.name, ent.type, ent.description, ent.source_path, ent.status, now, now);
          }

          for (const clm of claims) {
            stmtClaim.run(
              clm.subject_entity_id,
              clm.predicate,
              clm.object_text || null,
              clm.object_entity_id || null,
              clm.source_path,
              clm.source_type,
              clm.chapter_number || null,
              clm.status,
              clm.confidence || 1.0,
              clm.evidence_chunk_id || null,
              now,
              now
            );
          }
        }
      }

      // 3. 查出当前所有的 registeredEntities，用于二阶段关系抽取
      const registeredEntities = conn.prepare(`
        SELECT entity_id, name, type FROM graph_entities
        WHERE type IN ('character', 'location', 'organization', 'item')
      `).all() as GraphEntity[];

      const stmtRelation = conn.prepare(`
        INSERT INTO graph_relations(source_entity_id, predicate, target_entity_id, description, source_path, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const stmtClaimInsert = conn.prepare(`
        INSERT INTO graph_claims(subject_entity_id, predicate, object_text, object_entity_id, source_path, source_type, chapter_number, status, confidence, evidence_chunk_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // 4. 对被修改的 path(s)，如果是 body，重新抽取与其关联的关系和 claims
      for (const p of paths) {
        const chunks = conn.prepare("SELECT id, path, source_type, title, text FROM chunks WHERE path = ?").all(p) as Array<{
          id: number;
          path: string;
          source_type: string;
          title: string;
          text: string;
        }>;

        for (const chunk of chunks) {
          if (chunk.source_type !== "body") {
            continue;
          }

          const chapterNum = parseChapterNumber(chunk.path);
          const eventId = `event:chapter_${chapterNum || "unknown"}`;

          for (const ent of registeredEntities) {
            if (chunk.text.includes(ent.name)) {
              stmtRelation.run(ent.entity_id, "appears_in", eventId, `在第${chapterNum}章中出场/被提到。`, chunk.path, "confirmed", now, now);
              stmtClaimInsert.run(
                ent.entity_id,
                "appears_in",
                null,
                eventId,
                chunk.path,
                "body",
                chapterNum || null,
                "confirmed",
                1.0,
                chunk.id,
                now,
                now
              );
            }
          }
        }
      }

      // 5. 生成 Community 摘要
      conn.prepare("DELETE FROM graph_communities").run();

      const plotClaims = conn.prepare("SELECT object_text FROM graph_claims WHERE predicate = 'plot_plan' AND status != 'superseded'").all() as Array<{ object_text: string }>;
      const charEntities = conn.prepare("SELECT name, description FROM graph_entities WHERE type = 'character'").all() as Array<{ name: string; description: string }>;

      const stmtCommunity = conn.prepare(`
        INSERT OR REPLACE INTO graph_communities(type, summary, updated_at)
        VALUES (?, ?, ?)
      `);

      const plotSummary = plotClaims.length
        ? plotClaims.map((c, i) => `[计划 ${i + 1}]: ${c.object_text.slice(0, 150)}...`).join("\n")
        : "暂无故事计划。";

      const charSummary = charEntities.length
        ? charEntities.map((e) => `- ${e.name}: ${e.description.slice(0, 100)}...`).join("\n")
        : "暂无角色登记。";

      stmtCommunity.run("main_plot_summary", `【大纲剧情总结】\n${plotSummary}`, now);
      stmtCommunity.run("character_arc_summary", `【登场人物大纲】\n${charSummary}`, now);
    });
  }


  /**
   * 获取图谱统计数据
   */
  getStatus(): { entities: number; relations: number; claims: number; communities: number } {
    this.db.init();
    const conn = this.db.db;

    const entities = (conn.prepare("SELECT COUNT(*) as count FROM graph_entities").get() as { count: number }).count;
    const relations = (conn.prepare("SELECT COUNT(*) as count FROM graph_relations").get() as { count: number }).count;
    const claims = (conn.prepare("SELECT COUNT(*) as count FROM graph_claims").get() as { count: number }).count;
    const communities = (conn.prepare("SELECT COUNT(*) as count FROM graph_communities").get() as { count: number }).count;

    return { entities, relations, claims, communities };
  }

  /**
   * DRIFT-like 混合召回，获得写作前上下文
   */
  async buildWritingContext(
    query: string,
    options: { topK?: number; projectPath?: string } = {}
  ): Promise<string> {
    this.db.init();
    const conn = this.db.db;

    const terms = query
      .split(/[\s,，.。!！?？:：\-—_【】\"\'“”‘’#\#]+/g)
      .map((t) => t.trim())
      .filter((t) => t.length > 1);

    let matchedChunks: Array<{ id: number; path: string; source_type: string; text: string }> = [];

    if (terms.length > 0) {
      const placeholders = terms.map(() => "text LIKE ?").join(" OR ");
      const sql = `SELECT id, path, source_type, text FROM chunks WHERE ${placeholders} LIMIT ?`;
      const bindArgs: Array<string | number> = [...terms.map((t) => `%${t}%`), options.topK || 5];
      matchedChunks = conn.prepare(sql).all(...bindArgs) as any;
    } else {
      matchedChunks = conn.prepare("SELECT id, path, source_type, text FROM chunks LIMIT ?").all(options.topK || 5) as any;
    }

    const entityIds = new Set<string>();
    const evidenceChunkIds = matchedChunks.map((c) => c.id);

    if (evidenceChunkIds.length > 0) {
      const placeholders = evidenceChunkIds.map(() => "?").join(",");
      const claimsOfChunks = conn.prepare(`
        SELECT subject_entity_id, object_entity_id
        FROM graph_claims
        WHERE evidence_chunk_id IN (${placeholders})
      `).all(...evidenceChunkIds) as Array<{ subject_entity_id: string; object_entity_id: string }>;

      for (const cl of claimsOfChunks) {
        entityIds.add(cl.subject_entity_id);
        if (cl.object_entity_id) {
          entityIds.add(cl.object_entity_id);
        }
      }
    }

    if (entityIds.size === 0) {
      const registered = conn.prepare("SELECT entity_id, name FROM graph_entities").all() as Array<{ entity_id: string; name: string }>;
      for (const chunk of matchedChunks) {
        for (const reg of registered) {
          if (chunk.text.includes(reg.name)) {
            entityIds.add(reg.entity_id);
          }
        }
      }
    }

    const expandedEntityIds = new Set<string>(entityIds);
    if (entityIds.size > 0) {
      const placeholders = Array.from(entityIds).map(() => "?").join(",");
      const rels = conn.prepare(`
        SELECT source_entity_id, target_entity_id
        FROM graph_relations
        WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})
      `).all(...Array.from(entityIds).concat(Array.from(entityIds))) as Array<{ source_entity_id: string; target_entity_id: string }>;

      for (const r of rels) {
        expandedEntityIds.add(r.source_entity_id);
        expandedEntityIds.add(r.target_entity_id);
      }
    }

    const confirmedClaims: string[] = [];
    const plannedClaims: string[] = [];
    const ruleClaims: string[] = [];

    if (expandedEntityIds.size > 0) {
      const placeholders = Array.from(expandedEntityIds).map(() => "?").join(",");
      const claims = conn.prepare(`
        SELECT subject_entity_id, predicate, object_text, source_type, status
        FROM graph_claims
        WHERE subject_entity_id IN (${placeholders})
      `).all(...Array.from(expandedEntityIds)) as Array<{
        subject_entity_id: string;
        predicate: string;
        object_text: string;
        source_type: string;
        status: string;
      }>;

      for (const cl of claims) {
        if (!cl.object_text) {
          continue;
        }
        const textPart = `[${cl.subject_entity_id}] ${cl.object_text}`;
        if (cl.source_type === "style" || cl.source_type === "genre") {
          ruleClaims.push(textPart);
        } else if (cl.status === "confirmed") {
          confirmedClaims.push(textPart);
        } else if (cl.status === "planned") {
          plannedClaims.push(textPart);
        }
      }
    }

    const communities = conn.prepare("SELECT type, summary FROM graph_communities").all() as Array<{ type: string; summary: string }>;

    const contextOutput: string[] = [];

    contextOutput.push("【已确认事实（Graph Confirmed）】");
    if (confirmedClaims.length > 0) {
      contextOutput.push(...confirmedClaims.slice(0, 15));
    } else {
      contextOutput.push("暂无相关已确认事实。");
    }
    contextOutput.push("");

    contextOutput.push("【大纲与计划（Graph Planned）】");
    if (plannedClaims.length > 0) {
      contextOutput.push(...plannedClaims.slice(0, 10));
    } else {
      contextOutput.push("暂无相关章节计划。");
    }
    contextOutput.push("");

    contextOutput.push("【全局风格与题材规则约束】");
    if (ruleClaims.length > 0) {
      contextOutput.push(...ruleClaims.slice(0, 10));
    } else {
      contextOutput.push("暂无风格/题材约束规则。");
    }
    contextOutput.push("");

    contextOutput.push("【项目全局社群大纲摘要】");
    for (const comm of communities) {
      contextOutput.push(comm.summary);
    }

    return contextOutput.join("\n");
  }

  async checkConsistency(text: string): Promise<{
    score: number;
    risks: string[];
    reason: string;
    blocking_claims?: GraphBlockingClaim[];
    suggested_fix?: string;
  }> {
    this.db.init();
    const conn = this.db.db;

    const consistency = new GraphConsistency(this.projectPath);
    try {
      const result = consistency.checkDraft(text);

      const entities = conn.prepare("SELECT name FROM graph_entities").all() as Array<{ name: string }>;
      const matchedEntities = entities.filter((ent) => text.includes(ent.name));

      let reason = "";
      if (result.blocking_claims.length > 0) {
        reason = `发现 ${result.blocking_claims.length} 处冲突事实。`;
      } else {
        reason = matchedEntities.length > 0
          ? `已核对 ${matchedEntities.length} 个图谱实体，无冲突事实。`
          : "无冲突事实";
      }

      return {
        score: result.score,
        risks: result.risks,
        blocking_claims: result.blocking_claims,
        suggested_fix: result.suggested_fix,
        reason
      };
    } finally {
      consistency.close();
    }
  }


  close(): void {
    this.db.close();
  }
}
