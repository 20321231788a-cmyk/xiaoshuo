import { describe, expect, it } from "vitest";
import { agentRunStateSchema, appConfigSchema } from "@xiaoshuo/shared";
import { buildApiUrl, createApiClient, extractErrorMessage, parseJsonResponse } from "./client.js";

describe("api-client", () => {
  it("posts durable run creation payloads through the lifecycle contract", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const run = agentRunStateSchema.parse({
      run_id: "run-created",
      request_id: "request-created",
      goal: { instruction: "继续写作" },
      created_at: "2026-07-10T04:00:00.000Z",
      updated_at: "2026-07-10T04:00:00.000Z"
    });
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET"),
          body: String(init?.body || "")
        });
        return new Response(JSON.stringify(run), { status: 201, headers: { "Content-Type": "application/json" } });
      }
    });

    const created = await client.createAgentRun({ request_id: "request-created", content: "继续写作" });

    expect(created.run_id).toBe("run-created");
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/agent/runs",
        method: "POST",
        body: JSON.stringify({
          request_id: "request-created",
          autonomy_mode: "plan",
          conversation_id: "",
          content: "继续写作",
          current_path: "",
          selection: "",
          project_context_hint: "",
          skill_id: "",
          attachment_ids: [],
          reference_paths: [],
          confirmed_reference_paths: [],
          disable_auto_references: false
        })
      }
    ]);
  });

  it("uses the receipt-bound memory confirmation route instead of a direct confirmed write", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({ url: String(input), method: String(init?.method || "GET"), body: String(init?.body || "") });
        return new Response(JSON.stringify({
          confirmation: {
            confirmation_id: "memconf-1",
            claim_id: "claim-1",
            version: 1,
            status: "requested",
            expires_at: "2026-07-13T01:00:00.000Z"
          }
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
    });

    const result = await client.requestGovernedMemoryConfirmation("claim-1", 3);

    expect(result.confirmation.status).toBe("requested");
    expect(requests).toEqual([{
      url: "http://127.0.0.1:18452/api/memory/claims/claim-1/confirmations",
      method: "POST",
      body: JSON.stringify({ source_revision: 3 })
    }]);
  });

  it("preserves slashes when encoding path placeholders", () => {
    const url = buildApiUrl("http://127.0.0.1:18452", "/api/documents/{rel_path}", {
      rel_path: "01_大纲/章纲.txt"
    });

    expect(url).toBe("http://127.0.0.1:18452/api/documents/01_%E5%A4%A7%E7%BA%B2/%E7%AB%A0%E7%BA%B2.txt");
  });

  it("extracts backend detail errors from JSON", () => {
    expect(extractErrorMessage('{"detail":"boom"}')).toBe("boom");
    expect(extractErrorMessage("plain failure")).toBe("plain failure");
  });

  it("validates typed contract responses", async () => {
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            api_key: "",
            license_account_key: "",
            base_url: "https://api.openai.com/v1",
            model: "gpt-4.1-mini",
            temp: 0.7,
            secondary_api_key: "",
            secondary_base_url: "",
            secondary_model: "",
            secondary_temp: 0.5,
            model_thinking_enabled: false,
            enable_consistency_revision: true,
            consistency_revision_score: 80,
            context_limit_chars: 262144,
            embedding_enabled: false,
            embedding_api_key: "",
            embedding_base_url: "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal",
            embedding_model: "doubao-embedding-vision-250615",
            embedding_timeout: 60,
            embedding_batch_size: 16,
            vector_top_k: 10,
            vector_context_chars: 9000
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    });

    const config = await client.getConfig();
    expect(config).toEqual(
      appConfigSchema.parse({
        api_key: "",
        license_account_key: "",
        base_url: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        temp: 0.7,
        secondary_api_key: "",
        secondary_base_url: "",
        secondary_model: "",
        secondary_temp: 0.5,
        model_thinking_enabled: false,
        enable_consistency_revision: true,
        consistency_revision_score: 80,
        context_limit_chars: 262144,
        embedding_enabled: false,
        embedding_api_key: "",
        embedding_base_url: "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal",
        embedding_model: "doubao-embedding-vision-250615",
        embedding_timeout: 60,
        embedding_batch_size: 16,
        vector_top_k: 10,
        vector_context_chars: 9000
      })
    );
  });

  it("throws a schema error for invalid responses", async () => {
    await expect(
      parseJsonResponse(
        new Response(JSON.stringify({ temp: "oops" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
        appConfigSchema
      )
    ).rejects.toThrow();
  });

  it("posts project open payloads with JSON bodies", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET"),
          body: String(init?.body || "")
        });
        return new Response(JSON.stringify({ path: "D:/books/demo", name: "Demo" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    const project = await client.openProject("D:/books/demo");

    expect(project.path).toBe("D:/books/demo");
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/projects/open",
        method: "POST",
        body: JSON.stringify({ path: "D:/books/demo" })
      }
    ]);
  });

  it("appends query params for pending vector processing", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET")
        });
        return new Response(
          JSON.stringify({
            enabled: true,
            configured: true,
            db: "D:/books/demo/.agent/vector_index.sqlite3",
            chunks: 12,
            embedded_chunks: 12,
            current_embedded_chunks: 12,
            pending_files: 0,
            embedding_model: "demo:model",
            ready: true,
            updated_at: "2026-05-28 21:30:00",
            processed_files: 3
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    const result = await client.processPendingVectorFiles(25);

    expect(result.processed_files).toBe(3);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/vector/process-pending?limit=25",
        method: "POST"
      }
    ]);
  });

  it("posts vector search requests and parses hits", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET"),
          body: String(init?.body || "")
        });
        return new Response(
          JSON.stringify({
            hits: [
              {
                path: "00_设定集/主角.txt",
                source_type: "lore",
                title: "主角",
                text: "林风的核心秘密。",
                score: 0.91
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    const result = await client.searchVector("林风秘密", 5, 6000);

    expect(result.hits[0]?.path).toBe("00_设定集/主角.txt");
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/vector/search",
        method: "POST",
        body: JSON.stringify({
          query: "林风秘密",
          top_k: 5,
          max_chars: 6000
        })
      }
    ]);
  });

  it("gets agent trace list and detail endpoints", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET")
        });
        const body = String(input).endsWith("/api/agent/traces/run-one")
          ? {
              run_id: "run-one",
              started_at: "2026-07-07T08:00:00.000Z",
              input_excerpt: "写第 1 章",
              selected_skill_id: "body_generate"
            }
          : [
              {
                run_id: "run-one",
                started_at: "2026-07-07T08:00:00.000Z",
                input_excerpt: "写第 1 章",
                selected_skill_id: "body_generate"
              }
            ];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    const traces = await client.getAgentTraces(25);
    const detail = await client.getAgentTrace("run-one");

    expect(traces[0]?.run_id).toBe("run-one");
    expect(detail.selected_skill_id).toBe("body_generate");
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/agent/traces?limit=25",
        method: "GET"
      },
      {
        url: "http://127.0.0.1:18452/api/agent/traces/run-one",
        method: "GET"
      }
    ]);
  });

  it("lists agent runs, gets run detail and confirmations, and replays events", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const run = {
      run_id: "run-one",
      goal: { instruction: "续写下一章" },
      created_at: "2026-07-10T08:00:00.000Z",
      updated_at: "2026-07-10T08:00:01.000Z"
    };
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          url: url.toString(),
          method: String(init?.method || "GET")
        });
        if (url.pathname.endsWith("/events")) {
          return new Response(
            JSON.stringify({
              events: [
                {
                  event_id: "event-four",
                  run_id: "run-one",
                  sequence: 4,
                  event_type: "run.paused",
                  created_at: "2026-07-10T08:00:02.000Z"
                }
              ],
              next_after: 4
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        const body = url.pathname === "/api/agent/runs"
          ? { runs: [run], next_cursor: "cursor-two" }
          : url.pathname.endsWith("/confirmations")
            ? [{ confirmation_id: "confirmation-one", run_id: "run-one", step_id: "step-one", action: "replace_document", risk_level: "high", status: "pending" }]
            : run;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    const list = await client.listAgentRuns({
      project: "project-one",
      status: "paused",
      cursor: "cursor-one",
      limit: 25
    });
    const detail = await client.getAgentRun("run-one");
    const confirmations = await client.getAgentRunConfirmations("run-one");
    const replay = await client.getAgentRunEvents("run-one", 3);

    expect(list.runs[0]).toMatchObject({ run_id: "run-one", status: "queued", version: 1 });
    expect(list.next_cursor).toBe("cursor-two");
    expect(detail.goal.instruction).toBe("续写下一章");
    expect(confirmations).toMatchObject([{ confirmation_id: "confirmation-one", status: "pending" }]);
    expect(replay.events[0]).toMatchObject({ sequence: 4, step_id: "", payload: {} });
    expect(replay.next_after).toBe(4);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/agent/runs?project=project-one&status=paused&cursor=cursor-one&limit=25",
        method: "GET"
      },
      {
        url: "http://127.0.0.1:18452/api/agent/runs/run-one",
        method: "GET"
      },
      {
        url: "http://127.0.0.1:18452/api/agent/runs/run-one/confirmations",
        method: "GET"
      },
      {
        url: "http://127.0.0.1:18452/api/agent/runs/run-one/events?after=3",
        method: "GET"
      }
    ]);
  });

  it("exports and deletes durable runs through typed project-scoped endpoints", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const run = {
      run_id: "run-export",
      project_id: "project-one",
      project_path: "D:\\projects\\demo",
      goal: { instruction: "导出" },
      created_at: "2026-07-10T08:00:00.000Z",
      updated_at: "2026-07-10T08:00:01.000Z"
    };
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        const url = String(input);
        requests.push({ url, method: String(init?.method || "GET") });
        const body = init?.method === "DELETE"
          ? {
              run_id: "run-export", project_id: "project-one", deleted_at: "2026-07-10T08:02:00.000Z",
              deleted_records: { run: 1, steps: 0, attempts: 0, observations: 0, artifacts: 0, confirmations: 0, events: 0, control_operations: 0, commit_journal: 0, write_leases: 0 },
              preserved_artifacts: []
            }
          : {
              format_version: 1, exported_at: "2026-07-10T08:02:00.000Z", project_id: "project-one", project_path: "D:\\projects\\demo",
              run, steps: [], attempts: [], observations: [], artifacts: [], confirmations: [], events: [], control_operations: [], commit_journal: []
            };
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    });

    const exported = await client.exportAgentRun("run-export");
    const deleted = await client.deleteAgentRun("run-export");

    expect(exported).toMatchObject({ format_version: 1, run: { run_id: "run-export" } });
    expect(deleted).toMatchObject({ run_id: "run-export", deleted_records: { run: 1 } });
    expect(requests).toEqual([
      { url: "http://127.0.0.1:18452/api/agent/runs/run-export/export", method: "GET" },
      { url: "http://127.0.0.1:18452/api/agent/runs/run-export", method: "DELETE" }
    ]);
  });

  it("posts agent run lifecycle commands with idempotency and CAS bodies", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const run = {
      run_id: "run-one",
      goal: { instruction: "续写下一章" },
      created_at: "2026-07-10T08:00:00.000Z",
      updated_at: "2026-07-10T08:00:01.000Z"
    };
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          method: String(init?.method || "GET"),
          body: String(init?.body || "")
        });
        const confirmationStatus = url.endsWith("/approve") ? "approved" : url.endsWith("/reject") ? "rejected" : null;
        const body = confirmationStatus
          ? {
              confirmation_id: "confirmation-one",
              run_id: "run-one",
              step_id: "step-one",
              action: "replace_document",
              risk_level: "high",
              status: confirmationStatus
            }
          : run;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    const paused = await client.pauseAgentRun("run-one", { operation_id: " operation-pause ", expected_version: 1 });
    await client.resumeAgentRun("run-one", { operation_id: "operation-resume", expected_version: 2 });
    await client.cancelAgentRun("run-one", { operation_id: "operation-cancel", expected_version: 3 });
    await client.retryAgentRunStep("run-one", "step-one", { operation_id: "operation-retry", expected_version: 4 });
    const approved = await client.approveAgentConfirmation("confirmation-one", {
      operation_id: "operation-approve",
      expected_version: 5,
      expected_scope_fingerprint: "scope-fingerprint-1"
    });
    const rejected = await client.rejectAgentConfirmation("confirmation-one", {
      operation_id: "operation-reject",
      expected_version: 6
    });

    expect(paused).toMatchObject({ run_id: "run-one", status: "queued", version: 1 });
    expect(approved.status).toBe("approved");
    expect(rejected.status).toBe("rejected");
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/agent/runs/run-one/pause",
        method: "POST",
        body: JSON.stringify({ operation_id: "operation-pause", expected_version: 1 })
      },
      {
        url: "http://127.0.0.1:18452/api/agent/runs/run-one/resume",
        method: "POST",
        body: JSON.stringify({ operation_id: "operation-resume", expected_version: 2 })
      },
      {
        url: "http://127.0.0.1:18452/api/agent/runs/run-one/cancel",
        method: "POST",
        body: JSON.stringify({ operation_id: "operation-cancel", expected_version: 3 })
      },
      {
        url: "http://127.0.0.1:18452/api/agent/runs/run-one/steps/step-one/retry",
        method: "POST",
        body: JSON.stringify({ operation_id: "operation-retry", expected_version: 4 })
      },
      {
        url: "http://127.0.0.1:18452/api/agent/confirmations/confirmation-one/approve",
        method: "POST",
        body: JSON.stringify({ operation_id: "operation-approve", expected_version: 5, expected_scope_fingerprint: "scope-fingerprint-1" })
      },
      {
        url: "http://127.0.0.1:18452/api/agent/confirmations/confirmation-one/reject",
        method: "POST",
        body: JSON.stringify({ operation_id: "operation-reject", expected_version: 6, expected_scope_fingerprint: "" })
      }
    ]);
  });

  it("calls project reference endpoints", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET"),
          body: String(init?.body || "")
        });
        if (String(input).endsWith("/api/project/resolve-files")) {
          return new Response(
            JSON.stringify({
              references: [
                {
                  label: "章纲",
                  path: "01_大纲/章纲.txt",
                  kind: "alias",
                  confidence: 0.98,
                  reason: "用户提到“章纲”",
                  matched_text: "章纲",
                  exists: true,
                  readable: true,
                  chars: 4,
                  updated_at: ""
                }
              ],
              candidates: [],
              ambiguous: false,
              warnings: []
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (String(input).endsWith("/api/project/read-references")) {
          return new Response(
            JSON.stringify({
              blocks: [
                {
                  path: "01_大纲/章纲.txt",
                  title: "章纲",
                  content: "章纲内容",
                  chars: 4,
                  truncated: false
                }
              ],
              warnings: []
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ ok: true, entries: 1, path: "00_设定集/.agent/file-manifest.json" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    const resolved = await client.resolveProjectFiles({ text: "参考章纲", max_candidates: 8 });
    const read = await client.readProjectReferences({ paths: ["01_大纲/章纲.txt"] });
    const rebuilt = await client.rebuildProjectFileManifest();

    expect(resolved.references[0]?.path).toBe("01_大纲/章纲.txt");
    expect(read.blocks[0]?.content).toBe("章纲内容");
    expect(rebuilt.entries).toBe(1);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/project/resolve-files",
        method: "POST",
        body: JSON.stringify({
          text: "参考章纲",
          current_path: "",
          selection: "",
          attachment_ids: [],
          explicit_paths: [],
          max_candidates: 8
        })
      },
      {
        url: "http://127.0.0.1:18452/api/project/read-references",
        method: "POST",
        body: JSON.stringify({
          paths: ["01_大纲/章纲.txt"],
          max_chars_per_file: 12000,
          max_total_chars: 36000
        })
      },
      {
        url: "http://127.0.0.1:18452/api/project/rebuild-file-manifest",
        method: "POST",
        body: ""
      }
    ]);
  });

  it("calls skill patch clone version and rollback endpoints", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const skill = {
      id: "custom_review",
      version: "1.0.1",
      name: "Custom Review",
      description: "desc",
      input_mode: "text",
      context_requirements: [],
      handler_type: "prompt",
      linked_targets: [],
      prompt: "prompt",
      imported_from: "clone:review",
      writable: false
    };
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET"),
          body: String(init?.body || "")
        });
        const url = String(input);
        if (url.endsWith("/clone")) {
          return new Response(JSON.stringify(skill), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.endsWith("/versions")) {
          return new Response(
            JSON.stringify({
              skill_id: "custom_review",
              versions: [
                {
                  version_id: "v1",
                  skill_id: "custom_review",
                  created_at: "2026-07-07 10:00:00",
                  change_reason: "patch",
                  author: "agent",
                  snapshot: skill
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            skill,
            previous_skill: skill,
            diff: "--- before\n+++ after",
            version_id: "v1",
            dry_run: url.endsWith("/rollback") ? false : true,
            warnings: []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    await client.patchSkill("custom_review", { prompt: "prompt", dry_run: true });
    await client.cloneSkill("outline_generate", { target_id: "custom_review", target_name: "Custom Review" });
    await client.getSkillVersions("custom_review");
    await client.rollbackSkill("custom_review", { version_id: "v1" });

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/skills/custom_review",
        method: "PATCH",
        body: JSON.stringify({ prompt: "prompt", change_reason: "", expected_version: "", dry_run: true })
      },
      {
        url: "http://127.0.0.1:18452/api/skills/outline_generate/clone",
        method: "POST",
        body: JSON.stringify({ target_id: "custom_review", target_name: "Custom Review", instruction: "" })
      },
      {
        url: "http://127.0.0.1:18452/api/skills/custom_review/versions",
        method: "GET",
        body: ""
      },
      {
        url: "http://127.0.0.1:18452/api/skills/custom_review/rollback",
        method: "POST",
        body: JSON.stringify({ version_id: "v1", change_reason: "rollback" })
      }
    ]);
  });

  it("calls the generic skill draft endpoint", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET"),
          body: String(init?.body || "")
        });
        return new Response(
          JSON.stringify({
            skill: {
              id: "short_review",
              version: "1.0.0",
              name: "短篇审稿",
              description: "desc",
              input_mode: "text",
              context_requirements: [],
              handler_type: "prompt",
              linked_targets: [],
              prompt: "prompt",
              imported_from: "draft:selection",
              writable: false
            },
            source_url: "",
            source_name: "selection.md",
            source_excerpt: "选区",
            source_text: "选区",
            warnings: []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    const draft = await client.draftSkill({
      kind: "selection",
      instruction: "生成短篇审稿技能",
      selection: "选区",
      target_name: "短篇审稿",
      target_id: "short_review"
    });

    expect(draft.skill.id).toBe("short_review");
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/skills/draft",
        method: "POST",
        body: JSON.stringify({
          kind: "selection",
          instruction: "生成短篇审稿技能",
          text: "",
          url: "",
          current_path: "",
          selection: "选区",
          attachment_ids: [],
          source_skill_id: "",
          target_name: "短篇审稿",
          target_id: "short_review"
        })
      }
    ]);
  });

  it("posts embedding test requests and parses connection details", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET"),
          body: String(init?.body || "")
        });
        return new Response(
          JSON.stringify({
            ok: true,
            model: "ep-test",
            configured_model: "ep-test",
            base_url: "https://ark.cn-beijing.volces.com/api/v3",
            provider: "doubao_multimodal",
            dimensions: 1024
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    const result = await client.testVectorEmbedding({
      embedding_enabled: true,
      embedding_api_key: "draft-key",
      embedding_base_url: "https://ark.cn-beijing.volces.com/api/v3",
      embedding_model: "ep-test",
      embedding_timeout: 60,
      embedding_batch_size: 16
    });

    expect(result.dimensions).toBe(1024);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/vector/test",
        method: "POST",
        body: JSON.stringify({
          embedding_enabled: true,
          embedding_api_key: "draft-key",
          embedding_base_url: "https://ark.cn-beijing.volces.com/api/v3",
          embedding_model: "ep-test",
          embedding_timeout: 60,
          embedding_batch_size: 16
        })
      }
    ]);
  });

  it("gets generated cache content for recovery", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET")
        });
        return new Response(
          JSON.stringify({
            meta: {
              cache_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
              status: "pending",
              source: "skill",
              skill_id: "body_generate",
              mode: "replace",
              conversation_id: "",
              summary: "",
              target_paths: ["02_正文/第一章.txt"],
              cache_path: "00_设定集/.agent/generated_cache/a1/content.txt",
              chars: 4,
              created_at: "2026-06-01 12:00:00",
              updated_at: "2026-06-01 12:00:00",
              committed_at: "",
              discarded_at: "",
              failed_at: "",
              saved_paths: [],
              error: "",
              transient: false
            },
            content: "正文内容"
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    const result = await client.getGeneratedCache("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");

    expect(result.content).toBe("正文内容");
    expect(result.meta.target_paths).toEqual(["02_正文/第一章.txt"]);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/agent/generated/cache/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
        method: "GET"
      }
    ]);
  });

  it("posts agent plan payloads and parses the returned plan", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET"),
          body: String(init?.body || "")
        });
        return new Response(
          JSON.stringify({
            operations: [
              {
                action: "move_file",
                path: "01_大纲/大纲.txt",
                text: "",
                old_text: "",
                new_text: "",
                target_path: "01_大纲/新大纲.txt",
                reason: "rename",
                requires_confirmation: false
              }
            ],
            summary: "重命名 01_大纲/大纲.txt -> 01_大纲/新大纲.txt",
            warnings: [],
            can_execute: true
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    const plan = await client.planAgent({
      instruction: "把当前文件文件名修改为新大纲",
      current_path: "01_大纲/大纲.txt",
      selection: "",
      project_context_hint: ""
    });

    expect(plan.can_execute).toBe(true);
    expect(plan.operations[0]?.target_path).toBe("01_大纲/新大纲.txt");
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/agent/plan",
        method: "POST",
        body: JSON.stringify({
          instruction: "把当前文件文件名修改为新大纲",
          current_path: "01_大纲/大纲.txt",
          selection: "",
          project_context_hint: ""
        })
      }
    ]);
  });

  it("parses agent stream events in order", async () => {
    const events: string[] = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  [
                    JSON.stringify({ type: "start", intent: "chat", conversation_id: "conv_1" }),
                    JSON.stringify({ type: "delta", text: "你好" }),
                    JSON.stringify({
                      type: "final",
                      payload: {
                        intent: "chat",
                        reply: "你好，世界",
                        results: [],
                        saved_paths: [],
                        requires_confirmation: false
                      }
                    })
                  ].join("\n")
                )
              );
              controller.close();
            }
          }),
          { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
        )
    });

    await client.streamAgentRun(
      {
        conversation_id: "conv_1",
        content: "你好",
        current_path: "",
        selection: "",
        project_context_hint: "",
        skill_id: "",
        attachment_ids: []
      },
      {
        onStart: (event) => {
          events.push(`${event.type}:${event.intent}`);
        },
        onDelta: (event) => {
          events.push(`${event.type}:${event.text}`);
        },
        onFinal: (event) => {
          events.push(`${event.type}:${event.payload.reply}`);
        }
      }
    );

    expect(events).toEqual(["start:chat", "delta:你好", "final:你好，世界"]);
  });

  it("consumes durable run event stream records after a sequence", async () => {
    const received: string[] = [];
    const requests: string[] = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input) => {
        requests.push(String(input));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode([
                JSON.stringify({ type: "event", event: { event_id: "event-4", run_id: "run-one", sequence: 4, event_type: "run.resumed", created_at: "2026-07-10T08:00:04.000Z" } }),
                JSON.stringify({ type: "heartbeat", run_id: "run-one", after: 4, at: "2026-07-10T08:00:05.000Z" }),
                JSON.stringify({ type: "end", run_id: "run-one", after: 4, status: "completed" })
              ].join("\n")));
              controller.close();
            }
          }),
          { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
        );
      }
    });

    await client.streamAgentRunEvents("run-one", {
      onEvent: (event) => { received.push(`event:${event.sequence}`); },
      onHeartbeat: (event) => { received.push(`heartbeat:${event.after}`); },
      onEnd: (event) => { received.push(`end:${event.status}`); }
    }, 3);

    expect(received).toEqual(["event:4", "heartbeat:4", "end:completed"]);
    expect(requests).toEqual(["http://127.0.0.1:18452/api/agent/runs/run-one/events/stream?after=3"]);
  });

  it("posts conversation message payloads and parses the returned reply", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET"),
          body: String(init?.body || "")
        });
        return new Response(
          JSON.stringify({
            reply: "会话回复",
            saved_path: "",
            conversation: {
              id: "conv_1",
              title: "测试会话",
              created_at: "2026-06-05 10:00:00",
              updated_at: "2026-06-05 10:00:01",
              current_skill: "",
              current_agent: "",
              summary: "",
              pinned_context: [],
              attachments: [],
              messages: [],
              message_count: 0,
              attachment_count: 0
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    const result = await client.sendConversationMessage("conv_1", {
      content: "你好",
      skill_id: "",
      agent_name: "",
      write_target: "",
      insert_mode: "none",
      runtime_context: "上下文",
      attachment_ids: []
    });

    expect(result.reply).toBe("会话回复");
    expect(result.conversation.id).toBe("conv_1");
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/conversations/conv_1/messages",
        method: "POST",
        body: JSON.stringify({
          content: "你好",
          skill_id: "",
          agent_name: "",
          write_target: "",
          insert_mode: "none",
          runtime_context: "上下文",
          attachment_ids: []
        })
      }
    ]);
  });

  it("calls conversation organization endpoints with typed payloads", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const conversationPayload = {
      id: "conv_1",
      title: "整理后的会话",
      created_at: "2026-06-05 10:00:00",
      updated_at: "2026-06-05 10:00:01",
      current_skill: "",
      current_agent: "",
      summary: "摘要",
      pinned_context: [
        {
          id: "pin_1",
          kind: "text",
          label: "设定",
          path: "",
          content_excerpt: "重要设定",
          created_at: "2026-06-05 10:00:01"
        }
      ],
      attachments: [],
      messages: [],
      message_count: 0,
      attachment_count: 0
    };
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET"),
          body: String(init?.body || "")
        });
        return new Response(JSON.stringify(conversationPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    await client.summarizeConversation("conv_1", true);
    await client.pinConversationContext("conv_1", { kind: "text", content: "重要设定", label: "设定" });
    await client.removeConversationPinnedContext("conv_1", "pin_1");
    await client.clearConversationPinnedContext("conv_1");

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/conversations/conv_1/summarize",
        method: "POST",
        body: JSON.stringify({ use_model: true })
      },
      {
        url: "http://127.0.0.1:18452/api/conversations/conv_1/pin-context",
        method: "POST",
        body: JSON.stringify({ kind: "text", content: "重要设定", label: "设定" })
      },
      {
        url: "http://127.0.0.1:18452/api/conversations/conv_1/pin-context/pin_1",
        method: "DELETE",
        body: ""
      },
      {
        url: "http://127.0.0.1:18452/api/conversations/conv_1/pin-context",
        method: "DELETE",
        body: ""
      }
    ]);
  });

  it("parses streamed conversation message events in order", async () => {
    const events: string[] = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  [
                    JSON.stringify({ type: "start", intent: "chat", conversation_id: "conv_1" }),
                    JSON.stringify({ type: "delta", text: "你好" }),
                    JSON.stringify({
                      type: "final",
                      payload: {
                        intent: "chat",
                        reply: "你好，世界",
                        results: [],
                        saved_paths: [],
                        requires_confirmation: false
                      }
                    })
                  ].join("\n")
                )
              );
              controller.close();
            }
          }),
          { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
        )
    });

    await client.streamConversationMessage(
      "conv_1",
      {
        content: "你好",
        skill_id: "",
        agent_name: "",
        write_target: "",
        insert_mode: "none",
        runtime_context: "",
        attachment_ids: []
      },
      {
        onStart: (event) => {
          events.push(`${event.type}:${event.intent}`);
        },
        onDelta: (event) => {
          events.push(`${event.type}:${event.text}`);
        },
        onFinal: (event) => {
          events.push(`${event.type}:${event.payload.reply}`);
        }
      }
    );

    expect(events).toEqual(["start:chat", "delta:你好", "final:你好，世界"]);
  });

  it("preserves confirmed reference fields in streamed conversation payloads", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:18452",
      fetchFn: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method || "GET"),
          body: String(init?.body || "")
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    type: "final",
                    payload: {
                      intent: "chat",
                      reply: "ok",
                      results: [],
                      saved_paths: [],
                      requires_confirmation: false
                    }
                  })
                )
              );
              controller.close();
            }
          }),
          { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
        );
      }
    });

    await client.streamConversationMessage(
      "conv_1",
      {
        content: "参考章纲继续写",
        skill_id: "",
        agent_name: "",
        write_target: "",
        insert_mode: "none",
        runtime_context: "",
        attachment_ids: [],
        reference_paths: ["01_大纲/章纲.txt"],
        confirmed_reference_paths: ["00_设定集/人物设定.txt"],
        disable_auto_references: true
      },
      {}
    );

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:18452/api/conversations/conv_1/messages",
        method: "POST",
        body: JSON.stringify({
          content: "参考章纲继续写",
          skill_id: "",
          agent_name: "",
          write_target: "",
          insert_mode: "none",
          runtime_context: "",
          attachment_ids: [],
          reference_paths: ["01_大纲/章纲.txt"],
          confirmed_reference_paths: ["00_设定集/人物设定.txt"],
          disable_auto_references: true
        })
      }
    ]);
  });
});
