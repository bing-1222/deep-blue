#!/usr/bin/env bash
# ============================================================================
#  start-web.sh — 启动 AGH Web 界面（含插件加载自检与自动恢复）
# ============================================================================
#  用法：
#    bash start-web.sh              # 启动 + 自检 + 必要时自动恢复
#    bash start-web.sh --check      # 只自检，不动服务
#    bash start-web.sh --status     # 看服务状态
#    bash start-web.sh --stop       # 停止
#    bash start-web.sh --restart    # 重启（含自检）
#
#  ── 为什么需要自检 ────────────────────────────────────────────────────────
#  实测发现：重启后插件**偶发**不随 daemon 加载。表现是
#    · 审计日志里只有内置扩展，没有 weatherlab-panel
#    · 模型看不到 wx_* 六个工具，会退化成反复 tool_search，最后答"找不到该工具"
#  只重启 Web 不会恢复，必须重跑 install → trust → enable。
#
#  所以本脚本在启动后自动核对「本次启动是否加载了 weatherlab-panel」，
#  没加载就自动修复，不用人工介入。
#
#  ── 为什么用 setsid ───────────────────────────────────────────────────────
#  如果通过别的程序（自动化工具等）间接启动，那个程序一结束服务就被回收，
#  页面立刻打不开。setsid 让服务脱离父进程，独立存活。
#
#  ── WSL 会被回收 ──────────────────────────────────────────────────────────
#  WSL 虚拟机空闲时会被 Windows 回收，进程随之消失（文件不受影响）。
#  WSL 重启或电脑重启后，必须重新执行本脚本。
# ============================================================================
set -u

AGH_WORK="${AGH_WORK:-$HOME/agh-clean}"
[ -d "$AGH_WORK/packages/cli" ] || AGH_WORK="$HOME/agnes-repo"
AGH_HOME="${AGH_HOME:-$HOME/agh-deepblue-home}"
export AGNES_PROFILE="${AGNES_PROFILE:-local-dev}"
export AURORA_DATA_ROOT="${AURORA_DATA_ROOT:-$AGH_WORK/deepblue/dataset}"
export AGH_HOME
export PATH="$HOME/.local/node/bin:$PATH"

ENTRY="$AGH_WORK/packages/cli/dist/local/agnes.mjs"
PLUGIN_DIR="$AGH_WORK/deepblue/panel"
PKG_ID="weatherlab-panel"
AUDIT="$AGH_HOME/data/audit/host.jsonl"
LOG="$AGH_WORK/serve.log"
PIDF="$AGH_WORK/serve.pid"
PORT="${AGH_PORT:-4177}"

c_say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
c_ok()  { printf '    \033[1;32m%s\033[0m\n' "$*"; }
c_bad() { printf '    \033[1;31m%s\033[0m\n' "$*"; }
c_wrn() { printf '    \033[1;33m%s\033[0m\n' "$*"; }

[ -f "$ENTRY" ] || { c_bad "找不到 AGH 入口: $ENTRY"; echo "    请先运行 bootstrap.sh"; exit 1; }
command -v node >/dev/null 2>&1 || { c_bad "找不到 node，请先运行 setup.sh"; exit 1; }

listening() { ss -tln 2>/dev/null | grep -q ":$PORT "; }

# ── 自检：本次启动是否加载了插件 ──────────────────────────────────────────
#  判定方式：以最后一次 profile.resolved 为界，看之后有没有 weatherlab-panel。
#  不能只 grep 整个审计文件——那是历史累积的，会误判成"已加载"。
plugin_loaded() {
  [ -f "$AUDIT" ] || return 1
  python3 - "$AUDIT" <<'PY'
import json, sys
rows = []
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try:
        rows.append(json.loads(line))
    except Exception:
        pass
starts = [i for i, r in enumerate(rows) if r.get("kind") == "profile.resolved"]
if not starts:
    sys.exit(1)
cur = rows[starts[-1]:]
loaded = {r.get("detail", {}).get("package") for r in cur if r.get("kind") == "extension.loaded"}
tools = {r.get("detail", {}).get("name") for r in cur
         if r.get("kind") == "extension.registered" and str(r.get("detail", {}).get("name", "")).startswith("wx_")}
ok = any(p and "weatherlab" in p for p in loaded) and len(tools) >= 6
sys.exit(0 if ok else 1)
PY
}

