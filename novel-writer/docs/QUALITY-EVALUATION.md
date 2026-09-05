# Inkwell 文章质量 A/B 发布协议

## 当前结论

当前发布决策是 **hold**。`quality-release.js` 的 schema-v2 决策记录因而把新安装的 `productionEngineEnabled` 默认值设为 `false`；已有用户配置不被强制改写，任何用户也可以在设置中手动试用“契约化整章生产引擎（候选）”。`quality-release-policy.js` 会在运行时拒绝字段不全的伪提升，`verify-quality-release.mjs` 则在 CI 中核对当前源码与证据引用。

这个结论不是说候选实现一定更差，而是说仓库里尚无一份完整、真实、带人工盲评的通过报告。代码结构改善、引擎自己的 Semantic Critic、合成 fixture 和开发者主观阅读，都不能单独证明文章质量提升。

## 比较对象

固定 corpus 位于 `evaluation/corpus-v1.json`：6 个题材，每个题材 8 个连续章节，共 48 组配对、96 份正文。

- `baseline`：0.19 Harness，一次性写章；
- `candidate`：Chapter Contract + Scene Contracts + 单次整章连贯起草 + Semantic Critic + 有界救稿；
- 两边使用同一 seed、同一任务、同一温度、同一基础模型和同一输出预算；
- 模型 judge 在正文全部生成之后读隐藏实现标签的 A/B 对；人工评审使用同一份盲评包；
- 引擎自己的 critic 只作为工件保存，不进入独立盲评结果，避免“自己生成、自己证明”。

固定题材覆盖玄幻、近未来科幻、都市职场、古言悬疑、现实家庭和赛博朋克侦探。Corpus 校验会拒绝少于 6 个 seed、不是每个 8 章、缺任务目标/冲突/钩子或重复 id 的输入。

## 一个命令生成实验

先运行不调用模型的协议校准：

```powershell
cd novel-writer
node scripts/quality-ab.mjs fixture --out .quality/fixture-v1
node scripts/quality-ab.mjs gate --run .quality/fixture-v1 --allow-fixture
```

校准会稳定生成 96 份工件和 48 组盲评对，预期决策为 `calibration-pass`，但 `releaseEligible` 永远是 `false`。它只证明文件结构、随机分配、评分聚合和门禁代码能工作，不证明任何真实文章更好。

完整真实 A/B 会产生大量模型调用和费用，必须显式确认：

```powershell
$env:INKWELL_EVAL_CONFIRM = "YES"
$env:INKWELL_BASE_URL = "https://your-openai-compatible-service.example/v1"
$env:INKWELL_API_KEY = "..."
$env:INKWELL_MODEL = "your-generation-model"
$env:INKWELL_JUDGE_MODEL = "your-independent-judge-model"
node scripts/quality-ab.mjs live --out .quality/live-v1
```

建议 `INKWELL_JUDGE_MODEL` 使用不同模型系列；若留空则使用生成模型，但报告仍把 judge 和引擎自评分开。密钥只存在于进程环境和 HTTP header，不写入工件。生成参数由 corpus 固定，CLI 覆盖会被拒绝式忽略，避免挑参数追结果。

真实生成结束后，把 `blind-packet.json` 交给不知道实现映射的评审。评审复制 `human-ratings.template.json` 为 `human-ratings.json`，为每个 pair 的 A/B 在八个维度各填 1–10 分和唯一 `raterId`。评审不能读取 `blind-key.json`。然后运行：

```powershell
node scripts/quality-ab.mjs gate --run .quality/live-v1 --human .quality/live-v1/human-ratings.json
```

同一条 `gate` 命令可重复计算报告；它不再次调用模型。只有 gate 已得到 `pass/releaseEligible=true` 时，才可生成去正文的提升证据包：

```powershell
node scripts/quality-ab.mjs promote --run .quality/live-v1 --out evaluation/approved-quality-release.json
```

fixture、人工评分不全、工件被改写或源码 fingerprint 已变化时，`promote` 会拒绝写出文件。

## 工件与可追溯性

每个 run 目录包含：

```text
run.json                         唯一 run id、协议、模型、corpus hash、质量源码 manifest/fingerprint
corpus.json                      当次冻结的完整 corpus
artifacts.json                   96 份工件索引
artifacts/<seed>/*.json          prompt、context manifest、正文、critic、本地指标
raw/*.json                       两条运行链的完整项目状态
blind-packet.json                无实现标签的 A/B 正文
blind-key.json                   A/B 到 baseline/candidate 的映射
judge-prompts/*.json             独立模型 judge 的实际请求（无密钥）
judge-ratings.json               独立模型评分
human-ratings.template.json      人工评分模板
human-ratings.json               评审填写后放入
report.json                      可机器判定的最终门禁
```

