import fs from "node:fs/promises";
import path from "node:path";

const probeFlag = "--rc-upgrade-smoke";
const projectArgument = "--rc-upgrade-smoke-project";
const resultArgument = "--rc-upgrade-smoke-result";
const runArgument = "--rc-upgrade-smoke-run-id";

export type UpgradeSmokeProbeRequest = {
  projectRoot: string;
  resultPath: string;
  runId: string;
};

type ProbeFetch = typeof fetch;

export function parseUpgradeSmokeProbeRequest(
  argv: readonly string[],
  isPackaged: boolean
): UpgradeSmokeProbeRequest | null {
  if (!argv.includes(probeFlag)) {
    return null;
  }
  if (!isPackaged) {
    throw new Error("RC upgrade smoke probe is available only in a packaged application");
  }
  const projectRoot = argumentValue(argv, projectArgument);
  const resultPath = argumentValue(argv, resultArgument);
  const runId = argumentValue(argv, runArgument);
  if (!path.isAbsolute(projectRoot) || !path.isAbsolute(resultPath)) {
    throw new Error("RC upgrade smoke project and result paths must be absolute");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(runId)) {
    throw new Error("RC upgrade smoke run ID is invalid");
  }
  return {
    projectRoot: path.resolve(projectRoot),
    resultPath: path.resolve(resultPath),
    runId
  };
}

export async function runUpgradeSmokeProbe(
  request: UpgradeSmokeProbeRequest,
  options: {
    runtimeUrl: string;
    sessionToken: string;
    appVersion: string;
    fetchImpl?: ProbeFetch;
    now?: () => Date;
  }
): Promise<void> {
  const now = options.now ?? (() => new Date());
  let evidence: Record<string, unknown>;
  try {
    if (!options.sessionToken) {
      throw new Error("local runtime session token is unavailable");
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const headers = {
      Authorization: `Bearer ${options.sessionToken}`,
      "Content-Type": "application/json"
    };
    const openResponse = await fetchImpl(`${options.runtimeUrl}/api/projects/open`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: request.projectRoot })
    });
    const opened = await readJsonResponse(openResponse, "open project");
    const openedPath = String(opened.path || "");
    if (!samePath(openedPath, request.projectRoot)) {
      throw new Error(`runtime opened an unexpected project: ${openedPath || "<empty>"}`);
    }

    const runsResponse = await fetchImpl(`${options.runtimeUrl}/api/agent/runs?limit=200`, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.sessionToken}` }
    });
    const runList = await readJsonResponse(runsResponse, "list durable runs");
    const runs = Array.isArray(runList.runs) ? runList.runs : [];
    const observed = runs.find((candidate) =>
      candidate && typeof candidate === "object" && String((candidate as Record<string, unknown>).run_id || "") === request.runId
    ) as Record<string, unknown> | undefined;
    if (!observed) {
      throw new Error(`durable run was not visible after installed runtime startup: ${request.runId}`);
    }
    if (!samePath(String(observed.project_path || ""), request.projectRoot)) {
      throw new Error("durable run project path does not match the opened project");
    }
    const projectId = String(observed.project_id || "");
    if (!projectId) {
      throw new Error("durable run did not expose a project identity");
    }

    evidence = {
      schema_version: 1,
      kind: "upgrade-rollback-runtime-probe",
      ok: true,
      app_version: options.appVersion,
      project_root: request.projectRoot,
      opened_project_path: openedPath,
      project_id: projectId,
      pending_run: {
        run_id: request.runId,
        status: String(observed.status || "")
      },
      verified_at: now().toISOString()
    };
  } catch (error) {
    evidence = {
      schema_version: 1,
      kind: "upgrade-rollback-runtime-probe",
      ok: false,
      app_version: options.appVersion,
      project_root: request.projectRoot,
      pending_run: { run_id: request.runId },
      error: error instanceof Error ? error.message : String(error),
      verified_at: now().toISOString()
    };
  }

  await fs.mkdir(path.dirname(request.resultPath), { recursive: true });
  await fs.writeFile(request.resultPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  if (evidence.ok !== true) {
    throw new Error(String(evidence.error || "RC upgrade smoke probe failed"));
  }
}

function argumentValue(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : "";
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} is required by ${probeFlag}`);
  }
  if (argv.indexOf(name, index + 1) >= 0) {
    throw new Error(`${name} must be provided exactly once`);
  }
  return value;
}

async function readJsonResponse(response: Response, operation: string): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}: ${raw.slice(0, 500)}`);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("response was not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function samePath(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
