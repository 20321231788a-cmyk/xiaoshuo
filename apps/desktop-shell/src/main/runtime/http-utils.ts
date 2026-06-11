import { encodeNdjsonEvent } from "@xiaoshuo/agent-runtime";
import type { IncomingMessage, ServerResponse } from "node:http";

export type JsonRecord = Record<string, unknown>;

export async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  return parseJsonRecord(await readRawBody(request));
}

export async function readRequestFields(request: IncomingMessage): Promise<JsonRecord> {
  const rawBody = await readRawBody(request);
  if (!rawBody.length) {
    return {};
  }

  const contentType = stringValue(request.headers["content-type"]).toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const fields: JsonRecord = {};
    const params = new URLSearchParams(rawBody.toString("utf8"));
    for (const [key, value] of params.entries()) {
      fields[key] = value;
    }
    return fields;
  }

  return parseJsonRecord(rawBody);
}

export function parseJsonRecord(rawBody: Buffer): JsonRecord {
  const text = rawBody.toString("utf8").trim();
  if (!text) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  return isRecord(parsed) ? parsed : {};
}

export async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent) {
    return;
  }
  addCorsHeaders(response);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

export function writeNdjsonEvent(response: ServerResponse, payload: Parameters<typeof encodeNdjsonEvent>[0]): void {
  if (response.writableEnded) {
    return;
  }
  response.write(encodeNdjsonEvent(payload));
}

export function addCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

export function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = stringValue(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function readBooleanQuery(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function readIntQuery(value: string | null | undefined, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

export function parseMultipartFile(body: Buffer, contentType: string): { filename: string; mediaType: string; content: Buffer } {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    throw new Error("No boundary found in Content-Type");
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  if (!boundary) {
    throw new Error("Empty boundary found in Content-Type");
  }
  const boundaryStr = `--${boundary}`;
  const boundaryBuf = Buffer.from(boundaryStr);

  const firstIndex = body.indexOf(boundaryBuf);
  if (firstIndex === -1) {
    throw new Error("Invalid multipart payload: boundary not found");
  }

  const headerStartIndex = firstIndex + boundaryBuf.length;
  const headerEndIndex = body.indexOf(Buffer.from("\r\n\r\n"), headerStartIndex);
  if (headerEndIndex === -1) {
    throw new Error("Invalid multipart payload: header end not found");
  }

  const headersStr = body.subarray(headerStartIndex, headerEndIndex).toString("utf8");
  const filenameMatch = headersStr.match(/filename="([^"]+)"/i);
  const fileContentTypeMatch = headersStr.match(/content-type:\s*([^\r\n]+)/i);

  if (!filenameMatch || !filenameMatch[1]) {
    throw new Error("No filename found in multipart header");
  }

  const filename = filenameMatch[1];
  const mediaType = fileContentTypeMatch && fileContentTypeMatch[1] ? fileContentTypeMatch[1].trim() : "application/octet-stream";
  const contentStartIndex = headerEndIndex + 4;
  const nextBoundaryIndex = body.indexOf(boundaryBuf, contentStartIndex);
  if (nextBoundaryIndex === -1) {
    throw new Error("Invalid multipart payload: closing boundary not found");
  }

  let contentEndIndex = nextBoundaryIndex;
  if (nextBoundaryIndex >= 2 && body[nextBoundaryIndex - 2] === 13 && body[nextBoundaryIndex - 1] === 10) {
    contentEndIndex = nextBoundaryIndex - 2;
  }

  const content = body.subarray(contentStartIndex, contentEndIndex);
  return { filename, mediaType, content };
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
