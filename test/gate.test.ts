import { test } from "node:test";
import assert from "node:assert/strict";
import { globsMayOverlap, findScopeConflicts, findSideEffectConflicts } from "../src/scope.ts";
import { runGate, kahnLayers, validateInput, type GateInput, type JevFn } from "../src/gate.ts";

// ---------- scope.ts ----------

test("glob normalization & overlap basics", () => {
	assert.equal(globsMayOverlap("src/**", "src/auth/**"), true);
	assert.equal(globsMayOverlap("./src/**", "SRC/auth/**"), true); // ./ + 大小写
	assert.equal(globsMayOverlap("src/a.ts", "src/b.ts"), false); // 两个字面路径不同
	assert.equal(globsMayOverlap("src/a.ts", "src/a.ts"), true);
	assert.equal(globsMayOverlap("README.md", "src/**"), false);
	assert.equal(globsMayOverlap("src/**/*.test.ts", "src/utils/**"), true); // 前缀相交，保守
	assert.equal(globsMayOverlap("!src/**", "docs/**"), true); // 否定 → 保守判相交
});

test("findScopeConflicts: 写-写/写-读出边，读-读不出", () => {
	const subs = [
		{ id: "a", reads: ["src/x.ts"], writes: ["src/y.ts"] },
		{ id: "b", reads: ["src/y.ts"], writes: [] }, // b 读 a 写 → 边
		{ id: "c", reads: ["src/x.ts"], writes: [] }, // c 与 a 读同一文件 → 无边
	];
	const edges = findScopeConflicts(subs);
	assert.deepEqual(
		edges.map((e) => [e.a, e.b]),
		[["a", "b"]],
	);
});

test("findSideEffectConflicts: 相同 side effect 出边", () => {
	const edges = findSideEffectConflicts([
		{ id: "a", side_effects: ["dev server on :3000"] },
		{ id: "b", side_effects: ["Dev server on :3000"] },
		{ id: "c", side_effects: ["writes tmp/x.db"] },
	]);
	assert.equal(edges.length, 1);
	assert.equal(edges[0].a, "a");
});

// ---------- gate.ts: 校验 ----------

const baseSub = {
	reads: [] as string[],
	writes: [] as string[],
};

test("validateInput: 未声明 scope / 重复 id / 悬空依赖 / 超数量", () => {
	const mk = (over: Partial<GateInput>): GateInput => ({
		goal: "g",
		subtasks: [
			{ id: "a", title: "t", detail: "d", ...baseSub },
			{ id: "b", title: "t", detail: "d", ...baseSub },
		],
		...over,
	});
	assert.equal(validateInput(mk({})).length, 0);
	assert.ok(validateInput(mk({ subtasks: [{ id: "a", title: "t", detail: "d" }] as never })).length >= 2); // 数量+scope
	assert.ok(validateInput(mk({ subtasks: [mk({}).subtasks[0], mk({}).subtasks[0]] }))[0].includes("duplicate"));
	assert.ok(
		validateInput(
			mk({ subtasks: [{ ...mk({}).subtasks[0], depends_on: ["zzz"] }, mk({}).subtasks[1]] }),
		)[0].includes("unknown id"),
	);
});

// ---------- gate.ts: Kahn + 环 ----------

test("kahnLayers: 正常分层与环检出", () => {
	const r = kahnLayers(["a", "b", "c"], [{ a: "a", b: "b" }]);
	assert.deepEqual(r.cycle, []);
	assert.deepEqual(r.layers[0].sort(), ["a", "c"]);
	assert.deepEqual(r.layers[1], ["b"]);
	const cyc = kahnLayers(["a", "b"], [
		{ a: "a", b: "b" },
		{ a: "b", b: "a" },
	]);
	assert.deepEqual(cyc.cycle.sort(), ["a", "b"]);
});

// ---------- gate.ts: 端到端（mock Jev） ----------

const mockJev =
	(probs: Record<string, number>): JevFn =>
	async (_state, questions) => ({
		probabilities: Object.fromEntries(Object.keys(questions).map((k) => [k, probs[k] ?? 0.9])),
		usage: {},
		latencyMs: 1,
		batches: 1,
	});

