#!/usr/bin/env bash
# ============================================================
#  ZCode macOS CDP 补丁开关（适配 Apple Silicon / Intel）
#  用法：
#    ./cdp-patch.sh Status            查看状态
#    ./cdp-patch.sh Apply             启用补丁（需先退出 ZCode；退出后约 1-2 分钟完成刷入）
#    ./cdp-patch.sh Apply --wait      自动等待 ZCode 退出
#    ./cdp-patch.sh Remove            停用补丁（整包 asar 还原）
#
#  依赖：Node.js（含 npm）。首次 Apply 会整包备份原版 asar 到 backup/。
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$SCRIPT_DIR"
BAK="$SCRIPT_DIR/backup"
LOG_TAG="[cdp-patch]"

log()  { echo "$LOG_TAG $*"; }
warn() { echo "$LOG_TAG [!] $*" >&2; }
die()  { echo "$LOG_TAG [x] $*" >&2; exit 1; }

# ---------- 参数预解析（须先于目录发现）----------
ACTION="Status"; WAIT_FLAG=""; APP_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    Status|Apply|Remove) ACTION="$1" ;;
    --wait) WAIT_FLAG="--wait" ;;
    --app) APP_ARG="${2:-}"; shift ;;
    *) warn "未知参数: $1"; exit 1 ;;
  esac
  shift
done

# ---------- 第一步：自动发现 ZCode.app ----------
# 优先级：--app 参数 > 环境变量 ZCODE_APP > /Applications > ~/Applications > mdfind 兜底
APP_CANDIDATES=()
[ -n "$APP_ARG" ] && APP_CANDIDATES+=("$APP_ARG")
[ -n "${ZCODE_APP:-}" ] && APP_CANDIDATES+=("$ZCODE_APP")
APP_CANDIDATES+=("/Applications/ZCode.app" "$HOME/Applications/ZCode.app")

APP=""
for c in "${APP_CANDIDATES[@]}"; do
  if [ -n "$c" ] && [ -f "$c/Contents/Resources/app.asar" ]; then APP="$c"; break; fi
done
if [ -z "$APP" ]; then
  APP=$(mdfind "kMDItemCFBundleIdentifier == 'com.zcode*'" 2>/dev/null | head -1 || true)
  [ -n "$APP" ] && [ -f "$APP/Contents/Resources/app.asar" ] || APP=""
fi
[ -n "$APP" ] || die "未自动发现 ZCode.app。请用 --app 指定，例如：./cdp-patch.sh Status --app ~/Apps/ZCode.app，或设环境变量 ZCODE_APP"

RES="$APP/Contents/Resources"
BROKER="$RES/glm/zcode.cjs"
PLUGIN_PKG="$RES/glm/packages/browser-use-plugin"
CACHE_ROOT="$HOME/.zcode/cli/plugins/cache/zcode-plugins-official/browser-use"
[ -f "$RES/app.asar" ] || die "未找到 $RES/app.asar"

zcode_running() { pgrep -xq ZCode 2>/dev/null || pgrep -fq "ZCode.app" 2>/dev/null; }

wait_exit() {
  if zcode_running; then
    [ -n "${WAIT_FLAG:-}" ] || die "ZCode 正在运行。请完全退出后重试；--wait 会自动结束残留进程"
    log "正在退出 ZCode（优雅 → 强制）..."
    osascript -e 'tell application "ZCode" to quit' >/dev/null 2>&1 || true
    sleep 3
    while zcode_running; do
      pkill -x ZCode 2>/dev/null || true
      sleep 2
    done
    sleep 1
    log "[OK] ZCode 已全部退出"
  fi
}

plugin_targets() {
  local list=()
  [ -f "$PLUGIN_PKG/scripts/browser-client.mjs" ] && list+=("$PLUGIN_PKG")
  if [ -d "$CACHE_ROOT" ]; then
    while IFS= read -r d; do
      [ -f "$d/scripts/browser-client.mjs" ] && list+=("$d")
    done < <(find "$CACHE_ROOT" -maxdepth 1 -type d -name '0.4*' 2>/dev/null)
  fi
  printf '%s\n' "${list[@]}"
}