show_plugin_state() {
  [ -f "$AUDIT" ] || { echo "    (无审计文件)"; return; }
  python3 - "$AUDIT" <<'PY'
import json, sys
rows = []
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try: rows.append(json.loads(line))
    except Exception: pass
starts = [i for i, r in enumerate(rows) if r.get("kind") == "profile.resolved"]
cur = rows[starts[-1]:] if starts else rows
loaded = sorted({r.get("detail", {}).get("package") for r in cur if r.get("kind") == "extension.loaded"})
tools = sorted({r.get("detail", {}).get("name") for r in cur
                if r.get("kind") == "extension.registered" and str(r.get("detail", {}).get("name", "")).startswith("wx_")})
wl = [p for p in loaded if p and "weatherlab" in p]
print("    插件包     :", ", ".join(wl) if wl else "**未加载**")
print("    wx_* 工具  :", (", ".join(tools) if tools else "**无**") + f"  ({len(tools)}/6)")
PY
}

# ── 恢复：重跑 install → trust → enable ──────────────────────────────────
recover_plugin() {
  c_say "插件未加载，执行恢复（install → trust → enable）"
  [ -d "$PLUGIN_DIR" ] || { c_bad "找不到插件目录: $PLUGIN_DIR"; return 1; }
  cat > "$AGH_WORK/.recover-plugin.mjs" <<'EOF'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient, memoryJournal } from './packages/sdk/src/index.node.ts'

const home = process.env.AGH_HOME, profile = process.env.AGNES_PROFILE ?? 'local-dev'
let owner
try {
  owner = JSON.parse(await readFile(join(home, 'data/daemon/owner.json'), 'utf8'))
} catch (e) {
  console.log('  读不到 daemon owner.json:', String(e.message).slice(0, 80)); process.exit(1)
}
const c = createClient({ transport: { kind: 'unix', path: owner.socketPath },
  auth: { kind: 'local' }, journal: memoryJournal() })
await c.initialize()
const common = { profile, clientId: await c.clientId() }
const waitOp = async (k, r) => {
  const dl = Date.now() + 150000
  while (Date.now() < dl) {
    const s = await c.packages.operation.get({ profile, operationId: r.operationId })
    if (s.state === 'failed' || s.state === 'cancelled')
      throw new Error(`${k}: ${s.error?.code ?? s.state} ${s.error?.message ?? ''}`)
    if (['completed', 'rolled-back'].includes(s.state)) return s
    await new Promise((d) => setTimeout(d, 150))
  }
  throw new Error(k + ' timeout')
}
const op = async (k, p) => waitOp(k, await c.packages[k]({ ...common, commandId: `x-${randomUUID()}`, ...p }))
const SRC = { type: 'file', ref: `file:${process.env.PLUGIN_REF}` }
const ID = process.env.PKG_ID

const l0 = await c.packages.list({ profile })
const cur = l0.packages.find((p) => p.id === ID)
if (cur && cur.actual === 'running' && cur.trusted) {
  console.log('  其实已经 running，无需恢复'); process.exit(0)
}
if (cur) {
  try { await op('disable', { id: ID }) } catch {}
  try { await op('remove', { id: ID }) } catch {}
}
const { preview } = await op('inspect', { source: SRC })
await op('install', { source: SRC, expectedIntegrity: preview.integrity })
await op('trust', { id: preview.id, expectedIntegrity: preview.integrity, capabilityHash: preview.capabilityHash })
await op('enable', { id: preview.id })
let row = null
{ const dl = Date.now() + 90000
  while (Date.now() < dl) {
    const l = await c.packages.list({ profile })
    row = l.packages.find((p) => p.id === preview.id)
    if (row && row.actual === 'running') break
    await new Promise((d) => setTimeout(d, 300))
  } }
console.log('  恢复结果:', row ? `actual=${row.actual} trusted=${row.trusted}` : '(未找到)')
process.exit(row && row.actual === 'running' ? 0 : 1)
EOF
  PLUGIN_REF="./deepblue/panel" PKG_ID="$PKG_ID" \
    timeout 240 node --import tsx "$AGH_WORK/.recover-plugin.mjs" 2>&1 | tail -8
  local rc=$?
  rm -f "$AGH_WORK/.recover-plugin.mjs"
  return "$rc"
}

