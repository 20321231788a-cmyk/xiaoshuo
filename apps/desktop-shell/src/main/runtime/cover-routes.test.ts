import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CoverRecord } from "@xiaoshuo/shared";
import { buildCoverPrompt, computeCoverCropRect, handleCoverRoutes, selectImageSize } from "./cover-routes.js";
import type { RuntimeContext } from "./types.js";

const { resolveWebsiteImageRuntimeConfig } = vi.hoisted(() => ({
  resolveWebsiteImageRuntimeConfig: vi.fn()
}));

vi.mock("./website-ai-routes.js", () => ({ resolveWebsiteImageRuntimeConfig }));

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG = Buffer.from(PNG_BASE64, "base64");
let projectRoot = "";

function context(): RuntimeContext {
  return {
    projectRoot,
    jobManager: {} as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function request(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}

function response(): ServerResponse {
  return { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
}

function deps(body: Record<string, unknown>, fetchFn: typeof fetch) {
  return {
    ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: projectRoot, name: "长夜行" }),
    readRawBody: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(body))),
    parseJsonRecord: (raw: Buffer) => JSON.parse(raw.toString("utf8")) as Record<string, unknown>,
    createRequestAbortSignal: vi.fn().mockReturnValue(new AbortController().signal),
    writeJson: vi.fn(),
    openPath: vi.fn(),
    normalizeImage: vi.fn().mockResolvedValue(PNG),
    fetchFn
  };
}

describe("cover routes", () => {
  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-cover-"));
    resolveWebsiteImageRuntimeConfig.mockResolvedValue({
      tokenKey: "website-token",
      relayBaseUrl: "https://relay.example.test/v1",
      model: {
        id: "gpt-image-2",
        name: "GPT Image 2",
        provider: "website",
        category: "image",
        selectable: true,
        capabilities: { text_generation: false, streaming: false, reasoning: false, image_generation: true, image_edit: true },
        reasoning_efforts: [],
        supported_sizes: ["768x1024"]
      }
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("builds the constrained title and author prompt", () => {
    const prompt = buildCoverPrompt({
      mode: "text_to_image",
      book_title: "长夜行",
      author_name: "南山",
      font_style: "行草",
      genre_style: "悬疑",
      genre_description: "雨夜追凶",
      genre_rules: ["保持冷峻氛围"]
    });
    expect(prompt).toContain("书名：“长夜行”");
    expect(prompt).toContain("作者署名：“南山 著”");
    expect(prompt).toContain("不得出现其他文字、字母、数字");
    expect(prompt).not.toContain("API Key");
  });

  it("prefers a declared 3:4 model size", () => {
    expect(selectImageSize({ supported_sizes: ["1024x1536", "768x1024"] } as any)).toBe("768x1024");
    expect(selectImageSize({ supported_sizes: [] } as any)).toBe("768x1024");
  });

  it("center-crops landscape and portrait images to 3:4", () => {
    expect(computeCoverCropRect(1600, 800)).toEqual({ x: 500, y: 0, width: 600, height: 800 });
    expect(computeCoverCropRect(600, 1200)).toEqual({ x: 0, y: 200, width: 600, height: 800 });
  });

  it("generates, versions and removes a text-to-image cover", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as unknown as typeof fetch;
    const routeDeps = deps({
      mode: "text_to_image",
      book_title: "长夜行",
      author_name: "南山",
      font_style: "行草",
      genre_style: "悬疑"
    }, fetchFn);

    await handleCoverRoutes(request("POST"), response(), "/api/covers/generate", new URLSearchParams(), context(), routeDeps);

    const generated = routeDeps.writeJson.mock.calls.find((call) => call[1] === 200)?.[2] as CoverRecord;
    expect(generated).toMatchObject({ book_title: "长夜行", width: 600, height: 800, model: "gpt-image-2" });
    expect(await fs.readFile(path.join(projectRoot, generated.original_path))).toEqual(PNG);
    expect(await fs.readFile(path.join(projectRoot, generated.final_path))).toEqual(PNG);
    expect(fetchFn).toHaveBeenCalledWith("https://relay.example.test/v1/images/generations", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer website-token", "Content-Type": "application/json" })
    }));
    const requestBody = JSON.parse(String((fetchFn as any).mock.calls[0][1].body));
    expect(requestBody).toMatchObject({ model: "gpt-image-2", size: "768x1024" });
    expect(requestBody).not.toHaveProperty("response_format");

    const deleteDeps = deps({}, fetchFn);
    await handleCoverRoutes(request("DELETE"), response(), `/api/covers/${generated.id}`, new URLSearchParams(), context(), deleteDeps);
    expect(deleteDeps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, { ok: true, deleted_id: generated.id });
    const trashFiles = await fs.readdir(path.join(projectRoot, "99_回收站", "封面"));
    expect(trashFiles).toHaveLength(2);
  });

  it("sends reference images as multipart image edits without persisting the reference", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), { status: 200 })) as unknown as typeof fetch;
    const routeDeps = deps({
      mode: "image_to_image",
      book_title: "长夜行",
      author_name: "南山",
      font_style: "行草",
      genre_style: "悬疑",
      reference_image: { filename: "reference.png", media_type: "image/png", data_base64: PNG_BASE64 }
    }, fetchFn);

    await handleCoverRoutes(request("POST"), response(), "/api/covers/generate", new URLSearchParams(), context(), routeDeps);

    expect(fetchFn).toHaveBeenCalledWith("https://relay.example.test/v1/images/edits", expect.objectContaining({ method: "POST", body: expect.any(FormData) }));
    const form = (fetchFn as any).mock.calls[0][1].body as FormData;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toContain("清除参考图中的全部原有文字");
    const allFiles = await fs.readdir(path.join(projectRoot, "封面"));
    expect(allFiles.every((file) => !file.includes("reference"))).toBe(true);
  });
});
