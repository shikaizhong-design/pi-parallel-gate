# TaskFlow 集成（v0.2.0）

TaskFlow（用户级扩展，`~/.pi/agent/extensions/taskflow.ts`）维护可见任务计划：
`taskflow` 工具管理全量步骤列表（title/status/**stage**），widget 实时渲染，
stage 字段把连续步骤分组显示。

## 集成方案：prompt 层协同，零逻辑改动

两个扩展通过各自的 promptGuidelines 协同，不共享代码：

1. TaskFlow 拆步骤（现有行为）
2. 打算并行时：复用 taskflow 的步骤作为 parallel_gate 的 subtask 列表，
   逐步补齐 reads[]/writes[]/depends_on[]（不另起第二份拆解）
3. parallel_gate 出 verdict.layers
4. 重发 taskflow 计划，stage = "L0 并行批" / "L1 并行批"…，
   widget 直接以分组形式展示并行批次
5. 按 layers 派 subagent，逐批更新 taskflow 状态

边界：两扩展各自独立可用；不合并工具、不加事件钩子互联（YAGNI）。

## 实测证据（2026-09-22，TUI 实测）

输入（无触发词的自然 prompt）：
> 帮我把 README.md 翻译成英文写到 README.en.md，同时给 src/utils.ts 补上单元测试，
> 再把 package.json 的 description 改成英文。这几件事尽量并行搞。
> 注意：只做到出并行判定结论为止，先别真的改文件。

观测到的链路（tmux 录屏）：

```
agent: ls 确认文件 → parallel_gate（3 subtasks）→ taskflow 重发（带 stage）
parallel_gate 输出：
  Topology: pipeline
  Layers: L0=[t1, t2]  L1=[t3]
  Hard edges: t2 × t3 — scope-overlap ("package.json" × "package.json")
  Jev: 2 batch(es), 1866ms        ← 成对判定 + 整层复核均真实运行
TaskFlow widget 渲染：
  ⚡ TaskFlow ░░░░░░░░░░░░ 0/3
    ▸ L0 并行批 · 0/2
      ○ 翻译 README.md → README.en.md
      ○ 为 src/utils.ts 补单元测试
    ▸ L1 串行（等 L0） · 0/1
      ○ package.json description 改英文
```

要点：t2（写测试）声明读 package.json、t3 写 package.json → 确定性硬边，
t3 被正确排进 L1；t1/t2 经 Jev 判定语义独立 → L0 同批。
触发路径为 guideline #1（无触发词、无斜杠命令）——即「无感自动」。
