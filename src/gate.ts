/**
 * gate.ts — 并行闸门纯逻辑（不依赖 pi 运行时，可单测）
 *
 * 流程：输入校验 → Layer 0 确定性冲突 → Layer 1 Jev 成对判定 →
 *       Layer 2 策略分层（Kahn + 环检测）→ Layer 3 整层复核。
 * Jev 通过依赖注入传入，测试用 mock；传 undefined 即降级模式。
 */

import { findScopeConflicts, findSideEffectConflicts } from "./scope.ts";
import type { JevResult, NoulQuestion } from "./jev.ts";

export interface Subtask {
	id: string;
	title: string;
	detail: string;
	reads?: string[];
	writes?: string[];
	side_effects?: string[];
	depends_on?: string[];
}

export interface GateInput {
	goal: string;
	subtasks: Subtask[];
	/** 主模型对软边的显式覆盖：allow_parallel=true 表示确认 (a,b) 可同层 */
	overrides?: Array<{ a: string; b: string; allow_parallel: boolean }>;
	/** 注入 state 的仓库背景（如顶层目录清单），不进 Jev 时可省略 */
	context?: string;
}

export interface Thresholds {
	/** p_safe ≥ safe → 可并行 */
	safe: number;
	/** p_safe ≤ veto → 硬边（否决并行） */
	veto: number;
	/** 整层复核 p_safe 低于此值 → 该层降级串行 */
	layerVeto: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { safe: 0.7, veto: 0.3, layerVeto: 0.5 };

export type EdgeKind = "hard" | "soft";
export interface Edge {
	a: string;
	b: string;
	kind: EdgeKind;
	reason: "declared" | "scope-overlap" | "side-effect" | "jev-veto" | "jev-uncertain" | "override-veto";
	detail?: string;
	p_safe?: number;
}

export interface UncertainPair {
	a: string;
	b: string;
	p_safe: number;
	requires_confirmation: true;
}

export interface Verdict {
	topology: "parallel" | "pipeline" | "sequential" | "unknown";
	/** 拓扑分层；同层可并行，层间有向先后。degraded 时为空 */
	layers: string[][];
	edges: Edge[];
	uncertain_pairs: UncertainPair[];
	/** 并行度塌缩告警：声明意图是并行但所有层都只有 1 人 */
	degenerate_warning?: string;
	/** 被整层复核降级为串行的层及原因 */
	demoted_layers?: Array<{ subtasks: string[]; p_safe: number }>;
	jev: { ok: boolean; latency_ms?: number; batches?: number; usage?: unknown; error?: string };
}

export type JevFn = (state: string, questions: Record<string, NoulQuestion>) => Promise<JevResult>;

const MAX_SUBTASKS = 12;
const MIN_SUBTASKS = 2;

/** 输入校验；返回错误列表（空 = 合法）。 */
export function validateInput(input: GateInput): string[] {
	const errors: string[] = [];
	const subs = input.subtasks ?? [];
	if (subs.length < MIN_SUBTASKS) errors.push(`need at least ${MIN_SUBTASKS} subtasks, got ${subs.length}`);
	if (subs.length > MAX_SUBTASKS)
		errors.push(`too many subtasks (${subs.length} > ${MAX_SUBTASKS}); merge related work first`);
	const ids = new Set<string>();
	for (const s of subs) {
		if (!s.id || typeof s.id !== "string") {
			errors.push(`subtask missing string id: ${JSON.stringify(s).slice(0, 80)}`);
			continue;
		}
		if (ids.has(s.id)) errors.push(`duplicate subtask id: "${s.id}"`);
		ids.add(s.id);
		if (!s.title || !s.detail) errors.push(`subtask "${s.id}" missing title/detail`);
		const hasReads = Array.isArray(s.reads);
		const hasWrites = Array.isArray(s.writes);
		if (!hasReads && !hasWrites)
			errors.push(
				`subtask "${s.id}" declares no scope: set reads[]/writes[] explicitly (writes: [] means read-only)`,
			);
	}
	for (const s of subs) {
		for (const dep of s.depends_on ?? []) {
			if (!ids.has(dep)) errors.push(`subtask "${s.id}" depends_on unknown id "${dep}"`);
			if (dep === s.id) errors.push(`subtask "${s.id}" depends on itself`);
		}
	}
	return errors;
}

/** Kahn 拓扑分层；有环返回剩余节点列表。 */
export function kahnLayers(
	nodes: string[],
	edges: Array<{ a: string; b: string }>, // a 必须先于 b
): { layers: string[][]; cycle: string[] } {
	const indeg = new Map<string, number>(nodes.map((n) => [n, 0]));
	const out = new Map<string, string[]>(nodes.map((n) => [n, []]));
	for (const { a, b } of edges) {
		if (!indeg.has(a) || !indeg.has(b)) continue;
		indeg.set(b, (indeg.get(b) ?? 0) + 1);
		out.get(a)?.push(b);
	}
	let frontier = nodes.filter((n) => indeg.get(n) === 0);
	const layers: string[][] = [];
	const placed = new Set<string>();
	while (frontier.length > 0) {
		layers.push([...frontier]);
		const next: string[] = [];
		for (const n of frontier) {
			placed.add(n);
			for (const m of out.get(n) ?? []) {
				indeg.set(m, (indeg.get(m) ?? 0) - 1);
				if (indeg.get(m) === 0) next.push(m);
			}
		}
		frontier = next;
	}
	return { layers, cycle: nodes.filter((n) => !placed.has(n)) };
}

function pairKey(a: string, b: string): string {
	return a < b ? `pair:${a}:${b}` : `pair:${b}:${a}`;
}

function formatSubtask(s: Subtask): string {
	const parts = [
		`[${s.id}] ${s.title}: ${s.detail}`,
		`reads: ${(s.reads ?? []).join(", ") || "(none declared)"}`,
		`writes: ${(s.writes ?? []).join(", ") || "(read-only)"}`,
	];
	if (s.side_effects?.length) parts.push(`side effects: ${s.side_effects.join(", ")}`);
	if (s.depends_on?.length) parts.push(`declared dependencies: ${s.depends_on.join(", ")}`);
	return parts.join("; ");
}

/** 成对判定题（中性措辞，criteria 只定义是/否含义）。 */
export function buildPairQuestion(goal: string, A: Subtask, B: Subtask): NoulQuestion {
	return {
		instructions: [
			`Overall goal: ${goal}.`,
			`Subtask ${A.id}: ${A.title} — ${A.detail}. Reads: ${(A.reads ?? []).join(", ") || "none"}. Writes: ${(A.writes ?? []).join(", ") || "none"}.${A.side_effects?.length ? ` Side effects: ${A.side_effects.join(", ")}.` : ""}`,
			`Subtask ${B.id}: ${B.title} — ${B.detail}. Reads: ${(B.reads ?? []).join(", ") || "none"}. Writes: ${(B.writes ?? []).join(", ") || "none"}.${B.side_effects?.length ? ` Side effects: ${B.side_effects.join(", ")}.` : ""}`,
			`Can subtask ${A.id} and subtask ${B.id} be executed at the same time by two independent agents, without either one interfering with the other's inputs, files, runtime resources, or assumptions?`,
		].join("\n"),
		criteria: {
			true: "The two subtasks are fully independent: no shared mutable state, no file conflicts, no runtime resource conflicts, and neither consumes the other's output. They are safe to run concurrently.",
			false: "Running them concurrently risks interference: one depends on the other's output, they write the same files or resources, or one invalidates the other's assumptions.",
		},
	};
}

/** 整层复核题：兜成对判定漏掉的 n 元冲突。 */
export function buildLayerQuestion(goal: string, layer: Subtask[]): NoulQuestion {
	const roster = layer.map((s) => `- [${s.id}] ${s.title} — ${s.detail}`).join("\n");
	return {
		instructions: [
			`Overall goal: ${goal}.`,
			`The following ${layer.length} subtasks are scheduled to run ALL AT THE SAME TIME, each by an independent agent:`,
			roster,
			`Can ALL of them run simultaneously without any interference between any of them (files, shared state, runtime resources, ordering assumptions)?`,
		].join("\n"),
		criteria: {
			true: "The whole set is safe to run simultaneously as a group.",
			false: "Some combination within this group would interfere when all run at once, even if individual pairs look fine.",
		},
	};
}

export interface RunGateOptions {
	jev?: JevFn;
	thresholds?: Partial<Thresholds>;
}

export async function runGate(input: GateInput, opts: RunGateOptions = {}): Promise<Verdict> {
	const errors = validateInput(input);
	if (errors.length > 0) throw new Error(`parallel_gate input invalid:\n- ${errors.join("\n- ")}`);
	const th: Thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
	const subs = input.subtasks;
	const ids = subs.map((s) => s.id);
	const byId = new Map(subs.map((s) => [s.id, s]));
	const overrides = new Map(
		(input.overrides ?? []).map((o) => [o.a < o.b ? `${o.a}|${o.b}` : `${o.b}|${o.a}`, o.allow_parallel]),
	);
	const pairOverride = (a: string, b: string) =>
		overrides.get(a < b ? `${a}|${b}` : `${b}|${a}`);

	const edges: Edge[] = [];
	const edgeBetween = (a: string, b: string): Edge | undefined =>
		edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));

	// 声明依赖（有向）
	for (const s of subs) {
		for (const dep of s.depends_on ?? []) {
			edges.push({ a: dep, b: s.id, kind: "hard", reason: "declared" });
		}
	}
	// Layer 0：scope / side_effect 冲突（无向 → 拒绝同层；方向任意，按 id 序）
	for (const e of findScopeConflicts(subs.map((s) => ({ id: s.id, reads: s.reads ?? [], writes: s.writes ?? [] })))) {
		edges.push({ a: e.a, b: e.b, kind: "hard", reason: "scope-overlap", detail: `"${e.files[0]}" × "${e.files[1]}"` });
	}
	for (const e of findSideEffectConflicts(subs.map((s) => ({ id: s.id, side_effects: s.side_effects ?? [] })))) {
		edges.push({ a: e.a, b: e.b, kind: "hard", reason: "side-effect", detail: e.effect });
	}

	// Layer 1：Jev 成对判定
	const uncertain: UncertainPair[] = [];
	let jevStatus: Verdict["jev"] = { ok: false, error: "no jev function provided" };
	if (opts.jev) {
		const questions: Array<[string, NoulQuestion]> = [];
		const questionPairs = new Map<string, [Subtask, Subtask]>();
		for (let i = 0; i < subs.length; i++) {
			for (let j = i + 1; j < subs.length; j++) {
				const A = subs[i];
				const B = subs[j];
				if (edgeBetween(A.id, B.id)) continue; // 已有硬边/声明依赖，不问
				const key = pairKey(A.id, B.id);
				questions.push([key, buildPairQuestion(input.goal, A, B)]);
				questionPairs.set(key, [A, B]);
			}
		}
		const state = [
			`Overall goal: ${input.goal}`,
			input.context ? `Repository context:\n${input.context}` : "",
			`Subtasks:\n${subs.map(formatSubtask).join("\n")}`,
		]
			.filter(Boolean)
			.join("\n\n");
		try {
			const result = await opts.jev(state, Object.fromEntries(questions));
			jevStatus = { ok: true, latency_ms: result.latencyMs, batches: result.batches, usage: result.usage };
			for (const [key, [A, B]] of questionPairs) {
				const p = result.probabilities[key];
				if (p === undefined) throw new Error(`missing probability for ${key}`);
				const override = pairOverride(A.id, B.id);
				if (p <= th.veto) {
					edges.push({ a: A.id, b: B.id, kind: "hard", reason: "jev-veto", p_safe: p });
				} else if (p < th.safe) {
					if (override === true) continue; // 主模型确认可并行
					edges.push({ a: A.id, b: B.id, kind: "soft", reason: override === false ? "override-veto" : "jev-uncertain", p_safe: p });
					if (override !== false) uncertain.push({ a: A.id, b: B.id, p_safe: p, requires_confirmation: true });
				} else {
					if (override === false) {
						edges.push({ a: A.id, b: B.id, kind: "soft", reason: "override-veto", p_safe: p });
					}
					// 否则无边
				}
			}
		} catch (error) {
			jevStatus = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	// Jev 失败 → 降级：只做 Layer 0，topology=unknown，不猜分层
	if (!jevStatus.ok) {
		return {
			topology: "unknown",
			layers: [],
			edges,
			uncertain_pairs: [],
			jev: jevStatus,
			degenerate_warning:
				"Jev unavailable: only deterministic scope checks ran. Layers not computed — judge parallelism yourself or run sequentially.",
		};
	}

	// Layer 2：分层。声明依赖保留真实方向；无向冲突边（只表达「不能同层」）
	// 按 id 序定方向作为拓扑占位。方向互相矛盾时 Kahn 检出成环。
	const declared = edges.filter((e) => e.reason === "declared").map((e) => ({ a: e.a, b: e.b }));
	const nonDeclared = edges.filter((e) => e.reason !== "declared");
	const graphEdges = [
		...declared,
		...nonDeclared
			.filter((e) => !declared.some((d) => (d.a === e.a && d.b === e.b) || (d.a === e.b && d.b === e.a)))
			.map((e) => ({ a: e.a < e.b ? e.a : e.b, b: e.a < e.b ? e.b : e.a })),
	];
	const { layers: rawLayers, cycle } = kahnLayers(ids, graphEdges);
	if (cycle.length > 0) {
		throw new Error(
			`parallel_gate: dependency cycle detected involving: ${cycle.join(", ")}. ` +
				`Fix depends_on declarations (a declared dependency contradicts other constraints) and call again.`,
		);
	}

	// Layer 3：整层复核（仅多人层）；先收集降级结果，最后一次性重建 layers，
	// 避免边遍历边 splice 的索引漂移。
	const demoted: Array<{ subtasks: string[]; p_safe: number }> = [];
	const demotedIdx = new Set<number>();
	if (opts.jev) {
		const layerQuestions: Array<[string, NoulQuestion]> = [];
		const layerIndex = new Map<string, number>();
		rawLayers.forEach((layer, idx) => {
			if (layer.length > 1) {
				const key = `layer:${idx}`;
				layerQuestions.push([key, buildLayerQuestion(input.goal, layer.map((id) => byId.get(id)!))]);
				layerIndex.set(key, idx);
			}
		});
		if (layerQuestions.length > 0) {
			try {
				const state = [
					`Overall goal: ${input.goal}`,
					input.context ? `Repository context:\n${input.context}` : "",
					`Subtasks:\n${subs.map(formatSubtask).join("\n")}`,
				]
					.filter(Boolean)
					.join("\n\n");
				const result = await opts.jev(state, Object.fromEntries(layerQuestions));
				for (const [key, p] of Object.entries(result.probabilities)) {
					const idx = layerIndex.get(key);
					if (idx !== undefined && p < th.layerVeto) {
						demotedIdx.add(idx);
						demoted.push({ subtasks: rawLayers[idx], p_safe: p });
					}
				}
			} catch {
				// 整层复核失败不降级 verdict：成对判定仍然有效
			}
		}
	}
	const layers: string[][] = rawLayers.flatMap((layer, idx) =>
		demotedIdx.has(idx) ? layer.map((id) => [id]) : [layer],
	);

	const multiLayers = layers.filter((l) => l.length > 1).length;
	const topology: Verdict["topology"] =
		layers.length === 1 && layers[0].length > 1
			? "parallel"
			: layers.length === ids.length
				? "sequential"
				: multiLayers > 0
					? "pipeline"
					: "sequential";

	let degenerate_warning: string | undefined;
	if (topology === "sequential" && uncertain.length > 0) {
		degenerate_warning =
			`All parallelism collapsed to sequential and ${uncertain.length} pair(s) are uncertain. ` +
			`Refine subtask detail/scope and re-call, or pass overrides to confirm pairs you judge safe.`;
	}

	return {
		topology,
		layers,
		edges,
		uncertain_pairs: uncertain,
		...(demoted.length > 0 ? { demoted_layers: demoted } : {}),
		...(degenerate_warning ? { degenerate_warning } : {}),
		jev: jevStatus,
	};
}
