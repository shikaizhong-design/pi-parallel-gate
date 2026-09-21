# pi-parallel-gate 设计文档（v0.2 多模型复核修订版）

日期：2026-09-21 ｜ 状态：Grok / GPT / Kimi 三方独立复核（均 BLOCK）后修订

> v0.2 修订记录（三方共识 → 采纳方案）：
> 1. **环检测缺失**（三方）→ 输入校验 + Kahn 残余节点检测，有环直接报错退回主模型。
> 2. **概率语义模糊**（GPT）→ 明确 noul 返回值 = p（可以安全并行），阈值方向统一。
> 3. **阈值拍脑袋**（三方）→ 三段阈值可配置，默认值待冒烟/校准脚本标定；不确定对不静默加边。
> 4. **读写不分**（Kimi/GPT）→ scope 拆 `reads`/`writes`，仅写-写、写-读出硬边。
> 5. **n 元冲突盲区**（Kimi）→ 分层后对每个多人并行层补一道整体是非题，不过则整层降级串行。
> 6. **Noul 措辞诱导**（Grok/GPT）→ 中性问句 + criteria 只定义是/否含义。
> 7. **glob 启发式漏判**（三方）→ 规范化（去 `./`、小写、相对 cwd），`[]{}!` 一律保守判相交。
> 8. **批量稀释**（Kimi）→ 每请求 ≤20 题，分批聚合。
> 9. **上下文不足**（Kimi/Grok）→ state 附仓库顶层结构 + 结构化 side_effects 字段。
> 10. **过度串行化**（三方）→ 不确定对记「软边」显式返回待确认；并行度塌缩时给 degenerate 告警。

## 1. 问题与目标

pi（及所有主流编码 agent）不会在派多个 subagent 前判断「这些子任务到底能不能安全并行」。
**目标**：pi 扩展，在「想并行派活」与「实际派活」之间插一道便宜、快速、可否决的闸门。
判定用 Jev（TypeSafe System One），调度用确定性代码。

**非目标**：不做任务拆解（归主模型）；不做编排执行（归 pi Agent/SubagentWorkflow/worktree）；
不替代事后验证（git diff、跑测试兜底）。

## 2. 架构

```
主模型打算并行派活
   │
   ├─ 1. 主模型产出任务图（开放生成）：
   │      [{id, title, detail, reads: [glob], writes: [glob],
   │        side_effects: [文本], depends_on: [id]}]
   │      规则：每个子任务必须显式声明 reads/writes（writes: [] = 只读）；
   │           写文件/有副作用却不声明 → 工具报错退回补全。
   ▼
parallel_gate 工具（本扩展注册的唯一工具）
   │
   ├─ Layer 0 · 确定性检查（零模型调用）
   │      writes×writes、writes×reads glob 相交 → 硬边（read-read 不加边）
   │      side_effects 规范化后字符串相同 → 硬边（如两个任务都起 :3000）
   │
   ├─ Layer 1 · Jev 成对判定（分批 ≤20 题/请求，~100ms/批，<1 分钱）
   │      对无声明依赖且无硬边的每个子任务对出 Noul 是非题（中性措辞）：
   │      noul 返回值 = p（两队可安全并行），方向固定，阈值见 §3
   │
   ├─ Layer 2 · 策略与调度（纯代码）
   │      硬边 = 声明依赖 ∪ glob 冲突 ∪ side_effect 冲突 ∪ {p ≤ veto 阈值}
   │      软边 = {veto < p < safe 阈值}（不确定，fail-safe 默认不同层，显式返回待确认）
   │      输入校验 + Kahn 分层（有环 → 报错列出环节点）
   │
   ├─ Layer 3 · 整层复核（每批一道 Noul）
   │      对每个 >1 人的并行层：「这些子任务能否全部同时跑？」
   │      p < 0.5 → 该层降级为串行，verdict 记录原因（兜 n 元冲突盲区）
   ▼
verdict JSON → 主模型：
   { topology, layers, edges[{a,b,kind:hard|soft,reason}],
     uncertain_pairs[{a,b,p_safe,requires_confirmation:true}],
     degenerate_warning?, jev:{ok,latency_ms,batches,error?} }
   │
   ▼
主模型执行：parallel→同层并行派 Agent（worktree 隔离）；
pipeline→按层、层内并行；sequential→串行；
jev.ok=false→主模型自行判断，绝不阻塞。
```

## 3. Jev 调用

- `POST https://api.typesafe.ai/v1/systemone`，Bearer `$TYPESAFE_API_KEY`，`model: "jev-latest"`。
- 请求：`{state, model, questions: {id: {type:"noul", instructions, criteria}}}`；
  响应 `answers[id].noul` ∈ [0,1] = 答案为「是」的概率。
