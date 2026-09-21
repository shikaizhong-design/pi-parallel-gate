/**
 * smoke.ts — 真实 Jev API 端到端冒烟（需要 TYPESAFE_API_KEY）
 * 三用例：安全并行 / 显式依赖 / 模糊 scope（fail-safe 方向验证）
 */
import { runGate, type GateInput, type Verdict } from "../src/gate.ts";
import { evaluateNoul } from "../src/jev.ts";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
	console.error("TYPESAFE_API_KEY not set");
	process.exit(1);
}
const jev = (state: string, questions: Parameters<typeof evaluateNoul>[2]) =>
	evaluateNoul(apiKey, state, questions);

const cases: Array<{ name: string; expect: Verdict["topology"] | "not-parallel"; input: GateInput }> = [
	{
		name: "安全并行：文档 + 测试（不相交文件）",
		expect: "parallel",
		input: {
			goal: "Improve a small TypeScript CLI repo",
			subtasks: [
				{
					id: "docs",
					title: "Write English README",
					detail: "Translate the existing Chinese README into English, same structure",
					reads: ["README.md"],
					writes: ["README.en.md"],
				},
				{
					id: "tests",
					title: "Unit tests for utils",
					detail: "Add node:test unit tests covering src/utils.ts helpers",
					reads: ["src/utils.ts"],
					writes: ["test/utils.test.ts"],
				},
			],
		},
	},
	{
		name: "显式依赖：schema → 迁移脚本",
		expect: "not-parallel",
		input: {
			goal: "Add a users table to the app",
			subtasks: [
				{
					id: "schema",
					title: "Define users table schema",
					detail: "Write db/schema.sql defining the users table",
					reads: [],
					writes: ["db/schema.sql"],
				},
				{
					id: "migration",
					title: "Write migration script",
					detail: "Write a migration that applies the users table schema defined by the schema subtask",
					reads: ["db/schema.sql"],
					writes: ["db/migrations/001_users.sql"],
					depends_on: ["schema"],
				},
			],
		},
	},
	{
		name: "语义依赖无文件重叠：API 端点 + 调用它的前端组件（期望 Jev 否决）",
		expect: "not-parallel",
		input: {
			goal: "Add a users list feature to a web app",
			subtasks: [
				{
					id: "api",
					title: "Implement GET /api/users endpoint",
					detail: "Create the backend endpoint returning the users list JSON; defines the response shape",
					reads: ["src/server/**"],
					writes: ["src/server/routes/users.ts"],
				},
				{
					id: "ui",
					title: "Frontend users list component",
					detail: "React component that fetches GET /api/users and renders the list; must match the response shape produced by the api subtask",
					reads: ["src/client/**"],
					writes: ["src/client/components/UsersList.tsx"],
				},
			],
		},
	},
	{
		name: "模糊用例：都可能碰 config（fail-safe 应加边或 uncertain）",
		expect: "not-parallel",
		input: {
			goal: "Tune app configuration",
			subtasks: [
				{
					id: "logging",
					title: "Adjust logging config",
					detail: "Increase log verbosity for the worker module in app config",
					reads: ["config/**"],
					writes: ["config/**"],
				},
				{
					id: "retry",
					title: "Adjust retry config",
					detail: "Change retry backoff settings in app config",
					reads: ["config/**"],
					writes: ["config/**"],
				},
			],
		},
	},
];

let failed = 0;
for (const c of cases) {
	const v = await runGate(c.input, { jev });
	const parallel = v.topology === "parallel";
	const pass = c.expect === "parallel" ? parallel : !parallel;
	if (!pass) failed++;
	console.log(`${pass ? "✔" : "✘"} ${c.name}`);
	console.log(
		`  topology=${v.topology} layers=${JSON.stringify(v.layers)} jev=${v.jev.ok} (${v.jev.latency_ms}ms, ${v.jev.batches} batch, ${JSON.stringify(v.jev.usage)})`,
	);
	for (const e of v.edges) console.log(`  edge ${e.a}×${e.b} ${e.kind}/${e.reason}${e.p_safe !== undefined ? ` p=${e.p_safe.toFixed(2)}` : ""}`);
	for (const u of v.uncertain_pairs) console.log(`  uncertain ${u.a}×${u.b} p=${u.p_safe.toFixed(2)}`);
}
console.log(failed === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
