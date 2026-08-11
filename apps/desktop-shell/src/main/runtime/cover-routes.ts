import { CanonicalProjectPathGuard } from "@xiaoshuo/document-service";
import {
  coverGenerationRequestSchema,
  coverHistoryResponseSchema,
  type CoverGenerationRequest,
  type CoverHistoryResponse,
  type CoverRecord,
  type WebsiteAiModelOption
} from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { RuntimeContext } from "./types.js";
import { resolveWebsiteImageRuntimeConfig } from "./website-ai-routes.js";

const COVER_DIR = "封面";
const COVER_INDEX = "00_设定集/.agent/covers/index.json";
const COVER_TRASH_DIR = "99_回收站/封面";
const MAX_REQUEST_BYTES = 14_500_000;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_UPSTREAM_BYTES = 20 * 1024 * 1024;
const GENERATION_TIMEOUT_MS = 180_000;

export type CoverImageNormalizer = (input: Buffer) => Promise<Buffer> | Buffer;

export type CoverCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CoverRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<{ path: string; name: string }>;
  readRawBody: (request: IncomingMessage, maxBytes?: number) => Promise<Buffer>;
  parseJsonRecord: (rawBody: Buffer) => Record<string, unknown>;
  createRequestAbortSignal: (request: IncomingMessage, response: ServerResponse) => AbortSignal;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
  openPath: (target: string) => unknown;
  normalizeImage: CoverImageNormalizer | null;
  fetchFn?: typeof fetch;
};

export async function handleCoverRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
  context: RuntimeContext,
  deps: CoverRouteDeps
): Promise<boolean> {
  if (!pathname.startsWith("/api/covers")) return false;
  const current = await deps.ensureProjectSessionCurrent(context);
  if (!current.path) {
    deps.writeJson(response, 400, { detail: "请先打开小说项目。" });
    return true;
  }
  const store = new CoverStore(current.path);
  let routeAbortSignal: AbortSignal | null = null;

  try {
    if (pathname === "/api/covers" && request.method === "GET") {
      deps.writeJson(response, 200, await store.list());
      return true;
    }

    if (pathname === "/api/covers/open-folder" && request.method === "POST") {
      const folder = await store.ensureCoverDirectory();
      await deps.openPath(folder);
      deps.writeJson(response, 200, { ok: true, path: folder });
      return true;
    }

    const imageMatch = /^\/api\/covers\/([^/]+)\/image$/.exec(pathname);
    if (imageMatch && request.method === "GET") {
      const variant = searchParams.get("variant") === "original" ? "original" : "final";
      const image = await store.readImage(decodeURIComponent(imageMatch[1] || ""), variant);
      response.writeHead(200, {
        "Content-Type": image.mediaType,
        "Content-Length": image.content.length,
        "Cache-Control": "private, max-age=60"
      });
      response.end(image.content);
      return true;
    }

    const recordMatch = /^\/api\/covers\/([^/]+)$/.exec(pathname);
    if (recordMatch && request.method === "DELETE") {
      await store.remove(decodeURIComponent(recordMatch[1] || ""));
      deps.writeJson(response, 200, { ok: true, deleted_id: decodeURIComponent(recordMatch[1] || "") });
      return true;
    }

    if (pathname === "/api/covers/generate" && request.method === "POST") {
      if (!deps.normalizeImage) throw new Error("桌面图片处理能力尚未准备好，请重启 ArcWriter 后重试。");
      const payload = coverGenerationRequestSchema.parse(deps.parseJsonRecord(await deps.readRawBody(request, MAX_REQUEST_BYTES)));
      const reference = payload.reference_image ? decodeReferenceImage(payload.reference_image.data_base64, payload.reference_image.media_type) : null;
      const website = await resolveWebsiteImageRuntimeConfig(context);
      if (payload.mode === "image_to_image" && website.model.capabilities.image_edit === false) {
        throw new Error("当前网站生图模型不支持图生图，请在设置中选择支持图生图的模型。");
      }
      const requestSignal = deps.createRequestAbortSignal(request, response);
      routeAbortSignal = requestSignal;
      const original = await requestWebsiteCover({
        payload,
        prompt: buildCoverPrompt(payload),
        reference,
        tokenKey: website.tokenKey,
        relayBaseUrl: website.relayBaseUrl,
        model: website.model,
        fetchFn: deps.fetchFn || fetch,
        signal: requestSignal
      });
      if (requestSignal.aborted) return true;
      const finalPng = await deps.normalizeImage(original.content);
      if (requestSignal.aborted) return true;
      if (!finalPng.length || detectImageMediaType(finalPng) !== "image/png") {
        throw new Error("封面尺寸处理失败，未生成有效 PNG 文件。");
      }
      const saved = await store.save(payload, website.model, original, finalPng);
      if (requestSignal.aborted) return true;
      deps.writeJson(response, 200, saved);
      return true;
    }

    deps.writeJson(response, 404, { detail: `未找到该接口: ${request.method} ${pathname}` });
  } catch (error) {
    if (routeAbortSignal?.aborted || response.destroyed || response.writableEnded) return true;
    const message = error instanceof Error ? error.message : String(error);
    const status = /过大|超过/.test(message) ? 413 : /不存在/.test(message) ? 404 : 400;
    deps.writeJson(response, status, { detail: message });
  }
  return true;
}

