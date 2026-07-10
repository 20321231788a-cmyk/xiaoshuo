import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const windows = [
    { isDestroyed: () => false, webContents: { id: 101, send: vi.fn() } },
    { isDestroyed: () => false, webContents: { id: 202, send: vi.fn() } }
  ];
  const terminal = {
    pid: 1,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn()
  };
  return { terminal, windows, spawn: vi.fn(() => terminal) };
});

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => mocks.windows }
}));
vi.mock("node-pty", () => ({ spawn: mocks.spawn }));

import { createTerminalSession, killAllTerminals, killTerminal, resizeTerminal, writeTerminal } from "./terminal.js";

describe("terminal session ownership", () => {
  afterEach(() => {
    killAllTerminals();
    mocks.terminal.write.mockClear();
    mocks.terminal.resize.mockClear();
    mocks.terminal.kill.mockClear();
    mocks.terminal.onData.mockClear();
    mocks.terminal.onExit.mockClear();
    mocks.windows[0]!.webContents.send.mockClear();
    mocks.windows[1]!.webContents.send.mockClear();
  });

  it("limits terminal control and output to its creating renderer", async () => {
    const session = await createTerminalSession({}, 101);

    writeTerminal({ id: session.id, data: "echo trusted" }, 101);
    expect(mocks.terminal.write).toHaveBeenCalledWith("echo trusted");
    expect(() => writeTerminal({ id: session.id, data: "echo denied" }, 202)).toThrow("access denied");

    resizeTerminal({ id: session.id, cols: 120, rows: 40 }, 202);
    killTerminal({ id: session.id }, 202);
    expect(mocks.terminal.resize).not.toHaveBeenCalled();
    expect(mocks.terminal.kill).not.toHaveBeenCalled();

    const onData = mocks.terminal.onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined;
    expect(onData).toBeTypeOf("function");
    onData?.("private output");
    expect(mocks.windows[0]!.webContents.send).toHaveBeenCalledWith("terminal:data", { id: session.id, data: "private output" });
    expect(mocks.windows[1]!.webContents.send).not.toHaveBeenCalled();
  });
});
