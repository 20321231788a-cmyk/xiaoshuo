import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Eraser, FolderSearch, GitBranch, ListTree, PackageCheck, PlugZap, RotateCcw, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Panel } from "../components/Panel.js";
import type { DashboardSnapshot } from "../lib/dashboard.js";
import type { WorkbenchRuntime } from "../lib/runtime.js";

export function TerminalView({
  runtime,
  snapshot
}: {
  runtime: WorkbenchRuntime;
  snapshot: DashboardSnapshot;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef("");
  const [status, setStatus] = useState("等待连接终端");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [sessionShell, setSessionShell] = useState("");
  const [allowAppDirectoryTerminal, setAllowAppDirectoryTerminal] = useState(false);
  const terminalReady = Boolean(runtime.isDesktopShell && window.xiaoshuoDesktop?.terminal);
  const hasProject = Boolean(snapshot.currentProject.path);
  const configuredCwd = hasProject ? snapshot.currentProject.path : undefined;
  const canStartTerminal = terminalReady && (hasProject || allowAppDirectoryTerminal);
  const quickCommands = buildQuickCommands(sessionShell);

  function setActiveSession(id: string) {
    sessionIdRef.current = id;
    setSessionId(id);
  }

  async function startTerminal() {
    if (!canStartTerminal || !containerRef.current || busy) {
      return;
    }

    setBusy(true);
    setStatus("正在启动终端...");
    const terminal = terminalRef.current || createTerminal();
    const fitAddon = fitAddonRef.current;
    if (!terminal.element) {
      terminal.open(containerRef.current);
    }
    fitAddon?.fit();

    try {
      const currentId = sessionIdRef.current;
      if (currentId) {
        await window.xiaoshuoDesktop!.terminal.kill({ id: currentId });
        setActiveSession("");
      }
      const cols = Math.max(terminal.cols, 100);
      const rows = Math.max(terminal.rows, 24);
      const session = await window.xiaoshuoDesktop!.terminal.create({
        cwd: configuredCwd,
        cols,
        rows
      });
      setActiveSession(session.id);
      setSessionShell(session.shell);
      terminal.clear();
      terminal.writeln(`Connected: ${session.shell}`);
      terminal.writeln(`CWD: ${session.cwd}`);
      terminal.writeln("");
      setStatus(`终端已连接：${session.cwd}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "终端启动失败";
      terminal.writeln(`\r\n${message}`);
      setStatus(message);
    } finally {
      setBusy(false);
    }
  }

  function createTerminal() {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "Cascadia Mono, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#17201f",
        foreground: "#f7f1e5",
        cursor: "#f7f1e5",
        selectionBackground: "#35524e"
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.onData((data) => {
      const id = sessionIdRef.current;
      if (id) {
        void window.xiaoshuoDesktop?.terminal.write({ id, data });
      }
    });
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    return terminal;
  }

  async function sendCommand(command: string, label: string) {
    const id = sessionIdRef.current;
    if (!canStartTerminal || !id) {
      setStatus("终端还没有连接，先重启终端建立会话。");
      return;
    }

    await window.xiaoshuoDesktop!.terminal.write({ id, data: `${command}\r` });
    terminalRef.current?.focus();
    setStatus(`已发送：${label}`);
  }

  function clearTerminal() {
    terminalRef.current?.clear();
    terminalRef.current?.focus();
    setStatus(sessionIdRef.current ? "终端已清屏" : "终端还没有连接。");
  }

  useEffect(() => {
    if (!canStartTerminal) {
      return;
    }

    const unsubscribeData = window.xiaoshuoDesktop!.terminal.onData((event) => {
      if (event.id === sessionIdRef.current) {
        terminalRef.current?.write(event.data);
      }
    });
    const unsubscribeExit = window.xiaoshuoDesktop!.terminal.onExit((event) => {
      if (event.id === sessionIdRef.current) {
        terminalRef.current?.writeln(`\r\n[terminal exited: ${event.exitCode ?? "unknown"}]`);
        setActiveSession("");
        setStatus("终端已退出");
      }
    });

    return () => {
      unsubscribeData();
      unsubscribeExit();
      const id = sessionIdRef.current;
      if (id) {
        void window.xiaoshuoDesktop?.terminal.kill({ id });
      }
      setActiveSession("");
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [canStartTerminal, configuredCwd]);

  useEffect(() => {
    if (!terminalReady) {
      return;
    }

    const handleResize = () => {
      const fitAddon = fitAddonRef.current;
      const terminal = terminalRef.current;
      const id = sessionIdRef.current;
      if (!fitAddon || !terminal) {
        return;
      }
      fitAddon.fit();
      if (id) {
        void window.xiaoshuoDesktop?.terminal.resize({ id, cols: terminal.cols, rows: terminal.rows });
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [terminalReady]);

  return (
    <div className="content-stack">
      <Panel
        eyebrow="Local Terminal"
        title="桌面终端"
        aside={
          <div className="action-pair">
            <button className="ghost-button" onClick={clearTerminal} disabled={!terminalReady}>
              <Eraser size={15} />
              <span>清屏</span>
            </button>
            <button
              className="ghost-button"
              data-terminal-user-gesture
              data-testid="terminal-start"
              onClick={() => void startTerminal()}
              disabled={!canStartTerminal || busy}
            >
              <RotateCcw size={15} />
              <span>{busy ? "连接中" : sessionId ? "重启终端" : "连接终端"}</span>
            </button>
          </div>
        }
      >
        <div className="status-banner compact-banner">
          <strong>
            {terminalReady
              ? hasProject || allowAppDirectoryTerminal
                ? status
                : "还没有打开项目，终端不会自动启动，避免命令跑到应用目录。"
              : "终端只在 Electron 桌面壳内可用，浏览器预览会保留这个占位页。"}
          </strong>
          <p data-testid="terminal-session-id">{sessionId ? `会话 ${sessionId}` : configuredCwd || "未打开项目"}</p>
        </div>

        {terminalReady && !hasProject && !allowAppDirectoryTerminal && (
          <div className="terminal-placeholder" data-testid="terminal-project-required">
            <PlugZap size={22} />
            <div>
              <strong>先打开小说项目再使用终端</strong>
              <p>这样 Git 状态、TS 校验等快捷命令会在项目目录里执行，避免误跑到桌面壳启动目录。</p>
            </div>
            <button className="ghost-button" onClick={() => setAllowAppDirectoryTerminal(true)}>
              <span>仍在应用目录打开</span>
            </button>
          </div>
        )}

        {terminalReady && (hasProject || allowAppDirectoryTerminal) ? (
          <>
            <div className="terminal-command-grid" data-testid="terminal-command-grid">
              {quickCommands.map((command) => (
                <button
                  key={command.label}
                  className="terminal-command-button"
                  onClick={() => void sendCommand(command.command, command.label)}
                  disabled={!sessionId || busy || !hasProject}
                >
                  <command.icon size={15} />
                  <span>{command.label}</span>
                </button>
              ))}
            </div>
            <div className="terminal-shell" data-testid="terminal-shell" ref={containerRef} />
          </>
        ) : !terminalReady ? (
          <div className="terminal-placeholder" data-testid="terminal-placeholder">
            <PlugZap size={22} />
            <div>
              <strong>等待桌面壳连接</strong>
              <p>打开 Electron 壳后，这里会接入 node-pty，并把当前项目目录作为默认工作目录。</p>
            </div>
          </div>
        ) : null}
      </Panel>

      <Panel eyebrow="Capability" title="终端能力状态" aside={<TerminalSquare size={17} />}>
        <dl className="detail-list">
          <div>
            <dt>node-pty</dt>
            <dd>{snapshot.desktopCapabilities?.terminal.available ? "可用" : snapshot.desktopCapabilities?.terminal.reason || "未启用桌面能力"}</dd>
          </div>
          <div>
            <dt>工作目录</dt>
            <dd>{configuredCwd || (allowAppDirectoryTerminal ? "应用目录" : "未打开项目")}</dd>
          </div>
          <div>
            <dt>当前 Shell</dt>
            <dd>{sessionShell || "未连接"}</dd>
          </div>
          <div>
            <dt>运行模式</dt>
            <dd>{runtime.launchMode === "desktop" ? "Electron 桌面壳" : "浏览器预览"}</dd>
          </div>
        </dl>
      </Panel>
    </div>
  );
}

function buildQuickCommands(shell: string) {
  const normalizedShell = shell.toLowerCase();
  const isPowerShell = normalizedShell.includes("powershell") || normalizedShell.includes("pwsh");
  const isCmd = normalizedShell.includes("cmd.exe") || normalizedShell.endsWith("\\cmd") || normalizedShell === "cmd";

  if (isPowerShell) {
    return [
      { label: "当前位置", command: "Get-Location", icon: FolderSearch },
      { label: "列目录", command: "Get-ChildItem", icon: ListTree },
      { label: "Git 状态", command: "git status --short", icon: GitBranch },
      { label: "TS 校验", command: "if (Test-Path package.json) { npm run typecheck } else { Write-Host 'package.json not found' }", icon: PackageCheck }
    ];
  }

  if (isCmd || !normalizedShell) {
    return [
      { label: "当前位置", command: "cd", icon: FolderSearch },
      { label: "列目录", command: "dir", icon: ListTree },
      { label: "Git 状态", command: "git status --short", icon: GitBranch },
      { label: "TS 校验", command: "if exist package.json (npm run typecheck) else (echo package.json not found)", icon: PackageCheck }
    ];
  }

  return [
    { label: "当前位置", command: "pwd", icon: FolderSearch },
    { label: "列目录", command: "ls -la", icon: ListTree },
    { label: "Git 状态", command: "git status --short", icon: GitBranch },
    { label: "TS 校验", command: "test -f package.json && npm run typecheck || echo package.json not found", icon: PackageCheck }
  ];
}
