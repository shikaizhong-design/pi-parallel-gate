# pi-parallel-gate

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that answers one question **before** your agent fans out subagents: *are these subtasks actually safe to run in parallel?*

No mainstream coding agent checks this today — the decision is left to the main model's intuition, and when it's wrong you get overwritten files, missing upstream outputs, and merge conflicts. pi-parallel-gate puts a cheap, fast, veto-capable gate between "wants to parallelize" and "dispatches".

## How it works

The extension registers a single tool, `parallel_gate`. When the main model plans to dispatch 2+ writing subagents, it calls the tool with its proposed task graph. The tool runs four layers:

```
main model proposes task graph
        │
parallel_gate
        │
  Layer 0 · deterministic checks (no model calls)
        │   writes×writes / writes×reads glob overlap → hard edge
        │   identical side_effects (e.g. "dev server :3000") → hard edge
        │
  Layer 1 · Jev pairwise judgment (~100ms/batch, <1¢)
        │   one Noul yes/no question per remaining pair, via the
        │   TypeSafe System One API — p = P(safe to parallelize)
        │
  Layer 2 · policy & scheduling (pure code)
        │   p ≤ veto (0.30) → hard edge · p ≥ safe (0.70) → no edge
        │   in between → soft edge + uncertain_pairs (fail-safe, overridable)
        │   Kahn topological layering, cycle detection
        │
  Layer 3 · whole-layer recheck
            "can ALL of these run at once?" — catches n-ary conflicts
            pairwise questions structurally miss; failure demotes the
            layer to sequential
        ▼
verdict: { topology, layers, edges, uncertain_pairs, jev status }
```

The main model then dispatches strictly by `layers` (same layer = parallel-safe, later layers wait), using pi's normal Agent / SubagentWorkflow machinery with worktree isolation.

**Fail-closed by design:** malformed model probabilities, missing answers, API outages, or a missing API key never produce a "safe" verdict — they degrade to `jev.ok: false` or conservative edges, and the main model judges for itself. Judgment never replaces verification: correctness still comes from tests and `git diff` after the fact.

## Install

```bash
pi install /path/to/pi-parallel-gate   # or: add the repo to settings.json packages
export TYPESAFE_API_KEY=...            # https://typesafe.ai — free tier is plenty
```

Without `TYPESAFE_API_KEY` the tool still works: only deterministic Layer-0 checks run and the verdict is marked degraded.

## Tool contract

```
parallel_gate({
  goal: string,
  subtasks: [{
    id, title, detail,
    reads:  [glob...],        // what it reads
    writes: [glob...],        // what it creates/modifies; [] = read-only
    side_effects: [...],      // runtime effects, e.g. "dev server on :3000"
    depends_on: [id...],      // declared ordering constraints
  }],
  overrides?: [{ a, b, allow_parallel }]  // confirm uncertain pairs after your own review
})
→ verdict {
    topology: "parallel" | "pipeline" | "sequential" | "unknown",
    layers: [[ids...], ...],
    edges: [{ a, b, kind: hard|soft, reason, p_safe? }],
    uncertain_pairs: [{ a, b, p_safe, requires_confirmation: true }],
    degenerate_warning?,           // parallelism collapsed — refine or override
    jev: { ok, latency_ms, batches, usage, layer_check?, error? }
  }
```

Validation is strict and fails loudly (with instructions to fix): duplicate/invalid ids, dangling `depends_on`, cycles, undeclared scope, >12 subtasks.

## Example

```
goal: "Add a users list feature"
subtasks:
  api: writes src/server/routes/users.ts — defines the response shape
  ui:  writes src/client/components/UsersList.tsx — must match that shape

→ topology: sequential
  layers: [["api"], ["ui"]]
  edges: api×ui hard/jev-veto p_safe=0.29     ← no file overlap, but Jev caught the semantic dependency
```

## Develop

```bash
npm install
npm test        # 25 unit tests (node:test, Jev fully mocked)
npm run smoke   # live end-to-end against the real TypeSafe API (needs TYPESAFE_API_KEY)
```

## Design & research

- `docs/design.md` — full design, reviewed independently by three models (Grok / GPT / Kimi) and an adversarial code reviewer before implementation.
- Sibling research: no surveyed open-source orchestrator (LangGraph, AutoGen, CrewAI, OpenAI Agents SDK, MetaGPT, claude-flow, …) performs genuine parallelizability judgment; this gate is built to be that missing layer, with Jev as the judgment primitive. Thresholds (`safe`/`veto`) are initial values pending calibration on a labeled task set.

## Boundaries

- The gate only judges **the task graph you hand it** — garbage decomposition in, garbage verdict out.
- Jev sees only task descriptions and globs, never file contents. Don't put secrets or client-sensitive data in subtask descriptions.
- Post-merge verification (tests, diffs) is still your job.

## License

MIT

## Trigger it yourself

- `/gate <task>` or `/闸门 <task>` — decomposes the task, runs the gate, reports the verdict, then dispatches by layers. (Commands are interactive-mode only; in `-p` print mode just say "先过 parallel_gate 再并行".)
- Or just put a trigger phrase in your prompt: 「过闸：…」, 「并行闸门」, 「先判定再并行」 — the agent will decompose and call parallel_gate before doing any work.