const threeWay: GateInput = {
	goal: "demo",
	subtasks: [
		{ id: "a", title: "docs", detail: "write English README", reads: ["README.md"], writes: ["README.en.md"] },
		{ id: "b", title: "tests", detail: "unit tests for utils", reads: ["src/utils/**"], writes: ["test/utils.test.ts"] },
		{ id: "c", title: "schema", detail: "define db schema", reads: [], writes: ["db/schema.sql"] },
	],
};

test("runGate: 全部安全 → parallel 单层", async () => {
	const v = await runGate(threeWay, { jev: mockJev({ "layer:0": 0.95 }) });
	assert.equal(v.topology, "parallel");
	assert.deepEqual(v.layers, [["a", "b", "c"]]);
	assert.equal(v.jev.ok, true);
});

test("runGate: p_safe ≤ veto → 硬边", async () => {
	const v = await runGate(threeWay, { jev: mockJev({ "pair:a:b": 0.1 }) });
	const e = v.edges.find((e) => e.reason === "jev-veto");
	assert.ok(e);
	assert.equal(e.kind, "hard");
});

test("runGate: 中间概率 → 软边 + uncertain_pairs", async () => {
	const v = await runGate(threeWay, { jev: mockJev({ "pair:a:b": 0.5 }) });
	const e = v.edges.find((e) => e.reason === "jev-uncertain");
	assert.ok(e);
	assert.equal(e.kind, "soft");
	assert.equal(v.uncertain_pairs.length, 1);
});

test("runGate: overrides 确认软边 → 放行", async () => {
	const v = await runGate(
		{ ...threeWay, overrides: [{ a: "a", b: "b", allow_parallel: true }] },
		{ jev: mockJev({ "pair:a:b": 0.5 }) },
	);
	assert.equal(v.edges.filter((e) => e.reason === "jev-uncertain").length, 0);
	assert.equal(v.uncertain_pairs.length, 0);
});

test("runGate: scope 冲突不问 Jev（节省调用）", async () => {
	const input: GateInput = {
		goal: "g",
		subtasks: [
			{ id: "a", title: "t", detail: "d", reads: [], writes: ["src/**"] },
			{ id: "b", title: "t", detail: "d", reads: [], writes: ["src/x.ts"] },
		],
	};
	let asked = 0;
	const jev: JevFn = async (_s, q) => {
		asked += Object.keys(q).length;
		return { probabilities: {}, usage: {}, latencyMs: 1, batches: 1 };
	};
	const v = await runGate(input, { jev });
	assert.equal(asked, 0); // 整层只有 2 人但已有硬边 → 不成对问；层也不复核（层仅 1 人×2）
	assert.ok(v.edges.some((e) => e.reason === "scope-overlap"));
});

test("runGate: 声明依赖成环 → 报错", async () => {
	const input: GateInput = {
		goal: "g",
		subtasks: [
			{ id: "a", title: "t", detail: "d", ...baseSub, depends_on: ["b"] },
			{ id: "b", title: "t", detail: "d", ...baseSub, depends_on: ["a"] },
		],
	};
	await assert.rejects(() => runGate(input, { jev: mockJev({}) }), /cycle/);
});

test("runGate: 整层复核不通过 → 降级串行", async () => {
	const v = await runGate(threeWay, { jev: mockJev({ "layer:0": 0.2 }) });
	assert.equal(v.topology, "sequential");
	assert.equal(v.demoted_layers?.length, 1);
});

test("runGate: Jev 抛错 → 优雅降级 topology=unknown", async () => {
	const badJev: JevFn = async () => {
		throw new Error("TypeSafe 401: bad key");
	};
	const v = await runGate(threeWay, { jev: badJev });
	assert.equal(v.jev.ok, false);
	assert.equal(v.topology, "unknown");
	assert.match(v.jev.error ?? "", /401/);
});

test("runGate: 全塌缩 + 有 uncertain → degenerate 告警", async () => {
	const v = await runGate(threeWay, { jev: mockJev({ "pair:a:b": 0.5, "pair:a:c": 0.5, "pair:b:c": 0.5 }) });
	assert.equal(v.topology, "sequential");
	assert.match(v.degenerate_warning ?? "", /collapsed/);
});

test("validateInput: id 含冒号/空格等字符 → 拒绝（防 pairKey 碰撞）", () => {
	const input: GateInput = {
		goal: "g",
		subtasks: [
			{ id: "a:b", title: "t", detail: "d", ...baseSub },
			{ id: "c", title: "t", detail: "d", ...baseSub },
		],
	};
	assert.ok(validateInput(input).some((e) => e.includes("[A-Za-z0-9_-]")));
});

