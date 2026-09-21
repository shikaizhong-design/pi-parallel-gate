/**
 * pi-parallel-gate — 并行闸门扩展入口
 *
 * 注册唯一工具 parallel_gate：主模型打算并行派 subagent 前先过闸。
 * Jev API key 从 TYPESAFE_API_KEY 环境变量读取；缺失或调用失败时优雅降级
 * （verdict.jev.ok=false，只出确定性检查结果，绝不阻塞任务）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readdir } from "node:fs/promises";
import { runGate, type GateInput, type Verdict } from "./gate.ts";
import { evaluateNoul } from "./jev.ts";

const GlobList = Type.Optional(
	Type.Array(Type.String(), { description: "Repo-relative globs, e.g. [\"src/auth/**\", \"README.md\"]" }),
);

const parameters = Type.Object({
	goal: Type.String({ description: "Overall goal the subtasks decompose" }),
	subtasks: Type.Array(
		Type.Object({
			id: Type.String({ description: "Short unique id, e.g. \"t1\"" }),
			title: Type.String(),
			detail: Type.String({ description: "What this subtask does, its inputs and expected outputs" }),
			reads: GlobList,
			writes: Type.Optional(
				Type.Array(Type.String(), {
					description: "Globs this subtask will create/modify. Pass [] to declare read-only.",
				}),
			),
			side_effects: Type.Optional(
				Type.Array(Type.String(), {
					description: "Runtime side effects, e.g. \"dev server on :3000\", \"writes tmp/build.db\"",
				}),
			),
			depends_on: Type.Optional(
				Type.Array(Type.String(), { description: "Ids of subtasks that must finish before this one" }),
			),
		}),
		{ minItems: 2, maxItems: 12 },
	),
	overrides: Type.Optional(
		Type.Array(
			Type.Object({
				a: Type.String(),
				b: Type.String(),
				allow_parallel: Type.Boolean({
					description: "true = you confirm this uncertain pair is safe to run in the same parallel batch",
				}),
			}),
		),
	),
});

/** 仓库顶层清单（≤100 条），给 Jev 一点结构背景；不含文件内容。 */
async function repoContext(cwd: string): Promise<string> {
	try {
		const entries = await readdir(cwd, { withFileTypes: true });
		const names = entries
			.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
			.slice(0, 100)
			.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
		return names.length > 0 ? `Top-level entries: ${names.join(", ")}` : "";
	} catch {
		return "";
	}
}

function formatSummary(v: Verdict): string {
	const lines: string[] = [];
	if (!v.jev.ok) {
		lines.push(`⚠ Jev unavailable (${v.jev.error ?? "unknown"}) — deterministic checks only, judge the rest yourself.`);
	}
	lines.push(`Topology: ${v.topology}`);
	if (v.layers.length > 0) {
		lines.push(`Layers: ${v.layers.map((l, i) => `L${i}=[${l.join(", ")}]`).join("  ")}`);
	}
	const hard = v.edges.filter((e) => e.kind === "hard");
	if (hard.length > 0) {
		lines.push(
			`Hard edges (must NOT run in the same batch):`,
			...hard.map((e) => `  ${e.a} × ${e.b} — ${e.reason}${e.detail ? ` (${e.detail})` : ""}${e.p_safe !== undefined ? ` p_safe=${e.p_safe.toFixed(2)}` : ""}`),
		);
	}
	if (v.uncertain_pairs.length > 0) {
		lines.push(
			`Uncertain pairs (separated by default; refine & re-call, or override explicitly):`,
			...v.uncertain_pairs.map((u) => `  ${u.a} × ${u.b} — p_safe=${u.p_safe.toFixed(2)}`),
		);
	}
	if (v.demoted_layers?.length) {
		lines.push(
			`Demoted to sequential by whole-layer check:`,
			...v.demoted_layers.map((d) => `  [${d.subtasks.join(", ")}] p_safe=${d.p_safe.toFixed(2)}`),
		);
	}
	if (v.degenerate_warning) lines.push(`⚠ ${v.degenerate_warning}`);
	if (v.jev.ok) lines.push(`Jev: ${v.jev.batches} batch(es), ${v.jev.latency_ms}ms`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "parallel_gate",
		label: "Parallel Gate",
		description:
			"Judge whether proposed subtasks can safely run in parallel BEFORE dispatching subagents. " +
			"Combines deterministic file-scope conflict checks with a Jev judgment model. " +
			"Returns a verdict with topological layers: same layer = safe to parallelize, later layers must wait. " +
			"Reads TYPESAFE_API_KEY from env; degrades gracefully (jev.ok=false) when unavailable.",
		promptSnippet: "Verify a proposed subtask split is safe to parallelize before dispatching subagents",
		promptGuidelines: [
			"Call parallel_gate before dispatching 2+ subagents in parallel when any of them writes files.",
			"Declare every subtask's reads[]/writes[] globs honestly — the deterministic conflict check and the judgment model both depend on them; pass writes: [] for read-only subtasks.",
			"Dispatch strictly by parallel_gate verdict.layers: subtasks in the same layer may run in parallel, later layers must wait; never put a hard-edged pair in the same parallel batch.",
			"When parallel_gate returns uncertain_pairs, either refine the subtask detail/scope and call again, or pass overrides to confirm pairs you have verified safe yourself.",
			"When parallel_gate verdict has jev.ok=false, the judgment model was unavailable — decide parallelism yourself using only the deterministic edges it reports.",
		],
		parameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const input = params as GateInput;
			if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled" }], details: {} };

			const apiKey = process.env.TYPESAFE_API_KEY;
			const context = await repoContext(ctx.cwd);
			const jevFn = apiKey
				? (state: string, questions: Parameters<typeof evaluateNoul>[2]) =>
						evaluateNoul(apiKey, state, questions)
				: undefined;
			if (!apiKey) {
				onUpdate?.({ content: [{ type: "text", text: "TYPESAFE_API_KEY not set — degraded mode" }], details: {} });
			}

			const verdict = await runGate({ ...input, context }, { jev: jevFn });
			return {
				content: [{ type: "text", text: formatSummary(verdict) }],
				details: verdict as unknown as Record<string, unknown>,
			};
		},
	});
}
