import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { SkillService } from "./service.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-skill-service-"));
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("skill-service", () => {
  it("lists builtin skills and keeps them sorted", async () => {
    const service = new SkillService({ projectRoot: tempDir });

    const skills = await service.listSkills();

    expect(skills.length).toBeGreaterThan(10);
    expect(skills.some((skill) => skill.id === "outline_generate")).toBe(true);
    expect(skills.find((skill) => skill.id === "story_deslop")?.imported_from).toBe("builtin:story-deslop");
    expect(skills.find((skill) => skill.id === "humanizer_zh")?.imported_from).toBe("builtin:humanizer-zh");
    expect(skills.map((skill) => skill.name)).toEqual([...skills.map((skill) => skill.name)].sort((a, b) => a.localeCompare(b, "zh-CN")));
  });

  it("imports a skill from a local directory and writes imported.json plus source snapshot", async () => {
    const skillDir = path.join(tempDir, "sample-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: Fancy Skill", "description: test skill", "---", "", "Prompt body"].join("\n"),
      "utf8"
    );
    const service = new SkillService({ projectRoot: tempDir, now: () => "2026-06-04 10:00:00" });

    const skill = await service.importSkill({ path: skillDir });

    expect(skill.id).toBe("fancy_skill");
    expect(skill.name).toBe("Fancy Skill");
    expect(skill.version).toBe("1.0.0");
    expect(skill.manifest?.save_policy.requires_confirmation).toBe(true);
    const importedPath = path.join(tempDir, "00_设定集", ".agent", "skills", "imported.json");
    const saved = JSON.parse(await fs.readFile(importedPath, "utf8"));
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("fancy_skill");
    expect(saved[0].manifest.version).toBe("1.0.0");
    const sourceText = await fs.readFile(path.join(tempDir, "00_设定集", ".agent", "skills", "sources", "fancy_skill", "source.md"), "utf8");
    expect(sourceText).toContain("Prompt body");
  });

  it("imports versioned manifest metadata from SKILL.md frontmatter", async () => {
    const skillDir = path.join(tempDir, "manifest-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "id: manifest_skill",
        "name: Manifest Skill",
        "description: manifest description",
        "version: 2.3.0",
        "context_requirements: [project_state, style]",
        "linked_targets: [\"02_正文/manifest.txt\"]",
        "tools: [web_search]",
        "model_policy: {\"line\":\"secondary\",\"temperature\":0.2,\"max_input_chars\":12000}",
        "save_policy: {\"default_mode\":\"append\",\"auto_commit\":true,\"requires_confirmation\":false}",
        "eval_cases: [routing-cases.jsonl]",
        "---",
        "",
        "Manifest prompt"
      ].join("\n"),
      "utf8"
    );
    const service = new SkillService({ projectRoot: tempDir });

    const skill = await service.importSkill({ path: skillDir });

    expect(skill).toMatchObject({
      id: "manifest_skill",
      version: "2.3.0",
      handler_type: "prompt",
      context_requirements: ["project_state", "style"],
      linked_targets: ["02_正文/manifest.txt"],
      tools: ["web_search"],
      eval_cases: ["routing-cases.jsonl"]
    });
    expect(skill.manifest?.model_policy).toMatchObject({ line: "secondary", temperature: 0.2, max_input_chars: 12000 });
    expect(skill.manifest?.save_policy).toMatchObject({ default_mode: "append", auto_commit: true, requires_confirmation: false });
  });

  it("imports uploaded markdown and zip skills safely", async () => {
    const service = new SkillService({ projectRoot: tempDir });
    const markdownSkill = await service.importUploadedSkill(
      "upload-skill.md",
      Buffer.from(["---", "name: Upload Skill", "---", "", "Upload prompt"].join("\n"), "utf8"),
      "text/markdown"
    );

    const archive = new AdmZip();
    archive.addFile("nested/SKILL.md", Buffer.from(["---", "name: Zip Skill", "---", "", "Zip prompt"].join("\n"), "utf8"));
    const zipSkill = await service.importUploadedSkill("zip-skill.zip", archive.toBuffer(), "application/zip");

    expect(markdownSkill.id).toBe("upload_skill");
    expect(markdownSkill.imported_from).toBe("upload:upload-skill.md");
    expect(zipSkill.id).toBe("zip_skill");
    expect(zipSkill.imported_from).toBe("upload:zip-skill.zip");
  });

  it("imports draft skills and normalizes prompt metadata", async () => {
    const service = new SkillService({ projectRoot: tempDir });

    const skill = await service.importSkillDraft({
      skill: {
        id: "Draft Skill!!",
        name: " Draft Skill ",
        description: " draft description ",
        input_mode: "text",
        context_requirements: [],
        handler_type: "workflow",
        linked_targets: ["01_大纲/大纲.txt", ""],
        prompt: "  Draft prompt body  ",
        imported_from: "",
        writable: true
      },
      source_url: "https://example.com/skill",
      source_name: "draft-source.md",
      source_text: "Draft prompt body"
    });

    expect(skill).toMatchObject({
      id: "draft_skill",
      handler_type: "prompt",
      imported_from: "https://example.com/skill",
      linked_targets: ["01_大纲/大纲.txt"]
    });
  });

  it("keeps duplicate imported draft ids instead of overwriting existing skills", async () => {
    const service = new SkillService({ projectRoot: tempDir });
    const makeDraft = (prompt: string) => ({
      skill: {
        id: "custom_skill",
        name: "自定义技能",
        description: "draft description",
        input_mode: "text" as const,
        context_requirements: [],
        handler_type: "prompt" as const,
        linked_targets: [],
        prompt,
        imported_from: "",
        writable: true
      },
      source_url: "",
      source_name: "",
      source_text: prompt
    });

    const first = await service.importSkillDraft(makeDraft("first prompt"));
    const second = await service.importSkillDraft(makeDraft("second prompt"));

    expect(first.id).toBe("custom_skill");
    expect(second.id).toBe("custom_skill_2");
    expect((await service.getSkill("custom_skill"))?.prompt).toBe("first prompt");
    expect((await service.getSkill("custom_skill_2"))?.prompt).toBe("second prompt");
  });

  it("ignores broken imported skill records when listing", async () => {
    const skillsDir = path.join(tempDir, "00_设定集", ".agent", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, "imported.json"),
      JSON.stringify([{ id: "ok", name: "OK", description: "desc", input_mode: "text", context_requirements: [], handler_type: "prompt", linked_targets: [], prompt: "ok", imported_from: "x", writable: false }, { broken: true }]),
      "utf8"
    );
    const service = new SkillService({ projectRoot: tempDir });

    const skills = await service.listSkills();

    expect(skills.some((skill) => skill.id === "ok")).toBe(true);
  });

  it("returns the imported skills directory path", async () => {
    const service = new SkillService({ projectRoot: tempDir });

    const dir = await service.importedSkillDirectory();

    expect(dir).toBe(path.join(tempDir, "00_设定集", ".agent", "skills"));
  });

  it("converts html to clean text with htmlToText", () => {
    const service = new SkillService({ projectRoot: tempDir });
    const html = "<html><body><script>console.log('x');</script><div id='x'>Hello &nbsp; World!</div></body></html>";
    const text = service.htmlToText(html);
    expect(text).toBe("Hello World!");
  });

  it("fetches and decodes url text correctly", async () => {
    const service = new SkillService({ projectRoot: tempDir });
    const html = "<html><body><div id='x'>Mocked Skill HTML</div></body></html>";
    
    const mockFetch = vi.fn(async () => new Response(html, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    const result = await service.fetchUrlText("https://example.com/skill-importer.html");
    expect(result.text).toBe("Mocked Skill HTML");
    expect(result.sourceName).toBe("skill-importer.html");

    vi.unstubAllGlobals();
  });

  it("patches imported skills with dry-run diff and version history", async () => {
    const service = new SkillService({ projectRoot: tempDir, now: () => "2026-07-07 10:00:00" });
    await service.importSkillDraft({
      skill: {
        id: "review_skill",
        name: "Review Skill",
        description: "old description",
        input_mode: "text",
        context_requirements: ["project_state"],
        handler_type: "prompt",
        linked_targets: [],
        prompt: "old prompt",
        imported_from: "",
        writable: false
      },
      source_url: "",
      source_name: "",
      source_text: ""
    });

    const dryRun = await service.patchSkill("review_skill", {
      description: "new description",
      prompt: "new prompt",
      change_reason: "",
      expected_version: "",
      dry_run: true
    });

    expect(dryRun.dry_run).toBe(true);
    expect(dryRun.diff).toContain("new prompt");
    expect((await service.getSkill("review_skill"))?.prompt).toBe("old prompt");

    const committed = await service.patchSkill("review_skill", {
      description: "new description",
      prompt: "new prompt",
      change_reason: "tighten review",
      expected_version: "",
      dry_run: false
    });

    expect(committed.version_id).toContain("v1_");
    expect(committed.skill.prompt).toBe("new prompt");
    expect(committed.skill.version).toBe("1.0.1");
    const versions = await service.listSkillVersions("review_skill");
    expect(versions.versions).toHaveLength(1);
    expect(versions.versions[0]?.snapshot.prompt).toBe("old prompt");
    expect(versions.versions[0]?.change_reason).toBe("tighten review");
  });

  it("rejects builtin patch and clones builtin skills into imported skills", async () => {
    const service = new SkillService({ projectRoot: tempDir, now: () => "2026-07-07 10:00:00" });

    await expect(service.patchSkill("outline_generate", { description: "x", change_reason: "", expected_version: "", dry_run: false })).rejects.toThrow("默认技能不能直接修改");

    const cloned = await service.cloneSkill("outline_generate", {
      target_id: "custom_outline",
      target_name: "自定义大纲",
      instruction: "clone for edit"
    });

    expect(cloned).toMatchObject({
      id: "custom_outline",
      name: "自定义大纲",
      builtin: false,
      imported_from: "clone:outline_generate",
      handler_type: "prompt"
    });
    expect((await service.getSkill("custom_outline"))?.id).toBe("custom_outline");
    const versions = await service.listSkillVersions("custom_outline");
    expect(versions.versions).toHaveLength(1);
    expect(versions.versions[0]?.snapshot.id).toBe("custom_outline");
  });

  it("rejects cloning non-prompt builtin workflow or job skills", async () => {
    const service = new SkillService({ projectRoot: tempDir, now: () => "2026-07-07 10:00:00" });

    await expect(service.cloneSkill("body_generate", {
      target_id: "custom_body",
      target_name: "自定义正文",
      instruction: "clone for edit"
    })).rejects.toThrow("只能复制 prompt 型技能");
  });

  it("rolls imported skills back to a stored version", async () => {
    const service = new SkillService({ projectRoot: tempDir, now: () => "2026-07-07 10:00:00" });
    await service.importSkillDraft({
      skill: {
        id: "rollback_skill",
        name: "Rollback Skill",
        description: "desc",
        input_mode: "text",
        context_requirements: [],
        handler_type: "prompt",
        linked_targets: [],
        prompt: "v1 prompt",
        imported_from: "",
        writable: false
      },
      source_url: "",
      source_name: "",
      source_text: ""
    });
    const patched = await service.patchSkill("rollback_skill", {
      prompt: "v2 prompt",
      change_reason: "v2",
      expected_version: "",
      dry_run: false
    });

    const rolledBack = await service.rollbackSkill("rollback_skill", {
      version_id: patched.version_id,
      change_reason: "restore v1"
    });

    expect(rolledBack.skill.prompt).toBe("v1 prompt");
    expect(rolledBack.diff).toContain("v1 prompt");
    expect((await service.getSkill("rollback_skill"))?.prompt).toBe("v1 prompt");
    const versions = await service.listSkillVersions("rollback_skill");
    expect(versions.versions.map((version) => version.change_reason)).toEqual(["v2", "restore v1"]);
  });
});
