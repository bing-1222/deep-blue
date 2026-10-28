# DeepBlue 测试交付说明

> **给队员看的操作手册（先看这份）。**
> 目标：让你在一台**全新的 WSL** 上把这套东西跑起来，并验证结果。
>
> 维护者：项目负责人　·　更新：2026-10-13
>
> 📄 另外两份文档的分工：
> - `README.md` —— 提交物说明（评委视角，讲方法论与数据来源）
> - `FAILURES.md` —— 异常/失败/边界处理记录（8 个真实案例）

---

## 目录

- [一、这是什么](#一这是什么)
- [二、环境要求](#二环境要求)
- [三、快速验证（5 分钟，不装 AGH）](#三快速验证5-分钟不装-agh)
- [四、完整环境搭建](#四完整环境搭建)
- [五、配置 AGH（重点）](#五配置-agh重点)
- [六、跑起来](#六跑起来)
- [七、测试清单](#七测试清单)
- [八、常见问题](#八常见问题)
- [九、文件说明](#九文件说明)

---

## 一、这是什么

给 **AGH（Agnes Harness）** 加装的气象插件，用极端天气检测验证。

六个工具串成一条链：

```
wx_ingest  →  wx_clean  →  wx_thresholds  →  wx_detect  →  wx_backtest  →  wx_report
 数据体检      清洗标记      基线期阈值        执行检测      与真值比对      出报告
```

数据来自 **DWD（德国气象局）开放数据**，免登录、免申请。
研究区域是德国哈茨山及前麓，12 个站，2000–2025 年。

> ⚠️ **只保证 Linux。** Windows 上跑不了（系统会把 PowerShell 锁进
> ConstrainedLanguage 模式，AGH 的 PowerShell 适配器用不了）。
> **全部工作在 WSL 里做。**

---

## 二、环境要求

| 项目 | 要求 | 怎么查 |
|---|---|---|
| 系统 | WSL2 / Ubuntu 22.04 | `lsb_release -a` |
| Node.js | **≥ 24.10** | `node -v` |
| pnpm | 10.x | `pnpm -v` |
| 编译工具链 | gcc / g++ / make / python3 | `gcc --version` |
| 磁盘 | 约 2 GB（AGH 源码 + 依赖） | `df -h ~` |
| 网络 | 能到 `opendata.dwd.de` 与 `api.agnes-ai.cn` | 下面有测试命令 |

**先确认你在 WSL 里**（不是 Windows PowerShell）：

```bash
uname -a          # 应出现 microsoft-standard-WSL2
```

网络连通性：

```bash
curl -s -o /dev/null -w 'DWD   %{http_code}\n' https://opendata.dwd.de/climate_environment/CDC/
curl -s -o /dev/null -w 'Agnes %{http_code}\n' https://api.agnes-ai.cn/v1/models
```

---

## 三、快速验证（5 分钟，不装 AGH）

**如果你只想确认代码是好的，跳过第四、五节，直接做这个。**

```bash
cd /mnt/d/User/Users/Desktop/DeepBlue-测试交付

# 1) 数据质量校验
python3 tools/check_quality.py
#    期望：197 PASS / 1 WARN / 0 FAIL

# 2) 核心库自测（与 Python 参考实现对拍）
node panel/selftest.mjs
#    期望：8/8 已知事件一致

# 3) 六个工具定义合规性 + 实际调用
node panel/selftest-tools.mjs
#    期望：TOOLS-SELFTEST PASS

# 4) 面板指标服务
node panel/selftest-metrics.mjs
#    期望：METRICS-SELFTEST PASS（17 项）
```

**做完这四步，你已经验证了：数据是干净的、代码是对的、六个工具都能跑。**
这一步**不需要 AGH、不需要模型 key**。

> 若 `node` 找不到：`export PATH="$HOME/.local/node/bin:$PATH"`

---

## 四、完整环境搭建

### 4.1 装系统依赖

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 curl tar xz-utils
```

> `build-essential` 是必需的——AGH 有一个原生构件必须现场编译。

### 4.2 装 Node.js 24

```bash
NODE_VER=24.16.0
mkdir -p ~/.local/node
cd /tmp
curl -fsSL -O https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz
tar -xJf node-v${NODE_VER}-linux-x64.tar.xz
cp -a node-v${NODE_VER}-linux-x64/. ~/.local/node/
rm -rf node-v${NODE_VER}-linux-x64*

# 写进 profile.d（不要写 .bashrc，原因见 4.3）
echo 'export PATH="$HOME/.local/node/bin:$PATH"' | sudo tee /etc/profile.d/node.sh
```

### 4.3 ⚠️ PATH 的坑（重要）

**`~/.local/node/bin` 默认不在 PATH 里，而且写进 `~/.bashrc` 对脚本无效**——
非交互 shell 加载 `.profile` 时会提前返回，根本不读 `.bashrc`。

**所以：每个脚本开头都要显式加这一行**，别指望环境自动带上：

```bash
export PATH="$HOME/.local/node/bin:$PATH"
```

验证：

```bash
bash -lc 'node -v'    # 应输出 v24.16.0
```

### 4.4 装 pnpm

```bash
npm config set registry https://registry.npmmirror.com
npm install -g pnpm
pnpm -v    # 期望 10.x
```

### 4.5 一键脚本（省事）

交付包里有两个幂等脚本，重复执行安全：

```bash
cd /mnt/d/User/Users/Desktop/DeepBlue-测试交付
bash setup.sh        # 装依赖（等价于 4.1–4.4）
bash bootstrap.sh    # 构建 AGH + 装插件（等价于第五节）
```

**只想跑通的话，这两条就够了。** 下面第五节讲它背后做了什么，
以及**出问题时怎么手动排查**。

---

## 五、配置 AGH（重点）

> 这一节最容易卡住。**四个错误会连环出现，每个的报错都指向不了真因。**
> 按顺序做，别跳步。

### 5.1 准备 AGH 源码

把 AGH 源码 zip 放到 WSL 能读到的地方，然后：

```bash
export PATH="$HOME/.local/node/bin:$PATH"
export AGH_WORK="$HOME/agh-clean"
mkdir -p "$AGH_WORK"

# 用 python 解压（比 unzip 稳）
python3 - "$AGH_ZIP" "$AGH_WORK" <<'PY'
import os, sys, zipfile
z = zipfile.ZipFile(sys.argv[1]); root = sys.argv[2]
z.extractall(root)
inner = os.path.join(root, "agnes-harness-main")
if os.path.isdir(inner):
    for n in os.listdir(inner):
        os.rename(os.path.join(inner, n), os.path.join(root, n))
    os.rmdir(inner)
print("解压完成")
PY

cd "$AGH_WORK"
pnpm install
pnpm --filter @agnes/cli build:local
pnpm --filter @agnes/system-node build:native
```

验证构建成功：

```bash
ls -l packages/cli/dist/local/agnes.mjs
# 应存在，约 16 MB

ls -l packages/system-node/dist/native/agnes.system.node 2>/dev/null \
  || ls -l packages/system-node/dist/native/
# 应存在，约 22 KB
```

### 5.2 ⚠️ 配置 AGH_HOME（三个坑都在这）

> ✅ **已更新（2026-10-14）：本交付包内的 `bootstrap.sh` 已自动写入「完整版 profile.yaml」**
> （含 `provider.routes`、`seams`、`adapters`、`contract_id: null`，路径用 `$AGH_HOME` 变量）。
> 直接跑 `bash bootstrap.sh` 即可，无需手动补全。以下内容保留供**手动排查 / 改配置**时参考。

```bash
export AGH_HOME="$HOME/agh-deepblue-home"
mkdir -p "$AGH_HOME"/{data,cache,secrets}
mkdir -p "$AGH_HOME/profiles/local-dev"
```

#### 坑 1：目录权限必须是 0700

**不设会报：`本地凭据存储不可用，请检查本机配置。`**

AGH 的凭据存储对权限做严格校验，目录要 `0700`、文件要 `0600`：

```bash
chmod 700 "$AGH_HOME"
chmod 700 "$AGH_HOME/data" "$AGH_HOME/cache" "$AGH_HOME/secrets" "$AGH_HOME/profiles"
```

> 顺带说明：AGH 用的是**纯文件存储**，不需要 gnome-keyring / libsecret。

#### 坑 2：profile.yaml 必须写全

**不写全会报：`E_PRESET_UNRESOLVED: no-routes`**

把下面内容存成 `$AGH_HOME/profiles/local-dev/profile.yaml`：

```yaml
name: local-dev
schemaVersion: 1

packages:
  - { id: "@agnes/ai", source: "builtin" }
  - { id: "@agnes/base", source: "builtin" }
  - { id: "@agnes/code", source: "builtin" }

seams:
  approval: "@agnes/base"
  checkpoint: "@agnes/base"
  ledger: "@agnes/base"
  sandbox: "@agnes/base"
  verifier: "@agnes/base"
  repair: "@agnes/base"
  artifacts: "@agnes/base"
  principals: "@agnes/base"
  platform: "@agnes/host"
  harness: "@agnes/base"

provider:
  package: "@agnes/ai"
  adapters: ["@agnes/ai"]
  routes:
    - route: agnes-ai
      api: openai-completions
      baseUrl: "https://api.agnes-ai.cn/v1"
      credentialRef: "secret://agnes-ai/default"
      models:
        - id: agnes-3.0-flash
          name: Agnes 3.0 Flash
          api: openai-completions
          route: agnes-ai
          baseUrl: "https://api.agnes-ai.cn/v1"
          reasoning: false
          input: [text, image]
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          contextWindow: 200000
          maxTokens: 65536
          toolCallFormats: [native]
          thinkingReplay: native
          contract_id: null          # ← 漏了会报 "model contract is not loaded"

adapters:
  storage: sqlite
  fs: local
  exec: local
  platform: host
  # ← 漏了 path 会报 E_SEAM_INIT: SECRET_UNRESOLVED
  secrets: { kind: file, path: /home/你的用户名/agh-deepblue-home/secrets }

transports: [{ kind: stdio }]

# ⚠️ 用绝对路径！profile 里的 ~ 会被展开成 AGNES_HOME 而不是系统 HOME，
#    写 ~/agh-deepblue-home/data 会变成 .../agh-deepblue-home/agh-deepblue-home/data
dataDir: /home/你的用户名/agh-deepblue-home/data
cacheDir: /home/你的用户名/agh-deepblue-home/cache

limits: { "jobs.tick_ms": 1000, "shutdown.grace_ms": 10000 }
presets: { default: standard, allowed: [standard] }

policy:
  capabilityCeiling:
    - tools
    - hooks
    - slots
    - events
    - resources
    - ui
    - services              # ← 面板的服务调用需要这一项
    - network
    - network.publicRead
    - tools.invoke
    - artifacts
    - subagent
  workspacePackages: require-project-trust

computerUse:
  enabled: false
```

**把「你的用户名」换成实际值**：

```bash
sed -i "s|你的用户名|$USER|g" "$AGH_HOME/profiles/local-dev/profile.yaml"
chmod 600 "$AGH_HOME/profiles/local-dev/profile.yaml"
```

验证 profile 能解析：

```bash
cd "$AGH_WORK"
export AGH_HOME AGNES_PROFILE=local-dev
node packages/cli/dist/local/agnes.mjs doctor profile
# 期望：显示 packages / dataDir / cacheDir，退出码 0
```

#### 坑 3：模型 key 要单独存

**key 不存在 profile.yaml 里**，由 AGH 的凭据存储单独保管。

写 key（把 `你的KEY` 换成比赛专用 key）：

```bash
cd "$AGH_WORK"
export AGH_HOME

cat > /tmp/putcred.mjs <<'EOF'
import { createCredentialStore } from './packages/host/src/adapters/credential-store.ts'
const store = createCredentialStore({ root: process.env.AGH_HOME })
await store.putApiKey('secret://agnes-ai/default', process.env.MY_KEY)
const back = await store.read('secret://agnes-ai/default')
console.log('写入:', back ? `ok len=${String(back.value).length}` : 'NULL')
EOF

MY_KEY='你的KEY' node --import tsx /tmp/putcred.mjs
rm -f /tmp/putcred.mjs
```

**测 key 是否有效**（只打印状态码，不回显 key）：

```bash
cd "$AGH_WORK"
node --import tsx -e "
import { createCredentialStore } from './packages/host/src/adapters/credential-store.ts'
const s = createCredentialStore({ root: process.env.AGH_HOME })
const c = await s.read('secret://agnes-ai/default')
const r = await fetch('https://api.agnes-ai.cn/v1/models', { headers: { Authorization: 'Bearer ' + c.value } })
console.log('HTTP', r.status)
if (r.ok) console.log('模型:', (await r.json()).data.map(m => m.id).join(', '))
"
# 期望：HTTP 200，模型: agnes-3.0-flash
```

> 🔒 **别把 key 写进任何提交文件、别贴群里、别截图。**
> 官方也强调：完整密钥通常只在创建时显示一次，泄露了就删掉重建。

### 5.3 安装插件

```bash
cd "$AGH_WORK"
export AGH_HOME AGNES_PROFILE=local-dev
export PATH="$HOME/.local/node/bin:$PATH"

# 把插件复制到 AGH 工作区
mkdir -p "$AGH_WORK/deepblue"
cp -r /mnt/d/User/Users/Desktop/DeepBlue-测试交付/. "$AGH_WORK/deepblue/"

# 启动 daemon
node packages/cli/dist/local/agnes.mjs daemon start

# 安装（inspect → install → trust → enable）
node packages/cli/dist/local/agnes.mjs package inspect file:./deepblue/panel
node packages/cli/dist/local/agnes.mjs package add     file:./deepblue/panel
node packages/cli/dist/local/agnes.mjs package enable  weatherlab-panel
```

> `package add` 会要求交互确认。**非交互环境（脚本里）会直接返回
> "Installation cancelled"**，那种情况下用 Node SDK 的
> `client.packages.install/trust/enable` 并轮询
> `client.packages.operation.get` 直到 `completed`。

验证：

```bash
node packages/cli/dist/local/agnes.mjs package status
# 期望看到：
# weatherlab-panel@0.1.0  desired=enabled  actual=running  trusted=true
```

### 5.4 判断"装没装上"的正确方法

**别只看 `contributions`。** 官方示例 `hot-tool-plugin` 的 `contributions` 也是 `none`——
它只反映前端贡献。

看审计日志才是准的：

```bash
grep -o '"name":"wx_[a-z]*"' "$AGH_HOME/data/audit/host.jsonl" | sort -u
# 期望输出六个：
# wx_ingest / wx_clean / wx_thresholds / wx_detect / wx_backtest / wx_report
```

---

## 六、跑起来

### 6.1 启动 Web 界面

```bash
cd "$AGH_WORK"
bash start-web.sh            # 启动
bash start-web.sh --status   # 查看状态
bash start-web.sh --stop     # 停止
bash start-web.sh --restart  # 重启
```

浏览器打开 **http://127.0.0.1:4177/**

> **为什么必须用这个脚本**：它用 `setsid` 让服务脱离父进程。
> 如果通过别的程序间接启动，那个程序一结束服务就被回收、页面立刻打不开。
> 这是实际踩过的坑。

### 6.2 让模型调用工具（命令行）

> ⚠️ **实测提醒（2026-10-14）：CLI 命令行（`agnes.mjs -p ...`）在部分 AGH 版本上不稳定，
> 会卡住无输出（standalone 还不带插件）。推荐直接用 Web 界面（见 6.4）发起对话跑工具链，
> 稳定且能直观看到 Conversation / Trace。**

```bash
cd "$AGH_WORK"
export AGH_HOME AGNES_PROFILE=local-dev
export AURORA_DATA_ROOT="$AGH_WORK/deepblue/dataset"
export PATH="$HOME/.local/node/bin:$PATH"

node packages/cli/dist/local/agnes.mjs -p "调用 wx_ingest 检查数据集完整性。" --mode text
```

**期望输出**：

```
- tool wx_ingest
- tool wx_ingest · ok · 360ms
结论：数据集（deepblue-harz-daily，12 站，2000–2025）整体完整度 98%–100%，
但共存在 913 天的缺口……
```

### 6.3 完整六步链

```bash
cd "$AGH_WORK"
export AGH_HOME AGNES_PROFILE=local-dev
export AURORA_DATA_ROOT="$AGH_WORK/deepblue/dataset"

for p in \
  "调用 wx_ingest 检查数据集完整性。" \
  "调用 wx_clean 查看缺失分布与插补标记。" \
  "调用 wx_thresholds 计算基线期阈值。" \
  "调用 wx_detect 在评估期执行检测。" \
  "调用 wx_backtest 与独立真值比对，报告命中率。" \
  "调用 wx_report 生成完整报告。" ; do
  echo "=== $p ==="
  node packages/cli/dist/local/agnes.mjs -p "$p" --mode text
  echo
done
```

### 6.4 看前端面板

浏览器打开 **http://127.0.0.1:4177/** 后：

1. **先发起一次对话**（左边的聊天框随便说句话）
   —— 面板的服务调用**绑定会话**，没有活动会话时会提示"先打开一个会话"
2. 侧边栏应出现 **「极端天气监测」** 面板
3. 内容应有：监测范围、数据质量、识别结果（含逐年分布图）、准确性、判定依据、历史回验

> ✅ **实测确认（2026-10-14）**：在 Web 会话中发起"调用 wx_ingest 检查数据集完整性"，模型 24s
> 返回 12 站完整体检；再发"依次调用 wx_clean→wx_thresholds→wx_detect→wx_backtest→wx_report"，
> 五个工具依次调用全部成功（5/5 todo 完成），Conversation 与 Trace 均完整渲染。

### 6.5 推荐跑法（实测稳定的方式）

1. `bash start-web.sh` 启动，浏览器开 **http://127.0.0.1:4177/**
2. 左侧聊天框发一句话：`调用 wx_ingest 检查数据集完整性。`
3. 再发一条：`请依次调用 wx_clean 查看缺失分布，wx_thresholds 计算基线期阈值，wx_detect 在测试期执行检测，wx_backtest 与真值比对，最后 wx_report 生成完整报告。`
4. 在 **Conversation** 看结论、在 **Trace** 看六个工具的完整调用链（含耗时）。

> 这就是本次实测六步链跑通的完整过程，可直接作为演示/运行证据。生成的 `session-export.html` 在
> `evidence/` 目录。

---

## 七、测试清单

请按这个表逐项确认，**把实际结果填在最后一列**。

| # | 测试项 | 命令 / 操作 | 期望结果 | 实际 |
|---|---|---|---|---|
| 1 | 数据质量 | `python3 tools/check_quality.py` | 197 PASS / 1 WARN / **0 FAIL** | |
| 2 | 核心库 | `node panel/selftest.mjs` | 8/8 已知事件一致 | |
| 3 | 工具定义 | `node panel/selftest-tools.mjs` | TOOLS-SELFTEST PASS | |
| 4 | 指标服务 | `node panel/selftest-metrics.mjs` | 17 项全过 | |
| 5 | profile 解析 | `node …/agnes.mjs doctor profile` | 退出码 0 | |
| 6 | key 有效性 | 5.2 节测 key 命令 | HTTP 200，agnes-3.0-flash | |
| 7 | 插件状态 | `node …/agnes.mjs package status` | `actual=running trusted=true` | |
| 8 | 工具注册 | `grep` 审计日志 | 六个 `wx_*` 全在 | |
| 9 | 单工具调用 | 6.2 节命令 | 退出码 0，`- tool wx_ingest · ok` | |
| 10 | 六步链 | 6.3 节循环 | 六步全成功 | |
| 11 | Web 可达 | 浏览器开 4177 | 页面正常 | |
| 12 | 面板渲染 | 先发起对话再看侧边栏 | 出现「极端天气监测」 | |

### 数值一致性核对

面板上的数字应与工具链输出一致（都来自同一份 `dataset/event_rules.json`）：

| 指标 | 应为 |
|---|---|
| 检出 热浪 / 寒潮 / 暴雨 | **81 / 20 / 55** |
| 命中率 / 误报率 / F1 | **65.8% / 18.5% / 0.728** |
| 窗口样本 min–max | **383 – 407** |
| 判据下限 热浪 / 寒潮 / 暴雨 | **29 °C / −13 °C / 57 mm** |
| 站点数 / 年限 | **12 / 2000–2025** |

### 边界与失败用例（已知的，不是 bug）

| 情形 | 现象 | 说明 |
|---|---|---|
| 高山站热浪 | 00656 / 04445 的 **F1 = 0.000** | 海拔 607/614 m，日最高气温几乎从不达 30 °C，真值集合本身是空的 |
| 寒潮 | **零误报但漏报最多** | 检测下限 −13 °C 远严于真值 −10 °C，只抓最极端寒潮 |
| 暴雨分布 | 高山站显著多于平原站 | 地形降水增强效应，符合预期 |
| 03821 / 05490 两站 | 2000–2002 年缺测偏多 | 已如实报告，未插补掩盖 |
| 无活动会话时开面板 | 提示"先打开一个会话" | **这是设计，不是故障** |

---

## 八、常见问题

### Q1 报 `本地凭据存储不可用`

目录权限不对：

```bash
chmod 700 "$AGH_HOME" "$AGH_HOME"/{data,cache,secrets,profiles}
```

### Q2 报 `E_PRESET_UNRESOLVED: no-routes`

`profile.yaml` 缺 `packages` / `seams` / `provider` 块。照 5.2 节完整抄。

### Q3 报 `E_SEAM_INIT: SECRET_UNRESOLVED`

`adapters.secrets` 缺 `path`，或路径末段不是 `secrets`：

```yaml
secrets: { kind: file, path: /home/你的用户名/agh-deepblue-home/secrets }
```

### Q4 报 `model contract is not loaded`

model 条目漏了 `contract_id: null`。**必须是 `null`，不能省略**——
省略会变成 `undefined`，判定逻辑走另一条分支。

### Q5 所有插件都是 `actual=starting`

**不是插件的问题。** daemon 的 provider 初始化失败会让整个宿主停在启动阶段，
连 AGH 自带的内置包也是 `starting`。

```bash
grep 'startup.failed' "$AGH_HOME/data/audit/host.jsonl" | tail -3
```

有 `startup.failed` 就先修启动（通常是 Q1–Q4），别去查插件。

### Q6 页面打不开 / 突然打不开

```bash
bash start-web.sh --status     # 看端口和 HTTP
bash start-web.sh --restart    # 重起
```

用 `start-web.sh` 起，不要用别的方式（会被回收）。

### Q7 面板显示"数据不可用：…"

浏览器按 `F12` 开控制台，找 `[WeatherLab]` 开头的警告，里面有完整错误。把那段发我。

### Q8 面板显示"先打开一个会话"

**正常。** 面板的服务调用绑定会话，**先在左边发起一次对话**，面板就会自动加载。

### Q9 报 `cannot get property "log" without inject`

如果你改代码时在 `apply(ctx)` 里用了 `ctx.log`——外层 `ctx` 是白名单代理，
要用 `agnes.ctx.log`。（交付的代码已经修好了，这条供你改代码时参考。）

### Q10 `package add` 返回 "Installation cancelled"

非交互环境没有 TTY。改用 Node SDK 的 `client.packages.*` 并轮询
`client.packages.operation.get`。

### Q11 CLI 命令行卡住无输出（`agnes.mjs -p ...` 超时）

**实测遇到的情况**：命令行方式可能长时间无输出、`timeout` 后被杀（exit=124），
但插件状态是 `running`、`doctor provider --probe` 也通过。

**处理**：
1. 先确认不是配置问题：`doctor provider --probe` 能过 → 配置没问题；
2. 是 CLI 会话连接方式不稳定，**改用 Web 界面**（6.4 / 6.5）发起对话跑工具链，稳定且带 Trace。
3. 若 CLI 单独跑 `agnes.mjs -p` 需要带插件，用 `--standalone` 需要确认工作区已装配已启用的插件；
   实测 standalone 只加载内置扩展（12 个），不带 weatherlab-panel。

> 结论：日常跑直接用 Web 界面，别用命令行。

---

## 九、文件说明

```
DeepBlue-测试交付/
├── ReadMe-测试交付.md     ★ 本文件（配置与操作）
├── README.md                提交物说明（评委视角，含方法论）
├── FAILURES.md            ★ 异常/失败/边界处理记录（8 个真实案例）
├── setup.sh                 环境准备（幂等）
├── bootstrap.sh             构建 AGH + 装插件（幂等）
├── start-web.sh           ★ Web 启停脚本（独立存活）
│
├── panel/                   AGH 插件
│   ├── package.json
│   ├── index.mjs
│   ├── selftest.mjs             核心库自测
│   ├── selftest-tools.mjs       六工具自测
│   ├── selftest-metrics.mjs     指标服务自测
│   └── extensions/main/
│       ├── index.mjs            后端入口（六个工具 + 面板服务）
│       ├── core.mjs             核心库（纯函数，零依赖）
│       ├── metrics.mjs          面板指标计算
│       ├── agnes.client.json    前端声明（slots / services）
│       ├── client/              前端面板（零构建步骤）
│       │   ├── index.js
│       │   └── index.css
│       └── tools/               六个工具
│           ├── schema.mjs       TypeBox 兼容 schema 构造器
│           ├── ingest.mjs       wx_ingest
│           ├── clean.mjs        wx_clean
│           ├── thresholds.mjs   wx_thresholds
│           ├── detect.mjs       wx_detect
│           ├── backtest.mjs     wx_backtest
│           └── report.mjs       wx_report
│
├── dataset/                 数据集
│   ├── manifest.json            元信息（12 站、时段、来源、校验和）
│   ├── event_rules.json         事件判据（已冻结）
│   └── daily/*.csv              12 个站点日值
│
├── tools/                   数据处理链（Python，只用标准库）
│   ├── build_dataset.py         从 DWD 生成数据集（含选站规则）
│   ├── check_quality.py         数据质量校验
│   ├── calibrate_criteria.py    判据标定（频率扫描）
│   ├── validate_criteria.py     已知历史事件复现校验
│   └── data-source-adapter.md   ★ 怎么换数据源（含踩坑清单）
│
└── evidence/                执行证据
    ├── 1-ingest.out / .err      六步的模型输出与工具调用记录
    ├── 2-clean.out / .err
    ├── 3-thresholds.out / .err
    ├── 4-detect.out / .err
    ├── 5-backtest.out / .err
    ├── 6-report.out / .err
    └── session-export.html      AGH 会话完整导出
```

---

## 遇到问题怎么办

1. **先查第八节**——四个连环坑都记在里面了
2. **看审计日志**：`$AGH_HOME/data/audit/host.jsonl`
   这是唯一能看到真因的地方，很多前端提示是误导
3. **看浏览器控制台**：面板的错误会打 `[WeatherLab]` 前缀
4. **还不行**，把这三样发我：**错误码 + 审计日志相关行 + 你执行的命令**

⚠️ **发问题的时候别带 API key。**