# ---- Status ----
status() {
  echo "== ZCode macOS CDP 补丁状态 =="
  zcode_running && st="运行中" || st="未运行"
  echo "ZCode 进程 : $st"
  echo "应用路径   : $APP"
  local a=0 b=0 p=0
  grep -aq 'executeCdp' "$RES/app.asar" 2>/dev/null && a=1
  grep -aq 'literal("cdp")' "$BROKER" 2>/dev/null && b=1
  local first
  first="$(plugin_targets | head -1)"
  if [ -n "$first" ]; then
    grep -aq 'get cdp()' "$first/scripts/browser-client.mjs" 2>/dev/null && p=1
  fi
  echo "  app.asar 主进程桥/schema : $([[ $a -eq 1 ]] && echo Patched || echo Clean)"
  echo "  glm/zcode.cjs Broker     : $([[ $b -eq 1 ]] && echo Patched || echo Clean)"
  echo "  插件(0.4.x)              : $([[ $p -eq 1 ]] && echo Patched || echo Clean)"
  local n=$((a + b + p))
  if   [ "$n" -eq 0 ]; then echo "结论：全部未打补丁（干净状态）"
  elif [ "$n" -eq 3 ]; then echo "结论：全部已打补丁（CDP 可用）"
  else echo "结论：混合状态 —— 建议 Apply --force 或 Remove 后重刷"; fi
}

# ---- Apply ----
apply() {
  wait_exit

  local payload="$PAYLOAD" bro="$BAK"
  [ -f "$payload/rules.cjs" ] || die "缺少 $payload/rules.cjs"
  [ -f "$payload/zcode.cjs.gz" ] || die "缺少 $payload/zcode.cjs.gz"
  [ -f "$payload/browser-client.mjs" ] || die "缺少 $payload/browser-client.mjs"

  # 首次：整包备份原版 asar（Remove 的还原依据）
  mkdir -p "$bro"
  if [ ! -f "$bro/app.asar.original" ]; then
    log "[*] 首次备份原版 app.asar（约 300MB，一次性）..."
    cp "$RES/app.asar" "$bro/app.asar.original"
  fi
  if [ ! -f "$bro/zcode.cjs.original" ]; then
    cp "$BROKER" "$bro/zcode.cjs.original"
  fi
  local first_plugin
  first_plugin="$(plugin_targets | head -1)"
  if [ -n "$first_plugin" ] && [ ! -f "$bro/browser-client.mjs.original" ]; then
    cp "$first_plugin/scripts/browser-client.mjs" "$bro/browser-client.mjs.original"
    cp "$first_plugin/docs/api.json" "$bro/api.json.original"
  fi

  log "[*] 应用 Main/Host/Scheduler asar 补丁（规则引擎）..."
  command -v node >/dev/null || die "需要 Node.js（brew install node）"
  node "$SCRIPT_DIR/../apply-asar.mjs" "$RES/app.asar" "$payload/rules.cjs" "$(mktemp -d)/work"

  log "[*] 应用 Broker zcode.cjs ..."
  gzip -dc "$payload/zcode.cjs.gz" > "$BROKER"

  log "[*] 应用插件文件 ..."
  local t
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    cp "$payload/browser-client.mjs" "$t/scripts/browser-client.mjs"
    cp "$payload/api.json" "$t/docs/api.json"
    log "    [OK] $t"
  done < <(plugin_targets)

  log "[*] 重签名 + 清除隔离属性（macOS 修改包内资源后必需）..."
  xattr -cr "$APP" 2>/dev/null || true
  codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true

  log ""
  log "✅ 补丁已启用。启动 ZCode 新开对话验证：tab.cdp.evaluate(\"1+1\") / tab.openDevTools()"
}

# ---- Remove ----
remove() {
  wait_exit
  [ -f "$BAK/app.asar.original" ] || die "未找到整包备份 $BAK/app.asar.original，无法安全还原"

  log "[*] 还原 app.asar（整包）..."
  cp "$BAK/app.asar.original" "$RES/app.asar"
  log "[OK] app.asar 已还原"
  if [ -f "$BAK/zcode.cjs.original" ]; then
    cp "$BAK/zcode.cjs.original" "$BROKER"
    log "[OK] zcode.cjs 已还原"
  fi
  local t
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    [ -f "$BAK/browser-client.mjs.original" ] || break
    cp "$BAK/browser-client.mjs.original" "$t/scripts/browser-client.mjs"
    cp "$BAK/api.json.original" "$t/docs/api.json"
    log "    [OK] 还原 $t"
  done < <(plugin_targets)

  log "[*] 重签名 ..."
  xattr -cr "$APP" 2>/dev/null || true
  codesign --force --deep --sign - "$APP" 2>/dev/null || true

  log "✅ 已停用，ZCode 回到出厂状态"
}


case "$ACTION" in
  Status) status ;;
  Apply)  apply ;;
  Remove) remove ;;
  *) echo "用法: $0 {Status|Apply [--wait] [--app <ZCode.app路径>]|Remove}"; exit 1 ;;
esac
