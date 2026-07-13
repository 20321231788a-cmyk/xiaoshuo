import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseUpgradeSmokeProbeRequest, runUpgradeSmokeProbe } from "./upgrade-smoke-probe.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("upgrade smoke probe", () => {
  it("accepts a complete packaged-only request", async () => {
    const root = await tempRoot();
    const projectRoot = path.join(root, "project");
    const resultPath = path.join(root, "result", "probe.json");
    expect(parseUpgradeSmokeProbeRequest([
      "ArcWriter.exe",
      "--rc-upgrade-smoke",
      "--rc-upgrade-smoke-project",
      projectRoot,
      "--rc-upgrade-smoke-result",
      resultPath,
      "--rc-upgrade-smoke-run-id",
      "rc-upgrade-pending-run"
    ], true)).toEqual({ projectRoot, resultPath, runId: "rc-upgrade-pending-run" });
    expect(() => parseUpgradeSmokeProbeRequest([
      "--rc-upgrade-smoke",
      "--rc-upgrade-smoke-project",
      projectRoot
    ], false)).toThrow("packaged application");
  });

  it("opens the project through the authenticated runtime and records the pending run", async () => {
    const root = await tempRoot();
    const projectRoot = path.join(root, "project");
    const resultPath = path.join(root, "result", "probe.json");
    const requests: Array<{ url: string; authorization: string }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get("authorization") || "" });
      if (url.endsWith("/api/projects/open")) {
        return Response.json({ path: projectRoot, name: "project" });
      }
      return Response.json({
        runs: [{
          run_id: "rc-upgrade-pending-run",
          project_id: "f745c8a6-21c2-4f33-bf72-66cab8d0eb30",
          project_path: projectRoot,
          status: "queued"
        }]
      });
    };

    await runUpgradeSmokeProbe(
      { projectRoot, resultPath, runId: "rc-upgrade-pending-run" },
      {
        runtimeUrl: "http://127.0.0.1:18453",
        sessionToken: "secret-session-token",
        appVersion: "0.4.1",
        fetchImpl: fetchImpl as typeof fetch,
        now: () => new Date("2026-07-13T01:02:03.000Z")
      }
    );

    const evidence = JSON.parse(await fs.readFile(resultPath, "utf8"));
    expect(evidence).toMatchObject({
      ok: true,
      app_version: "0.4.1",
      project_root: projectRoot,
      project_id: "f745c8a6-21c2-4f33-bf72-66cab8d0eb30",
      pending_run: { run_id: "rc-upgrade-pending-run", status: "queued" }
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.authorization === "Bearer secret-session-token")).toBe(true);
    expect(await fs.readFile(resultPath, "utf8")).not.toContain("secret-session-token");
  });

  it("writes fail-closed evidence when the installed runtime cannot see the expected run", async () => {
    const root = await tempRoot();
    const projectRoot = path.join(root, "project");
    const resultPath = path.join(root, "probe.json");
    const fetchImpl = async (input: string | URL | Request) =>
      String(input).endsWith("/api/projects/open")
        ? Response.json({ path: projectRoot })
        : Response.json({ runs: [] });

    await expect(runUpgradeSmokeProbe(
      { projectRoot, resultPath, runId: "rc-upgrade-pending-run" },
      {
        runtimeUrl: "http://127.0.0.1:18453",
        sessionToken: "secret-session-token",
        appVersion: "0.4.1",
        fetchImpl: fetchImpl as typeof fetch
      }
    )).rejects.toThrow("durable run was not visible");
    await expect(fs.readFile(resultPath, "utf8")).resolves.toContain('"ok": false');
  });
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-upgrade-probe-"));
  roots.push(root);
  return root;
}
