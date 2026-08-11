# Eval Fixture Inventory

Batch B records the evaluated fixture inventory at execution time instead of
committing hashes that become stale when a fixture changes. Every `eval:*`
command writes `output/evals/<eval_name>/manifest.json` with SHA-256 hashes for:

- the invoked Vitest file or files;
- every current file beneath `packages/agent-runtime/evals/`;
- a deterministic dataset hash derived from that inventory;
- one case-level hash and result for every emitted Vitest case.

`XIAOSHUO_EVAL_SEED` is fixed to `20260713` unless explicitly supplied by CI.
The manifest records the seed policy, command, commit, host OS, duration and
case-level outcomes. The same directory contains a redacted failure trace,
failure-case summary, performance baseline and security/recovery counters.

The inventory now includes the `novel-agent` eval for fixed-role review,
per-claim memory confirmation, the built-in tool catalog, budgeted background
tasks, revision-bound project transfer, shared-schema injection rejection and
the two-step transfer confirmation contract. The excluded-capabilities eval
also includes both renderer and main-process novel user-gesture gates. The
single acceptance policy remains defined in
`AGENT_NOVEL_CREATION_MODIFICATION_PLAN.md`.
