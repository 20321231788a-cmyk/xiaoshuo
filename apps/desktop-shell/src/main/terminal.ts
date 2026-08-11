import { BrowserWindow } from "electron";
import os from "node:os";
import path from "node:path";
import {
  ipcChannels,
  terminalCreateRequestSchema,
  terminalKillRequestSchema,
  terminalResizeRequestSchema,
  terminalSessionSchema,
  terminalWriteRequestSchema,
  type TerminalCreateRequest,
  type TerminalKillRequest,
  type TerminalResizeRequest,
  type TerminalSession,
  type TerminalWriteRequest
} from "../shared/channels.js";

type PtyProcess = {
  pid: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
};

type NodePtyModule = {
  spawn: (shell: string, args: string[], options: { name: string; cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }) => PtyProcess;
};

type TerminalSessionRecord = {
  terminal: PtyProcess;
  ownerWebContentsId: number;
};

const sessions = new Map<string, TerminalSessionRecord>();

async function loadNodePty(): Promise<NodePtyModule> {
  try {
    return (await import("node-pty")) as NodePtyModule;
  } catch (error) {
    throw new Error(`node-pty is not available: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec || "powershell.exe";
  }

  return process.env.SHELL || "bash";
}

function defaultCwd(cwd?: string): string {
  return cwd ? path.resolve(cwd) : process.cwd();
}

function emitToOwner(ownerWebContentsId: number, channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.id === ownerWebContentsId && !window.isDestroyed()) {
      window.webContents.send(channel, payload);
      return;
    }
  }
}

function getOwnedTerminal(id: string, ownerWebContentsId: number): PtyProcess | undefined {
  const session = sessions.get(id);
  if (!session || session.ownerWebContentsId !== ownerWebContentsId) {
    return undefined;
  }
  return session.terminal;
}

export async function createTerminalSession(
  rawRequest: TerminalCreateRequest = {},
  ownerWebContentsId: number
): Promise<TerminalSession> {
  const request = terminalCreateRequestSchema.parse(rawRequest);
  const pty = await loadNodePty();
  const shell = request.shell || defaultShell();
  const cwd = defaultCwd(request.cwd);
  const id = `term-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const processEnv = { ...process.env, TERM: process.env.TERM || "xterm-256color" };

  const terminal = pty.spawn(shell, [], {
    name: "xterm-256color",
    cwd,
    env: processEnv,
    cols: request.cols,
    rows: request.rows
  });

  sessions.set(id, { terminal, ownerWebContentsId });

  terminal.onData((data) => {
    emitToOwner(ownerWebContentsId, ipcChannels.terminalData, { id, data });
  });

  terminal.onExit((event) => {
    sessions.delete(id);
    emitToOwner(ownerWebContentsId, ipcChannels.terminalExit, {
      id,
      exitCode: event.exitCode ?? null,
      signal: event.signal ?? null
    });
  });

  return terminalSessionSchema.parse({
    id,
    cwd,
    shell,
    cols: request.cols,
    rows: request.rows
  });
}

export function writeTerminal(rawRequest: TerminalWriteRequest, ownerWebContentsId: number): void {
  const request = terminalWriteRequestSchema.parse(rawRequest);
  const terminal = getOwnedTerminal(request.id, ownerWebContentsId);
  if (!terminal) {
    throw new Error(`Terminal session not found or access denied: ${request.id}`);
  }
  terminal.write(request.data);
}

export function resizeTerminal(rawRequest: TerminalResizeRequest, ownerWebContentsId: number): void {
  const request = terminalResizeRequestSchema.parse(rawRequest);
  const terminal = getOwnedTerminal(request.id, ownerWebContentsId);
  if (!terminal) {
    return;
  }
  terminal.resize(request.cols, request.rows);
}

export function killTerminal(rawRequest: TerminalKillRequest, ownerWebContentsId: number): void {
  const request = terminalKillRequestSchema.parse(rawRequest);
  const terminal = getOwnedTerminal(request.id, ownerWebContentsId);
  if (!terminal) {
    return;
  }
  terminal.kill();
  sessions.delete(request.id);
}

export function killTerminalsForOwner(ownerWebContentsId: number): void {
  for (const [id, session] of sessions) {
    if (session.ownerWebContentsId === ownerWebContentsId) {
      session.terminal.kill();
      sessions.delete(id);
    }
  }
}

export function killAllTerminals(): void {
  for (const [id, session] of sessions) {
    session.terminal.kill();
    sessions.delete(id);
  }
}

export function getTerminalEnvironmentSummary(): string {
  return `${os.platform()} ${os.release()}`;
}
