# 异常、失败与边界情况处理记录

> 本文只记录**实际发生过的**故障与偏差，不做假设性罗列。
> 每条包含：现象 → 定位过程 → 根因 → 修复 → 可复现的验证。
>
> 记录于 2026-10-13。所有命令均在 WSL (Ubuntu 22.04) 内执行。

---

## 摘要

| # | 类别 | 现象 | 根因层级 |
|---|---|---|---|
| F1 | 科学 | 判据跨气候区失效：热浪 0 次、暴雨 0 次、寒潮 109 次 | 方法设计 |
| F2 | 科学 | DWD 单位误读，年降水算出 93–191 mm 却不报错 | 数据契约 |
| F3 | 科学 | 库存声明的年份范围与实际不符 | 数据可信度 |
| F4 | 工程 | 凭据存储拒绝工作（`CREDENTIAL_STORE_UNSAFE`） | 部署配置 |
| F5 | 工程 | 插件加载失败（`E_PACKAGE_STATE`） | 代码契约 |
| F6 | 工程 | 服务静默失效，页面打不开 | 进程生命周期 |
| F7 | 工程 | 工具返回值被信封校验拒绝（`E_ENVELOPE`） | 依赖状态 |
| F8 | 边界 | 高山站热浪 F1 = 0.000 | 物理边界 |

---

## 第一类：科学方法上的失败

### F1 判据跨气候区直接搬运，导致检测器完全失效

**现象**

早期在江苏标定的一套判据（绝对下限按江苏气候定），搬到德国哈茨山数据上跑，
结果：

```
热浪   0 次
暴雨   0 次
寒潮 109 次
```

**这不是"效果不好"，是检测器完全没有意义**——一个把所有事件都判成寒潮、
且从不报热浪暴雨的检测器，比随机猜测更差。

**定位过程**

1. 先怀疑数据：跑 `check_quality.py`，197 项 PASS / 1 WARN / **0 FAIL** → 数据没问题
2. 再怀疑代码：`selftest.mjs` 对拍 Python 参考实现 → 8/8 一致 → 代码没问题
3. 于是只剩判据本身：把江苏的下限值与德国实际气温分布对照

**根因**

江苏属亚热带季风气候，哈茨山属温带海洋性/山地气候，两者气温与降水分布
**整体平移**。江苏定的"热浪下限"在德国几乎不出现，"寒潮下限"则几乎天天满足。

**判据不能跨气候区搬运**——这不是调参问题，是方法错误。

**修复**

把判据改成三段结构，绝对下限**按区域用数据标定**，而不是用通用常数：

```
判据 = 窗口分位数（相对，自动适应本地气候）
     + 按区域标定的绝对下限（由基线期频率反推）
     + 持续天数（避免把单日波动算成事件）
```

标定目标是基线期 **0.3–1.5 次/站/年**。工具：`tools/calibrate_criteria.py`
（扫描候选下限，选出落入目标频率区间的值，并把扫描表一并写入 `event_rules.json`）。

**验证**

修复后基线期频率：热浪 0.42 / 寒潮 0.65 / 暴雨 0.68 次每站每年——都落在目标区间。

**留档价值**：这条说明我们的判据是**用数据标定出来的，不是拍脑袋定的**，
而且标定过程与扫描表都在提交物里可复查。

---

### F2 上游单位误读，算出荒谬数值却不报任何错

**现象**

DWD `kl` 日值产品的 `TXK`（日最高气温）被我按"0.1 °C 单位"除了 10。
结果：全年最高气温 3.5 °C、年降水 93–191 mm。

**代码不报错，数据不崩，程序跑得通**——直到做物理量级检查才发现。

**根因**

DWD 不同产品单位约定不一致。`kl` 日值产品的 `TXK`/`TNK`/`TMK`
**已经是 °C**，`RSK` **已经是 mm**，不需要再除 10。

**修复**

适配器改为直接取值，并**把量级检查写成硬性防线**——这条现在是
`tools/data-source-adapter.md` 里的第一号防线：

> **物理量级检查**：年降水应在 300–1500 mm 量级，日最高气温极值应在合理区间。
> 数量级错了，数值本身不会告诉你。

`check_quality.py` 固化为断言：

