import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleConversationRoutes } from "./conversation-routes.js";
import type { RuntimeContext } from "./types.js";

const mockSendMessage = vi.hoisted(() => vi.fn());
const mockStreamMessage = vi.hoisted(() => vi.fn());
const mockWriteAiLicenseRequiredIfNeeded = vi.hoisted(() => vi.fn());
const mockGetProjectAgentRuntime = vi.hoisted(() => vi.fn());

vi.mock("@xiaoshuo/agent-runtime", () => ({
  AgentRuntimeService: class {
    sendMessage = mockSendMessage;
    streamMessage = mockStreamMessage;
  },
  encodeNdjsonEvent: vi.fn()
}));

vi.mock("./license-guard.js", () => ({
  writeAiLicenseRequiredIfNeeded: mockWriteAiLicenseRequiredIfNeeded
}));

vi.mock("./agent-runtime-registry.js", () => ({
  getProjectAgentRuntime: mockGetProjectAgentRuntime
}));

function createContext(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: { list: () => [] } as unknown as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function createRequest(method: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  const request = new EventEmitter() as IncomingMessage;
  Object.assign(request, { method, headers });
  Object.defineProperty(request, "aborted", { value: false, configurable: true });
  Object.defineProperty(request, "complete", { value: true, configurable: true });
  Object.defineProperty(request, "destroyed", { value: false, configurable: true });
  return request;
}

function createResponse(): ServerResponse {
  const response = new EventEmitter() as ServerResponse;
  let writableEnded = false;

  Object.defineProperty(response, "writableEnded", {
    get: () => writableEnded,
    configurable: true
  });
  Object.assign(response, {
    writeHead: vi.fn(),
    end: vi.fn(() => {
      writableEnded = true;
      response.emit("finish");
      response.emit("close");
    })
  });
  return response;
}

describe("handleConversationRoutes", () => {
  beforeEach(() => {
    mockGetProjectAgentRuntime.mockResolvedValue({
      sendMessage: mockSendMessage,
      streamMessage: mockStreamMessage
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when no project is open", async () => {
    const writeJson = vi.fn();

    const handled = await handleConversationRoutes(
      createRequest("GET"),
      createResponse(),
      "/api/conversations",
      createContext(),
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "" }),
        readJsonBody: vi.fn(),
        readRawBody: vi.fn(),
        parseJsonRecord: vi.fn(),
        stringValue: vi.fn(),
        writeJson,
        writeNdjsonEvent: vi.fn(),
        addCorsHeaders: vi.fn(),
        parseMultipartFile: vi.fn(),
        matchConversationRoute: vi.fn().mockReturnValue({})
      }
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 400, { detail: "尚未打开项目" });
  });

  it("rejects attachment uploads that are not multipart/form-data", async () => {
    const writeJson = vi.fn();

    const handled = await handleConversationRoutes(
      createRequest("POST", { "content-type": "application/json" }),
      createResponse(),
      "/api/conversations/conv-1/attachments",
      createContext(),
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
        readJsonBody: vi.fn(),
        readRawBody: vi.fn(),
        parseJsonRecord: vi.fn(),
        stringValue: vi.fn(),
        writeJson,
        writeNdjsonEvent: vi.fn(),
        addCorsHeaders: vi.fn(),
        parseMultipartFile: vi.fn(),
        matchConversationRoute: vi.fn().mockReturnValue({ id: "conv-1", action: "attachments" })
      }
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 400, {
      detail: "附件上传需要选择文件，请重新选择附件后上传。"
    });
  });

  it("streams NDJSON message events when accept requests a stream", async () => {
    const response = createResponse();
    const addCorsHeaders = vi.fn();
    const writeNdjsonEvent = vi.fn();
    const writeJson = vi.fn();
    const payload = { content: "继续", attachment_ids: [] };
    mockWriteAiLicenseRequiredIfNeeded.mockResolvedValue(false);

    mockStreamMessage.mockImplementation(async function* () {
      yield { type: "message_start", conversation_id: "conv-1" };
      yield { type: "message_delta", delta: "hello" };
    });

    const handled = await handleConversationRoutes(
      createRequest("POST", { accept: "application/x-ndjson" }),
      response,
      "/api/conversations/conv-1/messages",
      createContext(),
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
        readJsonBody: vi.fn(),
        readRawBody: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(payload), "utf8")),
        parseJsonRecord: vi.fn().mockReturnValue(payload),
        stringValue: vi.fn(),
        writeJson,
        writeNdjsonEvent,
        addCorsHeaders,
        parseMultipartFile: vi.fn(),
        matchConversationRoute: vi.fn().mockReturnValue({ id: "conv-1", action: "messages" })
      }
    );

    expect(handled).toBe(true);
    expect(addCorsHeaders).toHaveBeenCalledWith(response);
    expect(response.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
    expect(writeNdjsonEvent).toHaveBeenNthCalledWith(1, response, { type: "message_start", conversation_id: "conv-1" });
    expect(writeNdjsonEvent).toHaveBeenNthCalledWith(2, response, { type: "message_delta", delta: "hello" });
    expect(mockStreamMessage).toHaveBeenCalledWith("conv-1", expect.objectContaining(payload), {});
    expect(response.end).toHaveBeenCalled();
    expect(writeJson).not.toHaveBeenCalled();
  });

  it("blocks AI conversation messages when the account is not licensed", async () => {
    const writeJson = vi.fn();
    mockWriteAiLicenseRequiredIfNeeded.mockImplementation(async (_context, response, write) => {
      write(response, 403, { detail: "当前账号未授权", code: "AI_LICENSE_REQUIRED" });
      return true;
    });

    const handled = await handleConversationRoutes(
      createRequest("POST"),
      createResponse(),
      "/api/conversations/conv-1/messages",
      createContext(),
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
        readJsonBody: vi.fn(),
        readRawBody: vi.fn(),
        parseJsonRecord: vi.fn(),
        stringValue: vi.fn(),
        writeJson,
        writeNdjsonEvent: vi.fn(),
        addCorsHeaders: vi.fn(),
        parseMultipartFile: vi.fn(),
        matchConversationRoute: vi.fn().mockReturnValue({ id: "conv-1", action: "messages" })
      }
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 403, {
      detail: "当前账号未授权",
      code: "AI_LICENSE_REQUIRED"
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockStreamMessage).not.toHaveBeenCalled();
  });
});
