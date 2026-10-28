#!/usr/bin/env bash
# ============================================================================
#  setup.sh — 在全新的 Linux 机器上装齐 DeepBlue 运行环境
# ============================================================================
#  适用：Ubuntu 22.04 / Debian 系（其他发行版见文末）
#  幂等：重复执行安全
#
#  装三样东西：
#    1. 系统编译工具链（AGH 有一个原生构件必须现编）
#    2. Node.js 24（AGH 要求 >= 24.10）
#    3. pnpm 10
#
#  用法:
#    bash setup.sh              # 安装到 ~/.local/node
#    NODE_VERSION=24.16.0 bash setup.sh
# ============================================================================
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-24.16.0}"
NODE_MAJOR_REQUIRED=24
NODE_ROOT="${NODE_ROOT:-$HOME/.local/node}"
NODE_BIN="$NODE_ROOT/bin"
MIRROR="${NODE_MIRROR:-https://nodejs.org/dist}"

say()  { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m** %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. 系统包 ────────────────────────────────────────────────────────────────
say "检查系统编译工具链"
NEED=()
for c in cc g++ make python3 curl tar; do
  command -v "$c" >/dev/null 2>&1 || NEED+=("$c")
done

if [ ${#NEED[@]} -gt 0 ]; then
  warn "缺少: ${NEED[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    say "用 apt 安装编译工具链（需要 sudo）"
    sudo apt-get update -qq
    # build-essential 提供 cc/g++/make；python3 给 node-gyp 用；curl/tar 下载 node
    sudo apt-get install -y -qq build-essential python3 curl tar ca-certificates xz-utils
    ok "已安装"
  else
    die "非 apt 系统，请手动安装: build-essential python3 curl tar xz-utils"
  fi
else
  ok "cc / g++ / make / python3 / curl / tar 齐全"
fi

# ── 2. Node.js ──────────────────────────────────────────────────────────────
say "检查 Node.js（AGH 要求 >= ${NODE_MAJOR_REQUIRED}.10）"
CUR=""
if command -v node >/dev/null 2>&1; then
  CUR="$(node -v 2>/dev/null || true)"
fi
# 允许 ~/.local/node 里已有但未进 PATH 的情况
if [ -x "$NODE_BIN/node" ]; then
  LOCAL_VER="$("$NODE_BIN/node" -v)"
  case "$LOCAL_VER" in
    v2[4-9].*|v[3-9][0-9].*) CUR="$LOCAL_VER"; export PATH="$NODE_BIN:$PATH" ;;
  esac
fi

if [ -n "$CUR" ]; then
  MAJOR="${CUR#v}"; MAJOR="${MAJOR%%.*}"
  if [ "$MAJOR" -ge "$NODE_MAJOR_REQUIRED" ] 2>/dev/null; then
    ok "已有 node $CUR（$(command -v node)）"
  else
    warn "现有 node $CUR 版本过低，将安装 $NODE_VERSION"
    CUR=""
  fi
fi

if [ -z "$CUR" ]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) NARCH=x64 ;;
    aarch64|arm64) NARCH=arm64 ;;
    *) die "不支持的架构: $ARCH（Node 官方只提供 x64 / arm64）" ;;
  esac
  # 32 位 x86 Linux 没有 Node 24 的构建，这里明确拒绝而不是装到一半失败
  case "$ARCH" in
    i?86) die "32 位 x86 没有 Node 24 构建，无法支持" ;;
  esac

  TARBALL="node-v${NODE_VERSION}-linux-${NARCH}.tar.xz"
  say "下载 $TARBALL"
  mkdir -p "$NODE_ROOT"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if ! curl -fsSL --retry 3 -o "$TMP/$TARBALL" "$MIRROR/v${NODE_VERSION}/$TARBALL"; then
    warn "官方源失败，改用 npmmirror"
    curl -fsSL --retry 3 -o "$TMP/$TARBALL" \
      "https://npmmirror.com/mirrors/node/v${NODE_VERSION}/$TARBALL" \
      || die "下载 Node 失败，请检查网络"
  fi
  tar -xJf "$TMP/$TARBALL" -C "$TMP"
  # 官方 tarball 解压后是 node-vX-linux-Y/，内容直接铺进 NODE_ROOT
  cp -a "$TMP/node-v${NODE_VERSION}-linux-${NARCH}/." "$NODE_ROOT/"
  ok "已安装到 $NODE_ROOT"
  export PATH="$NODE_BIN:$PATH"
fi

# ── 3. 固化 PATH ────────────────────────────────────────────────────────────
say "固化 PATH"
MARK="# >>> deepblue-node-path >>>"
if [ -w /etc/profile.d ] 2>/dev/null || sudo -n true 2>/dev/null; then
  sudo tee /etc/profile.d/deepblue-node.sh >/dev/null <<EOF
# DeepBlue / AGH: Node.js from \$HOME/.local/node
# Placed in profile.d (not ~/.bashrc) so NON-INTERACTIVE shells get it too.
if [ -d "\$HOME/.local/node/bin" ]; then
  case ":\$PATH:" in
    *":\$HOME/.local/node/bin:"*) ;;
    *) PATH="\$HOME/.local/node/bin:\$PATH" ;;
  esac
  export PATH
fi
EOF
  ok "已写入 /etc/profile.d/deepblue-node.sh"
else
  warn "无 sudo 权限写 /etc/profile.d —— 请在每个脚本里显式加："
  warn '  export PATH="$HOME/.local/node/bin:$PATH"'
fi

# 交互 shell 也补一份（幂等）
if ! grep -qF "$MARK" "$HOME/.bashrc" 2>/dev/null; then
  {
    echo ""
    echo "$MARK"
    echo 'export PATH="$HOME/.local/node/bin:$PATH"'
    echo "# <<< deepblue-node-path <<<"
  } >> "$HOME/.bashrc"
  ok "已追加到 ~/.bashrc"
fi

# ── 4. pnpm ─────────────────────────────────────────────────────────────────
say "检查 pnpm"
export PATH="$NODE_BIN:$PATH"
if command -v pnpm >/dev/null 2>&1; then
  ok "已有 pnpm $(pnpm -v)"
else
  say "用 npm 安装 pnpm"
  npm config set registry https://registry.npmmirror.com >/dev/null 2>&1 || true
  npm install -g pnpm >/dev/null 2>&1 || npm install -g pnpm
  ok "已安装 pnpm $(pnpm -v)"
fi

# ── 5. 验收 ─────────────────────────────────────────────────────────────────
say "验收"
bash -lc '
  echo "  node : $(node -v 2>/dev/null || echo MISSING)"
  echo "  npm  : $(npm -v 2>/dev/null || echo MISSING)"
  echo "  pnpm : $(pnpm -v 2>/dev/null || echo MISSING)"
  echo "  cc   : $(cc --version 2>/dev/null | head -1 || echo MISSING)"
  echo "  py3  : $(python3 -V 2>&1)"
'

echo
ok "setup 完成。下次开 shell 后 node 应已在 PATH。"
echo "  若当前 shell 里 node 仍找不到，执行:  export PATH=\"\$HOME/.local/node/bin:\$PATH\""
