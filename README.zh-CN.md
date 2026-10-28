# DeepBlue

[English](README.md) | [中文](README.zh-CN.md)

**给 Agnes 智能体加装的气象极端天气检测插件，运行于 AGH（Agnes Harness）。**

DeepBlue 把「读站点气象数据 → 算基线阈值 → 检测极端事件 → 与实测比对 → 出报告」这一完整科研流程，封装成 **AGH 六个原生工具**，由智能体（ReAct 循环，`agnes-3.0-flash`）自主规划、调用、反思，端到端完成，且数据集完全公开、免登录、任何人可复现。

- **参赛赛事**：2026 江苏省 AI+科学与工程创新实践黑客松（高校组）· 主赛道 B · 方向 B4「科研 Agent 与 Harness 工程」
- **团队成员**：朱梦凡（数据与算法）· 李睿阳（AGH 集成与工程）· 王冰冰（验收测试与交付）
- **开源协议**：MIT

---

## 1. 项目介绍（Project Overview）

### 1.1 项目背景

极端天气（热浪、寒潮、暴雨）检测传统上需要人工串联多步：获取并理解专业气象数据格式 → 按站点历史算合理阈值 → 滑动窗口检测 → 与独立真值比对 → 写报告。耗时、易错，且两个人很难得到一致结果。DeepBlue 把整条流程沉淀为智能体可自主驱动的工具链，同时保证**数据公开、判据可标定、结果可复核**。

### 1.2 核心功能

| # | 工具 | 作用 | 实测耗时 |
|---|---|---|---|
| 1 | `wx_ingest` | 数据体检：完整度、缺口、量级断言 | 503 ms |
| 2 | `wx_clean` | 缺失分布与插补标记（**只标记、不插补**） | 430 ms |
| 3 | `wx_thresholds` | 基线期阈值计算 | 950 ms |
| 4 | `wx_detect` | 测试期极端事件检测 | 1.0 s |
| 5 | `wx_backtest` | 与独立真值比对：命中率 / 误报率 / F1 | 1.1 s |
| 6 | `wx_report` | 完整报告生成 | 1.2 s |

三类事件采用**三段式判据**（窗口分位数 → 绝对下限 → 持续天数），其中绝对下限**按区域用数据标定**，不是通用常数：

| 事件 | 判据 | 持续 |
|---|---|---|
| 热浪 | `tmax ≥ P90(年内第几天 ±15 天窗口)` 且 `tmax ≥ 29 °C` | 连续 ≥3 天 |
| 寒潮 | `tmin ≤ P10(年内第几天 ±15 天窗口)` 且 `tmin ≤ −13 °C` | 连续 ≥3 天 |
| 暴雨 | 3 天累计降水 `≥ 57 mm` | 相邻命中合并 |

**数据集**：DWD（德国气象局气候数据中心）开放日值站点数据，目录直列、**无需账号、无需申请、无需实名**。德国哈茨山及前麓 12 站（51–52°N, 10–12°E），海拔 85–614 m，数据跨度 2000-01-01 – 2025-12-31，站点完整度 98.1%–100%。站点由可复现规则选出（落在区域内且 2000–2024 年 tmax 与降水同时存在的完整度 ≥98%），不是手挑的。

### 1.3 关键结果（测试期 2020–2025）

| 指标 | 数值 |
|---|---|
| 检出热浪 | **81 次** |
| 检出寒潮 | **20 次** |
| 检出暴雨 | **55 次** |
| 对独立真值命中率 | **65.8%** |
| 误报率 | **18.5%** |
| F1 值 | **0.728** |
| 物理一致性校验（`tmax ≥ tmin`、`tmin ≤ tavg ≤ tmax` 等） | 约 11.4 万站-日 **0 违反**；197 PASS / 1 WARN / 0 FAIL |

冻结后的判据能复现已知历史事件——例如 2012-02-06 寒潮、2018-08-09 热浪均命中 **12/12 站**。部分命中（如 6/12）如实保留：它对应各次事件中心与哈茨山区的距离，而不是把判据调松到"全中"。

### 1.4 创新亮点

1. **判据用数据标定，不是拍脑袋**：三段结构 + 频率扫描，扫描表随 `dataset/event_rules.json` 冻结，可用 `tools/calibrate_criteria.py --sweep` 逐项复查。
2. **数据与处理彻底解耦**：适配器层把任意数据源规范化为统一契约；六个工具代码里**没有一处判断数据来源或地区**。换数据源只改一个 `manifest.json`，工具代码零改动。
3. **智能体端到端自主科研**：从读数据到出报告全链路由 ReAct 循环驱动，人类只负责验证。
4. **完整可复现**：数据公开免登录、构建脚本幂等、运行证据与判据标定表全部随包交付。
5. **诚实报告物理边界**：海拔 600 m+ 的高山站几乎到不了 30 °C，热浪 F1 为 0 是物理使然，如实记录而不掩盖。

---

## 2. 视频介绍（Demo Video）

