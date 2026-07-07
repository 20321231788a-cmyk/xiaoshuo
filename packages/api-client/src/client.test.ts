import { describe, expect, it } from "vitest";
import { appConfigSchema } from "@xiaoshuo/shared";
import { buildApiUrl, createApiClient, extractErrorMessage, parseJsonResponse } from "./client.js";

describe("api-client", () => {
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
});
