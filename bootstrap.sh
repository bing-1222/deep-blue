#!/usr/bin/env bash
# ============================================================================
#  bootstrap.sh — 从零构建 AGH 并安装 DeepBlue 插件
# ============================================================================
#  前置：先跑 setup.sh（或自备 Node >= 24.10 与 pnpm）
#
#  用法:
#    bash bootstrap.sh                      # 从 zip 构建（默认路径见下）
#    AGH_ZIP=/path/to/agnes.zip bash bootstrap.sh
#    AGH_REPO=/path/to/existing/repo bash bootstrap.sh   # 复用已有源码
#    bash bootstrap.sh --skip-build         # 只装插件，不重新构建
#
#  产出:
#    $AGH_WORK          AGH 源码 + 构建产物
#    $AGH_WORK/deepblue DeepBlue 副本（插件与数据集）
#    $AGH_HOME          AGH 运行数据目录（与源码分离）
#
#  幂等：重复执行安全（已构建则跳过构建）
# ============================================================================
set -euo pipefail

# node 可能没进 PATH —— 显式注入，不依赖 shell 启动文件
export PATH="$HOME/.local/node/bin:$PATH"

NODE_MIN_MAJOR=24
AGH_WORK="${AGH_WORK:-$HOME/agh-clean}"
AGH_HOME="${AGH_HOME:-$HOME/agh-deepblue-home}"
DEEPBLUE_SRC="${DEEPBLUE_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
AGH_ZIP="${AGH_ZIP:-}"
AGH_REPO="${AGH_REPO:-}"
SKIP_BUILD=0

for a in "$@"; do
  case "$a" in
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

