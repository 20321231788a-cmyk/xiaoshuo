import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  booleanValue,
  createRequestAbortSignal,
  parseJsonRecord,
  parseMultipartFile,
  readBooleanQuery,
  readIntQuery,
  stringValue,
  stripTrailingSlash
} from "./http-utils.js";
import {
  matchCardDrawRoute,
  matchConversationRoute,
  matchDocumentRoute,
  matchSkillRoute,
  matchTimelineRoute
} from "./route-matchers.js";

describe("runtime route matchers", () => {
  it("matches document and timeline routes", () => {
    expect(matchDocumentRoute("/api/documents/01_%E5%A4%A7%E7%BA%B2/%E5%A4%A7%E7%BA%B2.txt")).toBe("01_大纲/大纲.txt");
    expect(matchTimelineRoute("/api/timeline/entry-1")).toEqual({ id: "entry-1", action: undefined });
    expect(matchTimelineRoute("/api/timeline/entry-1/rollback")).toEqual({ id: "entry-1", action: "rollback" });
    expect(matchTimelineRoute("/api/timeline")).toBeNull();
  });

  it("matches conversation, skill, and card-draw routes", () => {
    expect(matchConversationRoute("/api/conversations")).toEqual({});
    expect(matchConversationRoute("/api/conversations/conv-1/messages")).toEqual({ id: "conv-1", action: "messages" });
    expect(matchConversationRoute("/api/conversations/conv-1/attachments/file-1")).toEqual({
      id: "conv-1",
      action: "attachments",
      itemId: "file-1"
    });

    expect(matchSkillRoute("/api/skills")).toEqual({});
    expect(matchSkillRoute("/api/skills/import")).toEqual({ action: "import" });
    expect(matchSkillRoute("/api/skills/outline_generate/run")).toEqual({ id: "outline_generate", action: "run" });

    expect(matchCardDrawRoute("/api/card-draw/draw-1/select")).toEqual({ drawId: "draw-1", action: "select" });
  });
});

describe("runtime http utils", () => {
  it("parses JSON records and query helpers", () => {
    expect(parseJsonRecord(Buffer.from('{"name":"smoke","count":2}', "utf8"))).toEqual({ name: "smoke", count: 2 });
    expect(parseJsonRecord(Buffer.from("[]", "utf8"))).toEqual({});
    expect(readBooleanQuery("true")).toBe(true);
    expect(readBooleanQuery("0")).toBe(false);
    expect(readIntQuery("120", 80, 1, 100)).toBe(100);
    expect(readIntQuery("abc", 80, 1, 100)).toBe(80);
  });

  it("normalizes string and boolean helpers", () => {
    expect(stringValue(undefined)).toBe("");
    expect(stringValue(42)).toBe("42");
    expect(booleanValue("yes")).toBe(true);
    expect(booleanValue("off")).toBe(false);
    expect(stripTrailingSlash("/api/skills/")).toBe("/api/skills");
  });

  it("parses multipart file payloads", () => {
    const boundary = "----SmokeBoundary";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`, "utf8"),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="smoke.txt"\r\n`, "utf8"),
      Buffer.from(`Content-Type: text/plain\r\n\r\n`, "utf8"),
      Buffer.from("hello runtime", "utf8"),
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
    ]);

    expect(parseMultipartFile(payload, `multipart/form-data; boundary=${boundary}`)).toEqual({
      filename: "smoke.txt",
      mediaType: "text/plain",
      content: Buffer.from("hello runtime", "utf8")
    });
  });

  it("aborts request-scoped signals when the request aborts", () => {
    const { request, response } = createHttpAbortHarness();
    const signal = createRequestAbortSignal(request, response);

    request.emit("aborted");

    expect(signal.aborted).toBe(true);
  });

  it("aborts request-scoped signals when the request closes before completion", () => {
    const { request, response } = createHttpAbortHarness({ requestComplete: false });
    const signal = createRequestAbortSignal(request, response);

    request.emit("close");

    expect(signal.aborted).toBe(true);
  });

  it("aborts request-scoped signals when the response closes early", () => {
    const { request, response } = createHttpAbortHarness();
    const signal = createRequestAbortSignal(request, response);

    response.emit("close");

    expect(signal.aborted).toBe(true);
  });

  it("does not abort request-scoped signals on normal response close", () => {
    const { request, response, endResponse } = createHttpAbortHarness();
    const signal = createRequestAbortSignal(request, response);

    endResponse();
    response.emit("close");

    expect(signal.aborted).toBe(false);
  });
});

function createHttpAbortHarness(options: { requestComplete?: boolean } = {}): {
  request: IncomingMessage;
  response: ServerResponse;
  endResponse: () => void;
} {
  const request = new EventEmitter() as IncomingMessage;
  const response = new EventEmitter() as ServerResponse;
  let writableEnded = false;

  Object.defineProperty(request, "aborted", { value: false, configurable: true });
  Object.defineProperty(request, "complete", { value: options.requestComplete ?? true, configurable: true });
  Object.defineProperty(response, "writableEnded", {
    get: () => writableEnded,
    configurable: true
  });

  return {
    request,
    response,
    endResponse: () => {
      writableEnded = true;
    }
  };
}
