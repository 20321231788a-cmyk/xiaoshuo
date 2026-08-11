import { DocumentService } from "@xiaoshuo/document-service";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectFileManifestService } from "./project-file-manifest.js";
import { ProjectFileResolver } from "./project-file-resolver.js";

let tempDir = "";
let resolver: ProjectFileResolver;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-file-resolver-"));
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "02_设定"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "02_正文"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "01_大纲", "章纲.txt"), "章纲内容", "utf8");
  await fs.writeFile(path.join(tempDir, "01_大纲", "细纲.txt"), "细纲内容", "utf8");
  await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "大纲内容", "utf8");
  await fs.writeFile(path.join(tempDir, "02_设定", "人物设定.txt"), "林默：主角", "utf8");
  await fs.writeFile(path.join(tempDir, "02_设定", "主要角色.md"), "# 主要角色\n林默", "utf8");
  await fs.writeFile(path.join(tempDir, "02_设定", "世界观设定.md"), "# 世界观设定\n九境修炼", "utf8");
  await fs.writeFile(path.join(tempDir, "02_正文", "第001章.txt"), "正文内容", "utf8");

  const documents = new DocumentService({ projectRoot: tempDir });
  const manifest = new ProjectFileManifestService({ projectRoot: tempDir, documents });
  resolver = new ProjectFileResolver({ projectRoot: tempDir, documents, manifest });
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("project-file-resolver", () => {
  it("resolves chapter outline aliases as automatic references", async () => {
    const result = await resolver.resolve({ text: "参考章纲继续写" });

    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toMatchObject({
      path: "01_大纲/章纲.txt",
      kind: "alias",
      confidence: 0.98,
      readable: true
    });
  });

  it("resolves detail outline aliases", async () => {
    const result = await resolver.resolve({ text: "参考细纲生成正文" });

    expect(result.references[0]?.path).toBe("01_大纲/细纲.txt");
  });

  it("does not resolve negated aliases", async () => {
    const result = await resolver.resolve({ text: "参考大纲但不要细纲" });

    expect(result.references.map((item) => item.path)).toEqual(["01_大纲/大纲.txt"]);
  });

  it("resolves @ paths", async () => {
    const result = await resolver.resolve({ text: "参考 @01_大纲/章纲.txt" });

    expect(result.references[0]).toMatchObject({
      path: "01_大纲/章纲.txt",
      kind: "at_path"
    });
  });

  it("resolves quoted explicit paths", async () => {
    const result = await resolver.resolve({ text: "读取 `01_大纲/大纲.txt`" });

    expect(result.references[0]).toMatchObject({
      path: "01_大纲/大纲.txt",
      kind: "explicit_path"
    });
  });

  it("returns manifest candidates for fuzzy file names", async () => {
    const result = await resolver.resolve({ text: "参考人物设定" });

    expect(result.references).toEqual([]);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.map((item) => item.path)).toContain("02_设定/人物设定.txt");
  });

  it("resolves current document when current_path is present", async () => {
    const result = await resolver.resolve({
      text: "用当前文档改一下",
      currentPath: "02_正文/第001章.txt"
    });

    expect(result.references[0]).toMatchObject({
      path: "02_正文/第001章.txt",
      kind: "current_document"
    });
  });

  it("warns when current document is missing", async () => {
    const result = await resolver.resolve({ text: "根据当前文档生成意见" });

    expect(result.references).toEqual([]);
    expect(result.warnings.join("\n")).toContain("current_path");
  });

  it("rejects traversal paths", async () => {
    const result = await resolver.resolve({ text: "参考 ../secret.txt" });

    expect(result.references).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("keeps missing explicit paths as non-readable candidates", async () => {
    const result = await resolver.resolve({ text: "读取 01_大纲/不存在.txt" });

    expect(result.references).toEqual([]);
    expect(result.candidates[0]).toMatchObject({
      path: "01_大纲/不存在.txt",
      exists: false,
      readable: false
    });
  });

  it("marks close manifest matches as ambiguous", async () => {
    const result = await resolver.resolve({ text: "参考角色" });

    expect(result.ambiguous).toBe(true);
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("prioritizes confirmed paths over automatic parsing", async () => {
    const result = await resolver.resolve({
      text: "参考人物设定和章纲",
      confirmedPaths: ["02_设定/人物设定.txt"]
    });

    expect(result.references[0]?.path).toBe("02_设定/人物设定.txt");
  });

  it("keeps only explicit and confirmed references when auto references are disabled", async () => {
    const result = await resolver.resolve({
      text: "参考章纲和 @01_大纲/大纲.txt",
      disableAutoReferences: true
    });

    expect(result.references.map((item) => item.path)).toEqual(["01_大纲/大纲.txt"]);
  });

  it("converts absolute paths inside the project root", async () => {
    const absolute = path.join(tempDir, "01_大纲", "章纲.txt");
    const result = await resolver.resolve({ text: `读取 ${absolute}` });

    expect(result.references[0]?.path).toBe("01_大纲/章纲.txt");
  });
});