test("runGate: 成对成功但整层复核抛错 → layer_check=failed 显式标注", async () => {
	let call = 0;
	const jev: JevFn = async (_s, questions) => {
		call++;
		if (Object.keys(questions).some((k) => k.startsWith("layer:"))) throw new Error("529 overloaded");
		return {
			probabilities: Object.fromEntries(Object.keys(questions).map((k) => [k, 0.95])),
			usage: {},
			latencyMs: 1,
			batches: 1,
		};
	};
	const v = await runGate(threeWay, { jev });
	assert.equal(v.jev.ok, true);
	assert.equal(v.jev.layer_check, "failed");
	assert.match(v.jev.error ?? "", /529/);
	assert.ok(call >= 2);
	// fail-closed：复核失败的 verdict 不得含任何多人层
	assert.ok(v.layers.every((l) => l.length === 1));
});

test("runGate: 整层复核响应缺 layer 答案 → layer_check=failed（fail-closed）", async () => {
	const jev: JevFn = async (_s, questions) => {
		const keys = Object.keys(questions);
		if (keys.some((k) => k.startsWith("layer:"))) {
			return { probabilities: {}, usage: {}, latencyMs: 1, batches: 1 }; // 部分响应：无 layer 答案
		}
		return {
			probabilities: Object.fromEntries(keys.map((k) => [k, 0.95])),
			usage: {},
			latencyMs: 1,
			batches: 1,
		};
	};
	const v = await runGate(threeWay, { jev });
	assert.equal(v.jev.ok, true);
	assert.equal(v.jev.layer_check, "failed");
	assert.match(v.jev.error ?? "", /missing\/invalid layer answer/);
});

test("runGate: 降级模式 verdict 形状（layers 空、硬边保留）", async () => {
	const input: GateInput = {
		goal: "g",
		subtasks: [
			{ id: "a", title: "t", detail: "d", reads: [], writes: ["src/**"] },
			{ id: "b", title: "t", detail: "d", reads: ["src/x.ts"], writes: [] },
		],
	};
	const badJev: JevFn = async () => {
		throw new Error("no key");
	};
	const v = await runGate(input, { jev: badJev });
	assert.equal(v.topology, "unknown");
	assert.deepEqual(v.layers, []);
	assert.equal(v.edges.length, 1);
	assert.equal(v.edges[0].reason, "scope-overlap");
});

test("runGate: 无向冲突边不制造假环（回归：c→a→b 合法调度不得误判 cycle）", async () => {
	// a depends_on c；b depends_on a；b 与 c 有 scope 冲突。
	// 旧实现把冲突边按词序定向（b→c），与 c→a、a→b 构成假环；正确调度是 c→a→b。
	const input: GateInput = {
		goal: "g",
		subtasks: [
			{ id: "a", title: "t", detail: "d", reads: [], writes: ["src/a.ts"], depends_on: ["c"] },
			{ id: "b", title: "t", detail: "d", reads: [], writes: ["src/**"], depends_on: ["a"] },
			{ id: "c", title: "t", detail: "d", reads: [], writes: ["src/c.ts"] },
		],
	};
	const v = await runGate(input, { jev: mockJev({}) });
	assert.equal(v.topology, "sequential");
	assert.deepEqual(v.layers, [["c"], ["a"], ["b"]]);
});

test("runGate: 同层冲突对拆到不同子层，不冲突的保持同层", async () => {
	// a×b scope 冲突、与 c 都无冲突 → [[a, c], [b]]（贪心保持原顺序）
	const input: GateInput = {
		goal: "g",
		subtasks: [
			{ id: "a", title: "t", detail: "d", reads: [], writes: ["src/a.ts"] },
			{ id: "b", title: "t", detail: "d", reads: ["src/a.ts"], writes: [] },
			{ id: "c", title: "t", detail: "d", reads: [], writes: ["docs/c.md"] },
		],
	};
	const v = await runGate(input, { jev: mockJev({ "layer:0": 0.95 }) });
	assert.deepEqual(v.layers, [["a", "c"], ["b"]]);
	assert.equal(v.topology, "pipeline");
});