| 检查项 | 允许区间 |
|---|---|
| `tmax_c` | −45 … 50 |
| `tmin_c` | −50 … 45 |
| `prcp_mm` | 0 … 400 |
| 年降水合计 | 200 … 3000 mm |
| `tmax ≥ tmin` | **113,643 次比对，0 违反** |

**留档价值**：这是"沉默的错误"——最难发现的一类。教训是**适配器必须自带量级断言**，
而不是信任自己对上游的理解。

---

### F3 库存元数据声明的年份范围与实际不符

**现象**

GHCN-Daily 的站点库存索引声明某些站覆盖 2000–2024 年，
实际取数后发现中间有整整 7 年几乎是空的。

**根因**

库存索引记录的是"该站曾经报过数据"，**不等于"这些年份每天都有数据"**。

**修复**

完整度**必须逐日实测**，不能读声明。`tools/build_dataset.py` 现在按
「框选范围 ∧ 实测完整度 ≥ 98%（2000–2024）」双重条件选站，
并把**被排除的站点连同排除原因逐条打印**：

```
00722 Brocken        95.8%   排除
02039 Harzburg       72.6%   排除
02174 Herzberg       56.7%   排除
...
```

**留档价值**：选站过程可复查，不是黑箱。评委可以核对为什么是这 12 站。

---

## 第二类：工程部署上的失败

> 这一类的共同特点是：**报错信息指向不了真因**。
> 四个错误连续出现，每个都把我引向错误方向，逐个记下来。

### F4 凭据存储拒绝工作

**现象**

AGH 设置页显示：`本地凭据存储不可用，请检查本机配置。`
导致模型 key 存不进去，整个 provider 起不来。

**定位过程**

1. 先怀疑需要系统钥匙串（gnome-keyring / libsecret）→ 查源码，**不是**
2. 实际是纯文件存储（`credential-store.ts` 注释写明 "plain, atomic-per-file store, no OS keychain"）
3. 写探针直接调 `createCredentialStore`，拿到真实异常：

```
CREDENTIAL_STORE_UNSAFE: mode
enforcement = {"level":"full","mechanism":"posix-mode-owner","ownerUid":1000}
```

**根因**

`AGH_HOME` 目录权限是 `0755`，AGH 要求 **owner-only `0700`**。
它的凭据存储对目录和文件都做严格校验：

```ts
// packages/host/src/adapters/credential-files.ts
if ((Number(stat.mode) & 0o7777) !== 0o700) throw storeError(ref, 'mode')   // 目录
if ((Number(stat.mode) & 0o7777) !== 0o600) throw storeError(ref, 'mode')   // 文件
```

**修复**

```bash
chmod 700 "$AGH_HOME" "$AGH_HOME/data" "$AGH_HOME/profiles" "$AGH_HOME/cache" "$AGH_HOME/secrets"
```

**验证**：探针五个操作全通过（读空 → 写入 → 回读一致 → 删除 → 读空）。

---

### F5 插件加载失败

**现象**

`agh package enable` 失败，审计日志：

```json
{"kind":"plugin.tree.reverted","phase":"apply",
 "message":"E_ROW_TRANSACTION: row transaction failed and was compensated:
            cannot get property \"log\" without inject"}
```

**定位过程**

前两次诊断**都错了**：
- 先怀疑 `contributions` 缺后端声明 → 查官方示例 `hot-tool-plugin`，**它的 `contributions` 也是 none**，此路不通
- 再怀疑 `plugins[]` 缺 `inject` → 官方示例确实有，但补上后仍失败

最终读错误原文：`cannot get property "log" without inject` ——
**Cordis 的注入依赖**。我在 `apply(ctx)` 里写了 `ctx.log`，
但 `log` 没在 `inject` 里声明，外层插件 Context 是白名单代理，属性访问直接抛错。

对照官方示例，正确写法是 **`agnes.ctx.log`**（工具注册回调里的那个 ctx），不是外层 `ctx`。

**根因**

作用域搞错：外层 `ctx` 是白名单代理，`agnes.ctx` 才带完整能力。

**修复**

1. 改用 `agnes.ctx.log`
2. 加一层 `safeLog()`：任何异常都吞掉，**宁可少一行日志也不能让插件起不来**
3. 服务注册也单独 `try/catch` 包住——服务失败不该让六个工具一起失效

**验证**：`weatherlab-panel@0.1.0 desired=enabled actual=running trusted=true`

---

### F6 服务静默失效，页面打不开

**现象**