stop_web() {
  if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
    kill "$(cat "$PIDF")" 2>/dev/null && c_ok "已停止 (pid $(cat "$PIDF"))"
    sleep 2
    kill -9 "$(cat "$PIDF")" 2>/dev/null || true
  fi
  rm -f "$PIDF"
  for p in $(ps -eo pid,args 2>/dev/null | grep 'agnes\.mjs serve' | grep -v grep | awk '{print $1}'); do
    kill "$p" 2>/dev/null && c_ok "清理残留 serve pid=$p"
  done
  for p in $(ps -eo pid,args 2>/dev/null | grep -E 'daemon\.mjs|worker\.mjs' | grep -v grep | awk '{print $1}'); do
    kill "$p" 2>/dev/null
  done
  sleep 2
}

status_web() {
  echo "  端口 $PORT :"
  if listening; then ss -tlnp 2>/dev/null | grep ":$PORT " | sed 's/^/    /'
  else echo "    未监听"; fi
  echo "  pidfile   : $([ -f "$PIDF" ] && cat "$PIDF" || echo '(无)')"
  echo "  AGH_WORK  : $AGH_WORK"
  echo "  AGH_HOME  : $AGH_HOME"
  echo "  数据目录  : $AURORA_DATA_ROOT"
  if command -v curl >/dev/null 2>&1; then
    printf '  HTTP      : '; curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/" 2>/dev/null || echo '?'
  fi
  echo "  插件状态  :"
  show_plugin_state
}

serve_up() {
  setsid nohup node "$ENTRY" serve > "$LOG" 2>&1 < /dev/null &
  echo "$!" > "$PIDF"
  for i in $(seq 1 45); do sleep 1; listening && return 0; done
  return 1
}

# ── 子命令 ────────────────────────────────────────────────────────────────
case "${1:-}" in
  --stop)    stop_web; exit 0 ;;
  --status)  status_web; exit 0 ;;
  --check)
    c_say "插件加载自检"
    if plugin_loaded; then c_ok "已加载"; else c_wrn "未加载（可跑 start-web.sh 自动恢复）"; fi
    show_plugin_state
    exit 0 ;;
  --restart) stop_web; c_ok "已停止，准备重启" ;;
esac

# ── 已在运行 ──────────────────────────────────────────────────────────────
if listening; then
  c_ok "Web 已在 127.0.0.1:$PORT 运行"
  if plugin_loaded; then
    show_plugin_state
    exit 0
  fi
  c_wrn "但插件未加载，执行恢复"
  if recover_plugin; then
    c_ok "已恢复，重启服务以生效"
    stop_web
  else
    c_bad "自动恢复失败，请手动运行 bootstrap.sh"; exit 1
  fi
fi

# ── 启动 ──────────────────────────────────────────────────────────────────
c_say "启动 AGH Web"
cd "$AGH_WORK"
stop_web

c_ok "已拉起服务，等待就绪…"
if ! serve_up; then
  c_bad "启动超时（45s），日志尾部："
  tail -20 "$LOG" 2>/dev/null | sed 's/^/    /'
  exit 1
fi
c_ok "端口已就绪"

# 给 daemon 完成扩展装配的时间
sleep 5

c_say "插件加载自检"
if plugin_loaded; then
  c_ok "插件已随本次启动加载"
  show_plugin_state
else
  c_wrn "插件未随本次启动加载，自动恢复"
  if recover_plugin; then
    c_ok "已恢复，重启服务使其生效"
    stop_web
    if serve_up; then
      sleep 5
      if plugin_loaded; then c_ok "恢复后自检通过"; else c_bad "恢复后仍未加载"; fi
    else
      c_bad "重启超时"
    fi
  else
    c_bad "自动恢复失败，请手动运行：bash bootstrap.sh --skip-build"
  fi
fi

echo
echo "  ┌──────────────────────────────────────────┐"
printf '  │  请在浏览器打开： http://127.0.0.1:%-5s│\n' "$PORT"
echo "  └──────────────────────────────────────────┘"
echo
status_web
echo
echo "  提示：WSL 或电脑重启后需重新执行本脚本（服务不会自启）。"
echo "        演示前可随时跑：bash start-web.sh --check"