say()  { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m** %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. 前置检查 ─────────────────────────────────────────────────────────────
say "检查前置"
command -v node >/dev/null 2>&1 || die "找不到 node。请先运行 setup.sh"
NV="$(node -v)"; MAJ="${NV#v}"; MAJ="${MAJ%%.*}"
[ "$MAJ" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null || die "node $NV 过低，AGH 要求 >= ${NODE_MIN_MAJOR}.10"
command -v pnpm >/dev/null 2>&1 || die "找不到 pnpm。请先运行 setup.sh"
ok "node $NV  pnpm $(pnpm -v)"
ok "DeepBlue 源: $DEEPBLUE_SRC"
[ -f "$DEEPBLUE_SRC/panel/package.json" ] || die "$DEEPBLUE_SRC 不像 DeepBlue 目录（缺 panel/package.json）"

# ── 1. 取得 AGH 源码 ────────────────────────────────────────────────────────
say "准备 AGH 源码"
if [ -n "$AGH_REPO" ] && [ -f "$AGH_REPO/package.json" ]; then
  AGH_WORK="$AGH_REPO"
  ok "复用已有源码: $AGH_WORK"
else
  if [ -f "$AGH_WORK/package.json" ]; then
    ok "已存在: $AGH_WORK"
  else
    if [ -z "$AGH_ZIP" ]; then
      # 若 DeepBlue 同级有 zip，自动找
      for c in "$DEEPBLUE_SRC/../agnes-harness-main.zip" "$HOME/agnes-harness-main.zip" \
               "/mnt/d/User/Users/Downloads/agnes-harness-main.zip"; do
        [ -f "$c" ] && AGH_ZIP="$c" && break
      done
    fi
    [ -n "$AGH_ZIP" ] && [ -f "$AGH_ZIP" ] || die "找不到 AGH 源码 zip，请设 AGH_ZIP=/path/to/zip"
    say "解压 $AGH_ZIP -> $AGH_WORK"
    mkdir -p "$AGH_WORK"
    python3 - "$AGH_ZIP" "$AGH_WORK" <<'PY'
import os, sys, zipfile
z = zipfile.ZipFile(sys.argv[1]); root = sys.argv[2]
z.extractall(root)
inner = os.path.join(root, "agnes-harness-main")
if os.path.isdir(inner):
    for n in os.listdir(inner):
        os.rename(os.path.join(inner, n), os.path.join(root, n))
    os.rmdir(inner)
print("   解压 %d 个条目" % len(z.namelist()))
PY
    ok "解压完成"
  fi
fi
cd "$AGH_WORK"

# ── 2. 安装依赖 ─────────────────────────────────────────────────────────────
if [ ! -d node_modules ] || [ ! -f pnpm-lock.yaml ]; then
  say "pnpm install"
  pnpm install --reporter=append-only 2>&1 | tail -8
  ok "依赖就绪"
else
  ok "node_modules 已存在，跳过 install"
fi

# ── 3. 构建 ─────────────────────────────────────────────────────────────────
ENTRY="$AGH_WORK/packages/cli/dist/local/agnes.mjs"
if [ "$SKIP_BUILD" -eq 1 ]; then
  warn "--skip-build：跳过构建"
elif [ -f "$ENTRY" ]; then
  ok "构建产物已存在，跳过（要重建请删掉 packages/cli/dist）"
else
  say "构建 CLI"
  pnpm --filter @agnes/cli build:local 2>&1 | tail -6
  say "构建原生构件"
  pnpm --filter @agnes/system-node build:native 2>&1 | tail -4
  ok "构建完成"
fi
[ -f "$ENTRY" ] || [ -f "$ENTRY" ] || die "构建产物缺失: $ENTRY"

NATIVE="$AGH_WORK/packages/system-node/dist/native/agnes-system.node"
if [ -f "$NATIVE" ]; then
  if node -e "
const m={exports:{}}; process.dlopen(m, process.argv[1]);
if (!Object.keys(m.exports).length) process.exit(1);
" "$NATIVE" 2>/dev/null; then
    ok "原生构件可加载 ($(stat -c%s "$NATIVE") 字节)"
  else
    warn "原生构件存在但 dlopen 失败 —— 可能缺编译依赖，见 setup.sh"
  fi
else
  warn "未找到原生构件（部分功能可能不可用）"
fi

# ── 4. 同步 DeepBlue ────────────────────────────────────────────────────────
say "同步 DeepBlue 到工作区"
DEST="$AGH_WORK/deepblue"
rm -rf "$DEST"; mkdir -p "$DEST"
cp -r "$DEEPBLUE_SRC/." "$DEST"/
rm -rf "$DEST/cache" "$DEST/__pycache__"
ok "$(ls -1 "$DEST/dataset/daily" | wc -l) 个站点 csv"

# ── 5. AGH_HOME 与 profile ─────────────────────────────────────────────────
say "准备 AGH_HOME"
mkdir -p "$AGH_HOME/profiles/local-dev"
chmod 700 "$AGH_HOME/profiles/local-dev"
# 若已存在且含 provider.routes 则保留；否则写完整版（含 provider 路由，缺了会卡死）
if [ -f "$AGH_HOME/profiles/local-dev/profile.yaml" ] && grep -q 'routes:' "$AGH_HOME/profiles/local-dev/profile.yaml"; then
  ok "profile.yaml 已存在且含 provider 路由，保留"
else
  cat > "$AGH_HOME/profiles/local-dev/profile.yaml" <<EOF
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
          contract_id: null

adapters:
  storage: sqlite
  fs: local
  exec: local
  platform: host
  secrets: { kind: file, path: $AGH_HOME/secrets }

transports: [{ kind: stdio }]

dataDir: $AGH_HOME/data
cacheDir: $AGH_HOME/cache

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
    - services
    - network
    - network.publicRead
    - tools.invoke
    - artifacts
    - subagent
  workspacePackages: require-project-trust

computerUse:
  enabled: false
EOF
  chmod 600 "$AGH_HOME/profiles/local-dev/profile.yaml"
  ok "写入完整 profile.yaml（含 provider 路由）"
fi

# ── 6. 安装并启用插件 ───────────────────────────────────────────────────────
say "安装 DeepBlue 插件"
export AGH_HOME AGNES_PROFILE=local-dev AURORA_DATA_ROOT="$DEST/dataset"
node "$ENTRY" daemon stop >/dev/null 2>&1 || true
sleep 1
node "$ENTRY" daemon start >/dev/null 2>&1 || true
sleep 2

cat > "$AGH_WORK/.install-deepblue.mjs" <<'EOF'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient, memoryJournal } from './packages/sdk/src/index.node.ts'

const home = process.env.AGH_HOME
const profile = process.env.AGNES_PROFILE ?? 'local-dev'
const owner = JSON.parse(await readFile(join(home, 'data/daemon/owner.json'), 'utf8'))
const client = createClient({ transport: { kind: 'unix', path: owner.socketPath },
  auth: { kind: 'local' }, journal: memoryJournal() })
await client.initialize()
const common = { profile, clientId: await client.clientId() }
const waitOp = async (kind, receipt) => {
  const dl = Date.now() + 120000
  while (Date.now() < dl) {
    const r = await client.packages.operation.get({ profile, operationId: receipt.operationId })
    if (r.state === 'failed' || r.state === 'cancelled')
      throw new Error(`${kind} 失败: ${r.error?.code ?? r.state} ${r.error?.message ?? ''}`)
    if (['completed', 'rolled-back'].includes(r.state)) return r
    await new Promise((d) => setTimeout(d, 150))
  }
  throw new Error(`${kind} 超时`)
}
const op = async (k, p) => waitOp(k, await client.packages[k]({ ...common, commandId: `db-${randomUUID()}`, ...p }))
const SRC = { type: 'file', ref: 'file:./deepblue/panel' }

const { preview } = await op('inspect', { source: SRC })
if ((preview.blockers ?? []).length) throw new Error('blockers: ' + JSON.stringify(preview.blockers))
console.log('  包      :', preview.id, preview.version)
console.log('  integrity:', preview.integrity)
await op('install', { source: SRC, expectedIntegrity: preview.integrity })
await op('trust', { id: preview.id, expectedIntegrity: preview.integrity, capabilityHash: preview.capabilityHash })
await op('enable', { id: preview.id })

let row = null
const dl = Date.now() + 90000
while (Date.now() < dl) {
  const list = await client.packages.list({ profile })
  row = list.packages.find((p) => p.id === preview.id)
  if (row && row.actual === 'running' && row.trusted) break
  await new Promise((d) => setTimeout(d, 300))
}
console.log('  最终状态:', row ? `desired=${row.desired} actual=${row.actual} trusted=${row.trusted}` : '(未找到)')
if (!row || row.actual !== 'running') process.exit(1)
EOF
set +e
node --import tsx "$AGH_WORK/.install-deepblue.mjs" 2>&1 | tail -12
RC=${PIPESTATUS[0]}
set -e
[ "$RC" -eq 0 ] || die "插件安装失败（退出码 $RC）"

# ── 7. 验收 ─────────────────────────────────────────────────────────────────
say "验收：审计日志里的工具注册"
grep -o '"name":"wx_[a-z]*"' "$AGH_HOME/data/audit/host.jsonl" 2>/dev/null | sort -u | sed 's/^/    /' || warn "未找到注册记录"

cat > "$AGH_WORK/run-agent.sh" <<EOF
#!/usr/bin/env bash
# 启动 AGH 会话（已配好 DeepBlue 环境）
export PATH="\$HOME/.local/node/bin:\$PATH"
export AGH_HOME="$AGH_HOME"
export AGNES_PROFILE=local-dev
export AURORA_DATA_ROOT="$DEST/dataset"
cd "$AGH_WORK"
exec node "$ENTRY" "\$@"
EOF
chmod +x "$AGH_WORK/run-agent.sh"

echo
ok "bootstrap 完成"
echo "  启动会话:  $AGH_WORK/run-agent.sh"
echo "  数据根目录: $DEST/dataset"
echo "  设置环境变量后可直接用 CLI:"
echo "    export PATH=\"\$HOME/.local/node/bin:\$PATH\""
echo "    export AGH_HOME=\"$AGH_HOME\" AGNES_PROFILE=local-dev AURORA_DATA_ROOT=\"$DEST/dataset\""