▶ [观看演示视频（28 MB）](https://github.com/bing-1222/deep-blue/releases/download/v1.0.0/demo.mp4)


无需上传即可随仓库查看的运行证据：

- `evidence/session-export.html` —— 六步工具链端到端智能体会话导出
- `evidence/1-ingest.out … 6-report.out` —— 逐工具运行日志
- `evidence/session-transcript.txt` —— 完整智能体逐字稿

---

## 3. 架构介绍（Architecture）

```
┌────────────────────────────────────────────────────────────┐
│  Agnes 智能体（agnes-3.0-flash，ReAct 循环）                │
│  规划 → 调用工具 → 观察结果 → 反思 → 继续                  │
└──────────────┬─────────────────────────────────────────────┘
               │ AGH 扩展 API（工具注册 / 调度 / 审计）
┌──────────────▼─────────────────────────────────────────────┐
│  weatherlab-panel 插件（AGH 前端插件）                       │
│   wx_ingest · wx_clean · wx_thresholds · wx_detect ·        │
│   wx_backtest · wx_report                                   │
└──────────────┬─────────────────────────────────────────────┘
               │ 统一数据契约（station_id/date/tmax_c/...）
┌──────────────▼─────────────────────────────────────────────┐
│  数据适配器层（DWD 开放数据 → 规范化契约）                  │
│  数据集：哈茨山区 12 站，2000–2025                         │
└─────────────────────────────────────────────────────────────┘
```

**核心设计**：取数（适配器）与处理（六个工具）彻底分离。工具只读统一契约，代码中不含任何按数据源/地区的分支。新增数据源 → 写一个输出契约的适配器 → 在 `manifest.json` 注册即可。

核心模块：

- `panel/extensions/main/tools/*.mjs` —— 六个工具，都是基于契约的纯函数
- `panel/extensions/main/core.mjs` · `metrics.mjs` —— 阈值计算、滑动窗口检测、回测指标
- `panel/extensions/main/index.mjs` —— AGH 后端入口；`agnes.client.json` 声明槽位/样式/配置；`client/index.js` 是零构建前端面板（改顶部 `CONFIG` 后刷新页面即可）
- `tools/*.py` —— 离线流水线：`build_dataset.py`（下载 DWD → 生成 `dataset/`，冻结 sha256）、`check_quality.py`（硬质量门）、`calibrate_criteria.py`、`validate_criteria.py`（已知事件复现检验）

---

## 4. 集成标准（Integration Standards）

### 4.1 插件打包（AGH）

插件按标准 AGH 面板包分发，前端零构建：

```bash
agh package inspect file:./deepblue/panel
agh install file:./deepblue/panel
agh package trust weatherlab-panel <integrity> <capabilityHash>
agh package enable weatherlab-panel
agh package status
```

数据集查找顺序：环境变量 `AURORA_DATA_ROOT` / `WX_DATA_ROOT` → 插件包内 → 包上一级 → 当前工作目录；工具也支持 `dataRoot` 参数直接指定。

### 4.2 统一数据契约

这是适配器的输出，也是六个工具唯一的输入：

| 字段 | 含义 |
|---|---|
| `station_id` | 站号（字符串） |
| `date` | `YYYY-MM-DD` |
| `year` `month` `day` `doy` | 拆分字段，`doy` = 年内第几天 1–366 |
| `tmax_c` | 日最高气温 °C |
| `tmin_c` | 日最低气温 °C |
| `prcp_mm` | 日降水总量 mm |
| `qc_flag` | 上游质控等级或标志 |
| `interpolated` | 是否为插补值 |
| `complete_core` | 当日核心变量是否齐全 |
| `source` `source_version` | 数据来源与版本（可追溯） |

**下游工具不得读取上游原始格式的任何字段**——这条是换源能力的前提。

### 4.3 集成规则

- 清洗策略为**只标记不插补**：插补会伪造极端事件，因此缺测只标记、绝不自动填充。
- 每个工具返回统一信封并做 schema 校验，智能体与人类都可共同复核。
- 所有调用在 `$AGH_HOME/data/audit/host.jsonl` 留审计日志（参数 + 结果）。
- 新增数据源遵循 `tools/data-source-adapter.md`：实现适配器 → 输出契约 → 在 `dataset/manifest.json` 注册并附 sha256，工具代码零改动。

---

## 5. 快速开始

> AGH 集成部分**仅保证 Linux**（已验证 Ubuntu 22.04 + Node 24.16）。Windows 用户请使用 **WSL**。

```bash
bash setup.sh        # 装编译工具链 + Node 24 + pnpm（幂等）
bash bootstrap.sh    # 从源码构建 AGH + 安装并启用本插件（幂等）

# 复现数据集（无需凭据，需能访问 opendata.dwd.de）
python3 tools/build_dataset.py
python3 tools/check_quality.py       # 期望 FAIL=0
python3 tools/calibrate_criteria.py
python3 tools/validate_criteria.py

# 不依赖 AGH 的插件自测
cd panel
node selftest.mjs
node selftest-tools.mjs

# 启动 Web 界面
bash start-web.sh    # http://127.0.0.1:4177/
```

## 6. 目录结构

```
DeepBlue/
├── README.md / README.zh-CN.md
├── panel/                  AGH 前端插件（零构建）
│   ├── package.json         AGH 插件清单
│   ├── extensions/main/     后端入口、客户端声明、tools/、core/metrics
│   └── selftest*.mjs
├── tools/                   离线 Python 流水线 + 换源文档
├── dataset/                 12 站 × 逐日 CSV、manifest.json、冻结的 event_rules.json
└── evidence/                导出的会话、逐工具日志、逐字稿
```

## 7. 开源协议

[MIT](LICENSE) © 2026 DeepBlue 团队。DWD 开放数据可自由使用与再分发；本项目不含任何个人信息。