每份章节工件必须保存：实际模型请求消息与参数、任务 id、阶段、context manifest、正文与 SHA-256、引擎 critic、连续性 blocker/Canon 冲突、本地确定性信号和运行终态。`api.js` 的可选审计端口只记录去凭据请求；响应正文不在审计事件里重复保存，只记录 hash、字符数、finish reason 和 usage。

`.quality/` 默认被 Git 忽略，因为真实正文和上下文可能包含作者材料。需要长期保留的完整通过报告应放到访问受控的制品存储；仓库只提交由 `promote` 生成、去正文且带摘要 hash 的 `evaluation/approved-quality-release.json`。

`scripts/quality-source-contract.mjs` 是实验实际加载清单和证据清单的共同权威。当前 fingerprint 覆盖 baseline/candidate 生成、prompt、上下文/记忆/RAG、模型适配、连续性评测、确定性评分、release gate 与证据验证共 27 个关键文件。每个文本先把 CRLF/CR 规范为 LF，再逐文件 SHA-256 和聚合；因此不同 Windows checkout 不会产生假失效，但任何关键逻辑、文件集合或顺序变化都会使旧报告的 `quality-source-current` 检查失败。`quality-release.js` 自身不进入 fingerprint，避免“把已通过报告提升为默认”反过来令同一报告自失效。

## 三类证据严格分层

1. **本地确定性信号**：长度比例、must-include/beat 锚点、钩子落点、重复 n-gram、对白比例、相邻开场碰撞、空正文和泄漏元标签。它们可复现，但不冒充语义质量。
2. **独立模型 judge**：因果推进、人物主动性、场面完成、POV、张力、声线、钩子与 prose。它不读取引擎 critic，也不知道 A/B 映射。
3. **人工盲评**：使用同一八维 rubric；这是默认提升的必要证据，不可由模型评分替代。

失败样本进入 `tests/fixtures/quality/v1/regression-cases.json`。只有可被确定性检查表达的问题才进入该 fixture；审美特例不继续堆进 writer prompt。

## 发布阈值

`report.json` 只有同时满足下列条件才会给出 `decision=pass` 和 `releaseEligible=true`：

- provenance 必须是 `live`，corpus hash 必须匹配，96 份工件完整且正文 hash 未被篡改；
- `run.json` 的有序质量源码 manifest 必须内部完整，且聚合 fingerprint 与当前 checkout 完全一致；
- candidate 的 blocker 和 Canon conflict 都为 0；
- candidate 的确定性任务覆盖不低于 baseline，重复率不得恶化超过 0.01；
- 独立 judge 覆盖全部 48 对，总体中位提升至少 0.25；
- 因果、主动性、POV、声线、钩子五个关键维度至少三个中位提升 0.25，且任何一个不得下降超过 0.15；
- 每一对都达到规定的人工评分数，人工总体中位差不得低于 0。

缺人工评分、工件不全或来源为 fixture 时，结论都是 `hold`；不是“先默认上线再补数据”。

## 提升默认值

当且仅当真实报告为 `releaseEligible=true` 且 `promote` 已生成通过验证的 evidence bundle，代码评审才可以把 `quality-release.js` 更新为：

- `decision: "pass"`；
- `productionDefaultEnabled: true`；
- `qualitySourceFingerprint` 等于 bundle 中的当前源码 fingerprint；
- `evaluatedReport` 精确引用 run id、report/evidence/corpus/source SHA-256 与 judge/human 配对覆盖数；
- 在 changelog 记录生成模型、judge 模型、评审人数、报告 hash 和已知限制。

`npm run verify:quality-release` 会同时执行浏览器策略校验、当前 27 文件 fingerprint 计算和 bundle 引用核对；只改布尔值、复用旧报告、删字段或手写不匹配摘要都会失败。任何 corpus、prompt、上下文策略、生产模式、评分代码或核心阈值变化都会使旧报告失去默认提升资格，必须重新跑完整 A/B。回滚只需把决策记录恢复为 `hold`；历史 evidence 可继续保留，不会改写用户已有书稿或已保存偏好。