export function buildCoverPrompt(input: CoverGenerationRequest): string {
  const description = input.genre_description.trim();
  const rules = input.genre_rules.map((rule) => rule.trim()).filter(Boolean);
  const visualDirection = genreVisualDirection(input.genre_style);
  const context = [
    description ? `题材补充：${description}` : "",
    rules.length ? `题材约束：${rules.join("；")}` : "",
    visualDirection ? `画面方向：${visualDirection}` : ""
  ].filter(Boolean).join("\n");
  const editInstruction = input.mode === "image_to_image"
    ? "\n参考上传图片的画面主题、构图和色彩重新创作；清除参考图中的全部原有文字，并严格使用上述书名和署名。"
    : "";
  return [
    `做一张用于网络小说发布的竖版封面，${input.genre_style}风格。`,
    "必须包含且只包含以下两处中文文字：",
    `书名：“${input.book_title}”。书名单独排列；一行无法清晰排下时可自然分为多行，不得改字、漏字或增加文字。`,
    `作者署名：“${input.author_name} 著”。字号明显小于书名，单独一行，位于图片最下方安全区域。`,
    `书名字体风格：${input.font_style}。`,
    context,
    "专业网文封面，细节清晰的数字插画，人物、前景、中景和背景层次明确。",
    "不得出现其他文字、字母、数字、标签、标识、水印、Logo或装饰性伪文字。",
    "画面比例为3:4，关键人物、书名和署名位于中央约85%的安全区，四周保留裁切余量。",
    editInstruction
  ].filter(Boolean).join("\n");
}

function genreVisualDirection(genre: string): string {
  if (/仙侠|玄幻|修真|修仙/.test(genre)) return "青蓝、金色与玄黑，仙山云海、灵力光效和东方幻想氛围";
  if (/古言|宫斗|古代/.test(genre)) return "正红、金色与墨黑，古典宫殿、丝绸和暖色灯火";
  if (/现言|甜宠|言情/.test(genre)) return "暖白、浅金和柔和粉色，现代浪漫场景与温暖逆光";
  if (/悬疑|推理|刑侦/.test(genre)) return "黑、深灰和暗蓝，高反差阴影、雨夜或密室氛围";
  if (/科幻|末世|赛博/.test(genre)) return "深蓝、银黑和霓虹冷光，未来科技或末世城市";
  if (/西幻|魔法/.test(genre)) return "深蓝、暗金与银白，中世纪城堡、魔法光效和史诗氛围";
  if (/历史|军事/.test(genre)) return "铁灰、暗红与土黄，城墙、战场、烟尘和史诗光线";
  if (/灵异|恐怖/.test(genre)) return "墨黑、幽绿和暗红，克制的中式诡异氛围";
  if (/轻小说|二次元/.test(genre)) return "明亮多色的日系插画，清晰线稿和轻快粒子光效";
  if (/都市|校园|职场/.test(genre)) return "深蓝、灰色和金色点缀，现代城市与电影感光线";
  return "题材明确、主体突出、适合中文网络小说的专业数字插画";
}

type GeneratedImage = { content: Buffer; mediaType: string };

