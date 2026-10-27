# dsh-tok-rate · DSH 实时速率插件

> 在 DSH 会话里实时显示模型输出速率（tok/s），点开可看按「模型 + provider」分组的全局历史统计。
> 版本 **0.2.0** ｜ 归档日期 2026-10-27 ｜ 完整交付档案见 `C:\Users\HHPC\Documents\dsh\archive\dsh-tok-rate-v0.2.0-archive-2026-10-27\`

---

## 一、它能做什么

| 功能 | 说明 |
|---|---|
| 实时速率 | 输入框上方一行胶囊，生成过程中每秒刷新 6–8 次 |
| 结算真值 | 生成结束后用供应商上报的 token 数 ÷ 实际解码耗时，得到这一次请求的准确速率 |
| 历史对比 | 点胶囊上的箭头，弹出按「模型 + provider」分组的统计，跨会话累积 |
| 会话隔离 | 实时读数按会话分开，A 会话的数字不会串到 B |

**明确不做**：停顿告警、趋势曲线、表盘、成本估算、缓存命中率、RPM/TPM、OTel 导出。

---

## 二、数字怎么读（最容易混的部分）

界面上有**三处**速率数字，含义完全不同：

| 位置 | 范围 | 口径 |
|---|---|---|
| 输入框上方胶囊（本插件） | **当前会话** | 实时估算 / 最近一次请求的结算真值 |
| 点开胶囊的弹窗（本插件） | **全局**，跨所有会话 | 按 `(模型, provider)` 分组，主数字是**中位数** |
| 应用最底部小字（如 `21 轮 115 步 · 102 tok/s`） | 当前会话 | **宿主自带**的会话平均，与本插件无关 |

### 胶囊的四种状态

| 阶段 | 显示 | 含义 |
|---|---|---|
| 生成中 | `42.3 tok/s`（数字跳动） | 实时估算值，尚未拿到供应商的 token 数 |
| 刚结束（60 秒内） | `42.3 tok/s · 已结算` | 刚完成那一次请求的**真值** |
| 超过 60 秒 | 半透明 `上次 42.3 tok/s` | 保留最近一次读数供回看 |
| 长时间无请求 | 灰字 `tok/s · 待测` | 占位态 |

### 弹窗的主数字为什么是中位数

均值会被「代理攒批下发」的长尾抬高 6~23%。你的目的是对比哪个模型/链路快，中位数才不会被少数极快样本带偏。

- **中位数 < 均值是正常的**，差得越多说明长尾越重
- 主数字看中位数，副行看均值
- 两个脚注（「已排除 N 个非流式样本」/「M 个低置信样本」）是**排除清单**，两者可能有交集，**不要相加**

### 两种被排除的样本

- **非流式突发**（`timingSuspect`）：一跳到底的响应，没有可用的解码时长，不可用于比较速率
- **低置信**（`lowConfidence`）：停顿主导（空闲时间超过一半且有效跨度 <200ms），这段速率测不准

两者都**保留在账本里**（可审计），只是不参与统计。

---

## 三、装在哪里、怎么装

| 项 | 值 |
|---|---|
| 源码目录 | `C:\Users\HHPC\Documents\dsh\dsh-tok-rate\` |
| 挂载方式 | profile 里符号链接：`link:C:/Users/HHPC/Documents/dsh/dsh-tok-rate` |
| 挂载插槽 | `conversation.input.dock`，`order: 30` |
| 账本文件 | `C:\Users\HHPC\.dsh\dsh-tok-rate\ledger.json`（上限 5000 条） |
| 宿主端点 | `GET /plugins/dsh-tok-rate/live`、`GET /plugins/dsh-tok-rate/history`、`POST /plugins/dsh-tok-rate/purge` |

### 安装 / 重装

**不要用 CLI** —— `dsh plugin --profile desktop ...` 会被拒绝（桌面端 profile 由 Electron 独占管理）。

正确方式二选一：
1. GUI：侧栏 **插件 → Add plugin** → 粘贴绝对路径
2. Agent 工具：`plugin_manager(action:"install_bundle", target:"<绝对路径>")`

### 生效条件

| 改动位置 | 如何生效 |
|---|---|
| `client.js`（浏览器半） | **刷新页面即可**（宿主 HMR 会在 ≤500ms 内自动推送，无需重启） |
| `index.js`（宿主半） | **必须重启 DSH** |

---

## 四、出问题怎么办

### 重启会不会导致 DSH 起不来？

**不会。** 宿主对非必需插件有两重容错：装载期对每个 bundle 单独 try/catch 并记入 `skippedBundles`；启动期非必需条目失败只写一条 warning 就继续。`dsh-tok-rate` 不在必需清单（必需的是 agent-loop、webserver、connection 这类骨架）。

最坏情况是「插件消失」，不是「DSH 起不来」。

### 插件不见了 / 怀疑它有问题

按顺序试：

1. **插件页取消勾选**（官方入口，最快）
2. 把 `cordis.patch.yml` 改名（如 `.disabled`）—— 该插件行会被跳过
3. 从 profile 的 `dsh.profile.bundles` 与 `dependencies` 里删掉 `dsh-tok-rate`

> DSH **没有 safe mode**，不要指望用启动参数绕过。

### 恢复源码

从归档 `06-插件源码快照/` 复制回 `C:\Users\HHPC\Documents\dsh\dsh-tok-rate\`。

> ⚠️ 插件目录是 profile 符号链接的**目标**。移动或删除它会让插件消失（但不会影响 DSH 启动）。

### 清理账本

```
POST /plugins/dsh-tok-rate/purge
```

会先把命中样本归档到 `purge-archive-*.jsonl`（保留最新 10 份）再从账本移除。归档写失败时**一条都不删**。

### 账本损坏

插件会自动把坏文件改名为 `ledger.json.corrupt-<时间戳>` 保留（不覆盖），并在 `loadError` 里指明可恢复来源。滚动备份保留 2 份（`.auto-bak-1/-2`）。

---

## 五、已知限制

| # | 限制 | 影响 |
|---|---|---|
| 1 | 实时值是**字符估算**（按 `chars/token` 比例），结算后才变真值 | 生成中的数字有偏差，中位误差约 15% |
| 2 | 账本上限 5000 条，更早的样本永久淘汰 | 只保留最近的样本 |
| 3 | 账本超 5000 条后，重启前后 `chars/token` 有 ppm 级抖动 | 不影响统计口径 |
| 4 | 位置固定，不能拖动 | 位置由宿主插槽决定，`order` 只能在槽内排序 |
| 5 | 当前会话无任何请求时，胶囊上的模型名会回退显示「全局最后一次用过的模型」 | 速率为 0，不是串数据 |

---

## 六、源码结构

```
plugin/
├─ index.js          宿主半（778 行）：拦截 llm/stream 采集 usage/model/provider，维护账本，提供 HTTP 路由
├─ client.js         浏览器半（671 行）：注册插槽、渲染胶囊与弹窗、实时估算与轮询
├─ package.json      清单：dsh.bundle.patch + dsh.client
├─ cordis.patch.yml  装载补丁：把插件插进 profile 插件层
├─ locale/zh.json    中文标题与描述
├─ locale/en.json    英文标题与描述
└─ icon.svg           图标
```

**关键设计**：
- **混合架构** —— `usage` / `model` / `provider` 三者只有宿主侧有，所以采集在宿主；渲染在浏览器
- **零构建链** —— 手写普通 JS，形态 `window.__ModuleLoader__.load({id, factory})`，不需要打包器
- **不碰官方 UI** —— 不用 DOM 注入，纯插槽注册

---

## 七、验收结论

- 插件代码层 **0 条真缺陷**（最终独立验收裁定）
- 独立验收 harness：**158 通过 / 0 失败**
- 自测：165 / 110 / 68 / 20 / 9 checks 全绿
- `client.js` 引用的 16 个 CSS 变量在宿主 asar 中 **16/16 真实存在**
- 全链路铁律 12/12 遵守（无 `engines.dsh`、无 `@deepseek-ai/dsh*` 依赖、只 `require('react')`、`getSnapshot` 返回 primitive 等）