- **语义约定**：问题固定为「这两个子任务能否由两个独立 agent 同时执行而互不干扰？」
  `noul` = **p_safe（可安全并行的概率）**，阈值全部按 p_safe 方向定义。
- 阈值（可配置，默认值为冒烟前初值，scripts/calibrate.ts 标定后调整）：
  - `safe ≥ 0.70` → 无边，可并行
  - `veto ≤ 0.30` → 硬边（否决并行）
  - 之间 → **软边**：默认排进不同层，记入 `uncertain_pairs` 并
    `requires_confirmation: true`；主模型可补全 detail/scope 重调工具，或显式覆盖
- 429/529 → 指数退避 1s/2s/4s 最多 3 次；单请求 ≤20 题，分批并发聚合；
  总超时 15s；任何失败 → `jev.ok=false` 优雅降级（verdict 仅含 Layer 0 结果 +
  `topology: "unknown"`），主模型自行判断。
- 上限：子任务数 2–12；超出报错请先合并。
- 纪律：state 只含任务描述/glob/仓库顶层清单，**不含代码内容、密钥、客户敏感信息**。

## 4. Layer 0：确定性冲突检查

- glob 规范化：去 `./`、反斜杠转正、小写、去尾 `/`，相对 cwd。
- 支持 `*` `**` `?`；出现 `[` `]` `{` `}` `!` 一律**保守判相交**（宁多判冲突）。
- 相交 = 两 glob 静态前缀在路径段边界上互为前缀（`src/**` × `src/utils/**` → 相交，
  保守方向）。`# ponytail: 保守启发式，误判代价是退串行（安全方向）；精确语义相交无必要。`
- 只比较 writes×writes 与 writes×reads；reads×reads 不加边。
- side_effects：trim+小写规范化，两子任务字符串相同 → 硬边。

## 5. 工具定义（pi.registerTool）

- name: `parallel_gate`
- parameters（typebox）：`goal: string`；
  `subtasks: Array<{id, title, detail, reads?: string[], writes?: string[],
  side_effects?: string[], depends_on?: string[]}>`；
  可选 `overrides?: Array<{a, b, allow_parallel: boolean}>`（主模型对软边的显式覆盖）
- 校验失败（id 重复/悬空引用/环/未声明 scope/数量越界）→ throw（isError），
  错误信息说明怎么修，主模型修正后重调。
- promptGuidelines：
  - 「并行派 2 个以上会写文件的 subagent 前，先调 parallel_gate」
  - 「按 verdict.layers 派活；硬边否决的对不得同批并行」
  - 「uncertain_pairs 要么补全信息重调，要么显式 overrides 覆盖并承担风险」
  - 「verdict.jev.ok=false 时自行判断」
- 返回：content = 人读摘要；details = 完整 verdict JSON。

## 6. 失败模式与对策

| 失败模式 | 对策 |
|---|---|
| Jev 漏判真依赖 | Layer 0 硬边 + Layer 3 整层复核 + 事后 git diff/测试兜底 |
| Jev 误判可并行→依赖 | 代价是退串行（安全方向）；degenerate 告警提示主模型复查 |
| 软边过密导致全串行 | 软边显式返回 + overrides 通道 + degenerate_warning |
| 主模型 scope 声明不全 | 强制声明校验；事后 diff 核对声明范围 |
| 环/非法输入 | 校验报错，不产出 verdict |
| Jev 故障 | jev.ok=false 降级，不阻塞 |

## 7. 测试计划

1. `test/gate.test.ts`（node --test + mock Jev）：校验、环检测、读写边规则、
   阈值三段、分层、整层降级、degenerate 告警、Jev 失败降级。
2. `scripts/smoke.ts`（真实 API）三用例：安全并行 / 显式依赖 / 模糊 scope。
3. pi 内端到端：主模型拆任务 → 调 parallel_gate → 按 verdict 派活。

## 8. 仓库结构

```
pi-parallel-gate/
├── package.json          # pi.extensions → ./src/index.ts
├── src/
│   ├── index.ts          # 扩展入口，注册 parallel_gate
│   ├── gate.ts           # 纯逻辑：校验、建边、分层、阈值（可单测）
│   ├── jev.ts            # Jev HTTP 客户端（分批/退避/超时）
│   └── scope.ts          # glob 规范化与保守相交
├── test/gate.test.ts
├── scripts/smoke.ts
├── docs/design.md
├── README.md
└── LICENSE (MIT)
```