通过自动化工具间接启动 AGH 的 `serve`，工具一结束，页面立刻打不开。
端口没有任何监听，**也没有留下任何错误日志**。

**根因**

`serve` 是子进程，父会话结束时被回收。

**修复**

写 `start-web.sh`，用 `setsid nohup ... &` 让服务脱离会话：

```bash
setsid nohup node "$ENTRY" serve > "$LOG" 2>&1 < /dev/null &
```

并配套 `--status` / `--stop` / `--restart`，用 pidfile 管理。

**验证**：脚本退出后 `ss -tln` 仍显示 4177 在监听。

**留档价值**：部署脚本必须考虑进程生命周期，不能假定"启动了就一直活着"。

---

### F7 工具返回值被信封校验拒绝

**现象**

模型成功调用了 `wx_ingest`（审计可见 `- tool wx_ingest`），但这一轮以错误结束：

```
agnes: turn ended: error (exit 1): E_STEP_FAILED
E_ENVELOPE: Expected integer to be greater or equal to 0
```

**定位过程**

1. 脱开 AGH 单独调工具（`probe_ingest.mjs`）→ 工具 **331 ms 正常返回**，
   输出详实（12 站、913 天缺口、体检结论），形状校验 **OK**
2. 于是问题不在工具本身
3. 回溯：同一会话里 `doctor provider` 报 `no configured provider route selected`
   ——**provider 初始化没完成**
4. 修好凭据后重跑，**同一工具、同一指令，退出码 0，工具耗时 360ms**

**根因**

provider 初始化未完成时，会话轮次在收尾阶段失败，
错误码与信封校验相关，**但根因在 provider 而不在工具返回值**。

**修复**：补全凭据与 profile（见 F4 及下方 profile 三连错），无需改动工具代码。

**留档价值**：这是本次最典型的一个"误导读数"——
错误码指向信封格式，真因在上游依赖状态。**修依赖，不是改代码。**

---

## 第三类：边界情况

### F8 高山站热浪 F1 = 0.000

**现象**

`wx_backtest` 报告里，00656 / 04445 两个高山站的热浪指标：

```
F1 = 0.000   命中 0，误报 3 / 6
```

**这不是代码 bug，是真实存在的物理边界**：真值口径是 `tmax ≥ 30 °C`，
而这两站海拔 607 m / 614 m，**日最高气温几乎从不达到 30 °C**，
所以真值集合本身是空的；检测器按区域标定的 29 °C 下限出的几段，全部落空。

**处理方式：不掩盖，保留在报告里并给出地理归因**

`wx_backtest` 的输出主动列出这类站点，并说明原因；
`wx_report` 进一步**区分"判据口径差异"与"数据/代码缺陷"两类原因**，
并逐站逐类定位**第一个不一致的日期**：

```
当前可见首个不一致：
  00198  热浪  2020-09-14  检出但真值无
  00198  寒潮  2021-02-11  真值有但未检出
```

**留档价值**

一个只报告"平均 F1 = 0.728"的验证是**不诚实**的。
把最差站点（F1=0.000）和它的物理原因一起给出，才是可被检验的验证。

同类边界还有：
- 寒潮**零误报但漏报最多**（检测 −13 °C 远严于真值 −10 °C，只抓最极端寒潮）
- 暴雨在**高山站显著多于平原站**（00656 共 8 段、04445 共 11 段）——
  符合地形降水增强效应，不是异常

---

## 这些记录如何被验证

每一条都可用提交物内的脚本复现，不需要 AGH：

```bash
cd DeepBlue

# F2 / F3：数据质量与选站规则
python3 tools/check_quality.py          # 期望 197 PASS / 1 WARN / 0 FAIL
python3 tools/build_dataset.py --help   # 打印选站条件与被排除站点

# F1：判据标定与已知事件复现
python3 tools/calibrate_criteria.py     # 重跑频率扫描
python3 tools/validate_criteria.py      # 已知历史事件复现率

# F5 / F7：插件与工具（不依赖 AGH 运行）
node panel/selftest.mjs                 # 核心库 vs Python 参考实现
node panel/selftest-tools.mjs           # 六个 ToolDef 合规性 + 实调
node panel/selftest-metrics.mjs         # 面板指标服务

# F4 / F6：部署
bash start-web.sh --status              # 服务是否健在
```

AGH 内的完整六步执行记录见 `evidence/`（含 `session-export.html`）。