async function requestWebsiteCover(input: {
  payload: CoverGenerationRequest;
  prompt: string;
  reference: GeneratedImage | null;
  tokenKey: string;
  relayBaseUrl: string;
  model: WebsiteAiModelOption;
  fetchFn: typeof fetch;
  signal: AbortSignal;
}): Promise<GeneratedImage> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("封面生成超时，请稍后重试。")), GENERATION_TIMEOUT_MS);
  try {
    const preferredSize = selectImageSize(input.model);
    let result = await performImageRequest(input, preferredSize, controller.signal);
    if (!result.ok && result.status === 400 && preferredSize !== "1024x1536") {
      result = await performImageRequest(input, "1024x1536", controller.signal);
    }
    if (!result.ok) throw new Error(result.error || `网站生图请求失败：${result.status}`);
    return extractGeneratedImage(result.payload, input.fetchFn, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      if (input.signal.aborted) throw new Error("封面生成已取消。");
      throw new Error("封面生成超时，请稍后重试。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
  }
}

async function performImageRequest(
  input: Parameters<typeof requestWebsiteCover>[0],
  size: string,
  signal: AbortSignal
): Promise<{ ok: boolean; status: number; payload: unknown; error: string }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${input.tokenKey}` };
  let body: BodyInit;
  let endpoint: string;
  if (input.payload.mode === "image_to_image") {
    if (!input.reference || !input.payload.reference_image) throw new Error("图生图模式需要参考图片。");
    const form = new FormData();
    form.append("model", input.model.id);
    form.append("prompt", input.prompt);
    form.append("size", size);
    form.append("image", new Blob([new Uint8Array(input.reference.content)], { type: input.reference.mediaType }), input.payload.reference_image.filename);
    body = form;
    endpoint = "/images/edits";
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ model: input.model.id, prompt: input.prompt, size });
    endpoint = "/images/generations";
  }
  const response = await input.fetchFn(`${input.relayBaseUrl.replace(/\/+$/, "")}${endpoint}`, { method: "POST", headers, body, signal, redirect: "manual" });
  const raw = await readResponseBuffer(response, MAX_UPSTREAM_BYTES);
  const payload = parseJson(raw.toString("utf8"));
  return { ok: response.ok, status: response.status, payload, error: extractUpstreamError(payload) || response.statusText };
}

async function extractGeneratedImage(payload: unknown, fetchFn: typeof fetch, signal: AbortSignal): Promise<GeneratedImage> {
  const record = readRecord(payload);
  const first = Array.isArray(record?.data) ? readRecord(record.data[0]) : null;
  const base64 = stringValue(first?.b64_json || record?.b64_json).trim();
  if (base64) {
    const content = Buffer.from(base64, "base64");
    if (!content.length || content.length > MAX_UPSTREAM_BYTES) throw new Error("网站返回的封面图片为空或超过 20 MB。");
    return validateGeneratedImage(content);
  }
  const imageUrl = stringValue(first?.url || record?.url).trim();
  if (!imageUrl) throw new Error("网站生图接口没有返回可用图片。");
  return fetchRemoteImage(imageUrl, fetchFn, signal);
}

async function fetchRemoteImage(initialUrl: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<GeneratedImage> {
  let url = new URL(initialUrl);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (url.protocol !== "https:") throw new Error("网站返回了不安全的图片地址，已拒绝下载。");
    const response = await fetchFn(url, { signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new Error("封面图片地址重定向次数过多。");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`下载生成封面失败：${response.status}`);
    return validateGeneratedImage(await readResponseBuffer(response, MAX_UPSTREAM_BYTES));
  }
  throw new Error("无法下载生成封面。");
}

async function readResponseBuffer(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("网站返回内容超过 20 MB，已停止接收。");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function decodeReferenceImage(base64: string, declaredMediaType: string): GeneratedImage {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("参考图片数据无效，请重新选择图片。");
  const content = Buffer.from(base64, "base64");
  if (!content.length || content.length > MAX_REFERENCE_BYTES) throw new Error("参考图片不能超过 10 MB。");
  const mediaType = detectImageMediaType(content);
  if (!mediaType || mediaType !== declaredMediaType) throw new Error("参考图片格式与文件内容不一致。");
  return { content, mediaType };
}

export function detectImageMediaType(content: Buffer): string {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.length >= 12 && content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

function validateGeneratedImage(content: Buffer): GeneratedImage {
  const mediaType = detectImageMediaType(content);
  if (!mediaType) throw new Error("网站返回的内容不是受支持的图片格式。");
  return { content, mediaType };
}

export function selectImageSize(model: WebsiteAiModelOption): string {
  const sizes = model.supported_sizes.map((size) => {
    const [width = 0, height = 0] = size.split("x").map(Number);
    return { size, width, height, ratioDistance: Math.abs(width / height - 0.75) };
  }).filter((item) => item.width > 0 && item.height > item.width);
  const exact = sizes.filter((item) => item.ratioDistance < 0.001).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (exact) return exact.size;
  const nearest = sizes.sort((a, b) => a.ratioDistance - b.ratioDistance || b.width * b.height - a.width * a.height)[0];
  return nearest?.size || "768x1024";
}

export function computeCoverCropRect(width: number, height: number): CoverCropRect {
  const targetRatio = 600 / 800;
  let cropWidth = width;
  let cropHeight = height;
  if (width / height > targetRatio) cropWidth = Math.max(1, Math.floor(height * targetRatio));
  else cropHeight = Math.max(1, Math.floor(width / targetRatio));
  return {
    x: Math.max(0, Math.floor((width - cropWidth) / 2)),
    y: Math.max(0, Math.floor((height - cropHeight) / 2)),
    width: cropWidth,
    height: cropHeight
  };
}

class CoverStore {
  private readonly root: string;
  private readonly guard: CanonicalProjectPathGuard;

  constructor(projectRoot: string) {
    this.root = path.resolve(projectRoot);
    this.guard = new CanonicalProjectPathGuard(this.root);
  }

  async list(): Promise<CoverHistoryResponse> {
    const indexPath = await this.safePath(COVER_INDEX, true);
    const raw = await fs.readFile(indexPath, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "" : Promise.reject(error));
    if (!raw.trim()) return { records: [] };
    try {
      const parsed = JSON.parse(raw) as { records?: unknown };
      return coverHistoryResponseSchema.parse({ records: parsed.records || [] });
    } catch {
      throw new Error("封面历史索引无法读取，请检查项目中的封面索引文件。");
    }
  }

  async ensureCoverDirectory(): Promise<string> {
    const target = await this.safePath(COVER_DIR, true);
    await fs.mkdir(target, { recursive: true });
    return target;
  }

  async save(input: CoverGenerationRequest, model: WebsiteAiModelOption, original: GeneratedImage, finalPng: Buffer): Promise<CoverRecord> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const stamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
    const stem = `${stamp}-${safeFileStem(input.book_title)}-${id.slice(0, 8)}`;
    const originalExtension = original.mediaType === "image/jpeg" ? "jpg" : original.mediaType === "image/webp" ? "webp" : "png";
    const originalPath = `${COVER_DIR}/${stem}-原图.${originalExtension}`;
    const finalPath = `${COVER_DIR}/${stem}-600x800.png`;
    await this.ensureCoverDirectory();
    await atomicWrite(await this.safePath(originalPath, true), original.content);
    try {
      await atomicWrite(await this.safePath(finalPath, true), finalPng);
      const record: CoverRecord = {
        id,
        book_title: input.book_title,
        author_name: input.author_name,
        font_style: input.font_style,
        genre_style: input.genre_style,
        mode: input.mode,
        model: model.id,
        provider: model.provider,
        original_path: originalPath,
        final_path: finalPath,
        original_media_type: original.mediaType,
        width: 600,
        height: 800,
        created_at: createdAt
      };
      const history = await this.list();
      await this.writeIndex({ records: [record, ...history.records] });
      return record;
    } catch (error) {
      await fs.rm(await this.safePath(originalPath, true), { force: true });
      await fs.rm(await this.safePath(finalPath, true), { force: true });
      throw error;
    }
  }

  async readImage(id: string, variant: "original" | "final"): Promise<GeneratedImage> {
    const record = (await this.list()).records.find((item) => item.id === id);
    if (!record) throw new Error("封面版本不存在。");
    const content = await fs.readFile(await this.safePath(variant === "original" ? record.original_path : record.final_path));
    const mediaType = detectImageMediaType(content);
    if (!mediaType) throw new Error("封面图片文件已损坏。");
    return { content, mediaType };
  }

  async remove(id: string): Promise<void> {
    const history = await this.list();
    const record = history.records.find((item) => item.id === id);
    if (!record) throw new Error("封面版本不存在。");
    const trash = await this.safePath(COVER_TRASH_DIR, true);
    await fs.mkdir(trash, { recursive: true });
    for (const relative of [record.original_path, record.final_path]) {
      const source = await this.safePath(relative, true);
      const target = await this.safePath(`${COVER_TRASH_DIR}/${id}-${path.basename(relative)}`, true);
      await fs.rename(source, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await this.writeIndex({ records: history.records.filter((item) => item.id !== id) });
  }

  private async writeIndex(history: CoverHistoryResponse): Promise<void> {
    const target = await this.safePath(COVER_INDEX, true);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await atomicWrite(target, Buffer.from(`${JSON.stringify({ schema_version: 1, records: history.records }, null, 2)}\n`, "utf8"));
  }

  private async safePath(relativePath: string, allowMissing = false): Promise<string> {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized || normalized === ".." || normalized.startsWith("../")) throw new Error("非法封面文件路径。");
    return this.guard.assertPath(path.join(this.root, ...normalized.split("/")), { allowMissing });
  }
}

async function atomicWrite(target: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, target);
}

function safeFileStem(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/[. ]+$/g, "").slice(0, 40) || "小说封面";
}

function parseJson(value: string): unknown {
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

function extractUpstreamError(value: unknown): string {
  const record = readRecord(value);
  const error = readRecord(record?.error);
  return stringValue(error?.message || record?.detail || record?.message).trim();
}

function readRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
