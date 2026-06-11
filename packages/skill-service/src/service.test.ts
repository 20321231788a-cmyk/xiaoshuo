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
    const importedPath = path.join(tempDir, "00_设定集", ".agent", "skills", "imported.json");
    const saved = JSON.parse(await fs.readFile(importedPath, "utf8"));
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("fancy_skill");
    const sourceText = await fs.readFile(path.join(tempDir, "00_设定集", ".agent", "skills", "sources", "fancy_skill", "source.md"), "utf8");
    expect(sourceText).toContain("Prompt body");
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
});
