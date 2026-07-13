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

The inventory mechanism is complete for the current fixture set. Dataset scale,
sealed holdout and human calibration remain RC gates described in
`AGENT_OPTIMIZATION_NEXT_IMPLEMENTATION_MANUAL.md`.
