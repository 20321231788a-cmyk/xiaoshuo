import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentService } from "@xiaoshuo/document-service";
import type { FileOperation } from "@xiaoshuo/shared";
import { GeneratedSavePlanner, type GeneratedSavePlanInput } from "./generated-save-planner.js";

type GeneratedSaveEvalCase = {
  id: string;
  kind: "generated_save";
  input: GeneratedSavePlanInput;
  expected_write: boolean;
  expected_requires_confirmation: boolean;
  expected_targets?: string[];
  expected_mode?: "replace" | "append";
};

type OperationConfirmationEvalCase = {
  id: string;
  kind: "operation_confirmation";
  operations: FileOperation[];
  expected_requires_confirmation: boolean;
};

type SavePolicyEvalCase = GeneratedSaveEvalCase | OperationConfirmationEvalCase;

type EvalResult = {
  id: string;
  expected: string;
  actual: string;
};

const WRITE_DECISION_THRESHOLD = 0.95;
const DESTRUCTIVE_CONFIRMATION_THRESHOLD = 1;
let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-save-policy-eval-"));
  configPath = path.join(tempDir, "studio_config.json");
  await fs.writeFile(configPath, "{}\n", "utf8");
  await fs.mkdir(path.join(tempDir, "00_设定集", "风格库"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "00_设定集", "题材库"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "02_正文"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "已有大纲", "utf8");
  await fs.writeFile(path.join(tempDir, "02_正文", "第001章.txt"), "已有正文", "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

async function readJsonl<T>(filename: string): Promise<T[]> {
  const raw = await fs.readFile(new URL(`../evals/${filename}`, import.meta.url), "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${filename}:${index + 1} is not valid JSONL: ${message}`);
      }
    });
}

function formatFailures(failures: EvalResult[]): string {
  return failures.map((failure) => `${failure.id}: expected ${failure.expected}, got ${failure.actual}`).join("\n");
}

describe("P4 generated save policy eval", () => {
  it("keeps write decision accuracy above the eval threshold", async () => {
    const planner = createDeterministicSavePlanner();
    const cases = (await readJsonl<SavePolicyEvalCase>("save-policy-cases.jsonl")).filter(
      (testCase): testCase is GeneratedSaveEvalCase => testCase.kind === "generated_save"
    );
    expect(cases.length).toBeGreaterThan(0);
    const results: EvalResult[] = [];

    for (const testCase of cases) {
      const plan = await planner.planGeneratedSave(testCase.input);
      results.push({
        id: testCase.id,
        expected: String(testCase.expected_write),
        actual: String(await planner.shouldAutoCommit(plan))
      });
    }

    const failures = results.filter((result) => result.actual !== result.expected);
    const accuracy = (results.length - failures.length) / results.length;
    expect(accuracy, formatFailures(failures)).toBeGreaterThanOrEqual(WRITE_DECISION_THRESHOLD);
  });

  it("keeps generated save targets, modes, and confirmation flags stable", async () => {
    const planner = createDeterministicSavePlanner();
    const cases = (await readJsonl<SavePolicyEvalCase>("save-policy-cases.jsonl")).filter(
      (testCase): testCase is GeneratedSaveEvalCase => testCase.kind === "generated_save"
    );
    expect(cases.length).toBeGreaterThan(0);

    for (const testCase of cases) {
      const plan = await planner.planGeneratedSave(testCase.input);
      expect(plan.requires_confirmation, testCase.id).toBe(testCase.expected_requires_confirmation);
      if (testCase.expected_targets) {
        expect(plan.target_paths, testCase.id).toEqual(testCase.expected_targets);
      }
      if (testCase.expected_mode) {
        expect(plan.mode, testCase.id).toBe(testCase.expected_mode);
      }
    }
  });
});

describe("P4 destructive action confirmation eval", () => {
  it("requires confirmation for all archive/delete-class operations", async () => {
    const documents = new DocumentService({ projectRoot: tempDir });
    const cases = (await readJsonl<SavePolicyEvalCase>("save-policy-cases.jsonl")).filter(
      (testCase): testCase is OperationConfirmationEvalCase => testCase.kind === "operation_confirmation"
    );
    expect(cases.length).toBeGreaterThan(0);
    const failures = cases
      .map((testCase) => ({
        id: testCase.id,
        expected: String(testCase.expected_requires_confirmation),
        actual: String(documents.operationsRequireDeleteConfirmation(testCase.operations))
      }))
      .filter((result) => result.actual !== result.expected);
    const accuracy = (cases.length - failures.length) / cases.length;

    expect(failures, formatFailures(failures)).toEqual([]);
    expect(accuracy, formatFailures(failures)).toBe(DESTRUCTIVE_CONFIRMATION_THRESHOLD);
  });
});

function createDeterministicSavePlanner(): GeneratedSavePlanner {
  return new GeneratedSavePlanner({
    projectRoot: tempDir,
    config: { configPath },
    modelClient: {
      requestCompletion: async () => {
        throw new Error("save policy eval must not call the model");
      }
    }
  });
}
