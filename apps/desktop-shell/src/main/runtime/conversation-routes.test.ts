import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleConversationRoutes } from "./conversation-routes.js";
import type { RuntimeContext } from "./types.js";

const mockSendMessage = vi.fn();
const mockStreamMessage = vi.fn();

vi.mock("@xiaoshuo/agent-runtime", () => ({
  AgentRuntimeService: class {
    sendMessage = mockSendMessage;
    streamMessage = mockStreamMessage;
  },
  encodeNdjsonEvent: vi.fn()
}));

function createContext(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: { list: () => [] } as unknown as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function createResponse() {
  return {
    writeHead: vi.fn(),
    end: vi.fn()
  } as unknown as ServerResponse;
}

describe("handleConversationRoutes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when no project is open", async () => {
    const writeJson = vi.fn();

    const handled = await handleConversationRoutes(
      { method: "GET", headers: {} } as IncomingMessage,
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
      {
        method: "POST",
        headers: { "content-type": "application/json" }
      } as IncomingMessage,
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

    mockStreamMessage.mockImplementation(async function* () {
      yield { type: "message_start", conversation_id: "conv-1" };
      yield { type: "message_delta", delta: "hello" };
    });

    const handled = await handleConversationRoutes(
      {
        method: "POST",
        headers: { accept: "application/x-ndjson" }
      } as IncomingMessage,
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
    expect(response.end).toHaveBeenCalled();
    expect(writeJson).not.toHaveBeenCalled();
  });
});
