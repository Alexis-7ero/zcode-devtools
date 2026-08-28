#!/usr/bin/env bash
# 一键重装（macOS）：自动提权 → 退出 ZCode → 还原纯净原版 → 规则引擎 hook → Broker/插件 → 自检
set -euo pipefail
cd "$(dirname "$0")"
SCRIPT_DIR="$(pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 自动提权（写 /Applications 需要 root；-E 保留环境以定位用户级插件缓存）
if [ "$EUID" -ne 0 ]; then
  exec sudo -E bash "$0"
fi

# ---------- 定位 ZCode.app ----------
APP_CANDIDATES=()
[ -n "${ZCODE_APP:-}" ] && APP_CANDIDATES+=("$ZCODE_APP")
APP_CANDIDATES+=("/Applications/ZCode.app" "$HOME/Applications/ZCode.app")
APP=""
for c in "${APP_CANDIDATES[@]}"; do
  [ -n "$c" ] && [ -f "$c/Contents/Resources/app.asar" ] && { APP="$c"; break; }
done
if [ -z "$APP" ] && command -v mdfind >/dev/null; then
  APP=$(mdfind "kMDItemCFBundleIdentifier == 'com.zcode*'" 2>/dev/null | head -1 || true)
  [ -n "$APP" ] && [ -f "$APP/Contents/Resources/app.asar" ] || APP=""
fi
[ -n "$APP" ] || { echo "[x] 未自动发现 ZCode.app，请用 ZCODE_APP 环境变量指定"; exit 1; }
RES="$APP/Contents/Resources"
BROKER="$RES/glm/zcode.cjs"
echo "[*] 安装目录: $APP"

# ---------- 退出 ZCode（优雅 → 强制）----------
quit_zcode() {
  osascript -e 'tell application "ZCode" to quit' >/dev/null 2>&1 || true
  sleep 3
  while pgrep -xq ZCode 2>/dev/null; do
    pkill -x ZCode 2>/dev/null || true
    sleep 2
  done
}
if pgrep -xq ZCode 2>/dev/null; then
  echo "[*] 结束 ZCode ..."
  quit_zcode
fi

# ---------- 备份（一次性）/ 还原纯净 ----------
BAK="$SCRIPT_DIR/backup"
mkdir -p "$BAK"
if [ ! -f "$BAK/app.asar.original" ]; then
  # 首次：当前 asar 应为未打补丁状态才可作为"原版"
  if grep -aq 'executeCdp' "$RES/app.asar"; then
    echo "[x] 当前 asar 已含补丁且无历史备份，拒绝将其误存为原版。"
    echo "    请先用官方安装包覆盖 ZCode.app 后重试。"
    exit 1
  fi
  echo "[*] 首次备份原版 app.asar ..."
  cp "$RES/app.asar" "$BAK/app.asar.original"
fi
[ -f "$BAK/zcode.cjs.original" ] || cp "$BROKER" "$BAK/zcode.cjs.original"

echo "[*] 还原纯净原版 ..."
cp "$BAK/app.asar.original" "$RES/app.asar"

# ---------- 规则引擎 hook ----------
echo "[*] 规则引擎 hook main/host/scheduler + schema ..."
command -v node >/dev/null || { echo "[x] 需要 Node.js（brew install node）"; exit 1; }
node "$ROOT/apply-asar.mjs" "$RES/app.asar" "$ROOT/rules.cjs" "$(mktemp -d)/work"

# ---------- Broker / 插件 ----------
echo "[*] 替换 Broker ..."
gzip -dc "$ROOT/zcode.cjs.gz" > "$BROKER"

echo "[*] 覆盖插件 (0.4.x) ..."
targets=()
[ -f "$RES/glm/packages/browser-use-plugin/scripts/browser-client.mjs" ] && targets+=("$RES/glm/packages/browser-use-plugin")
CACHE_ROOT="$HOME/.zcode/cli/plugins/cache/zcode-plugins-official/browser-use"
if [ -d "$CACHE_ROOT" ]; then
  while IFS= read -r d; do targets+=("$d"); done < <(find "$CACHE_ROOT" -maxdepth 1 -type d -name '0.4*' 2>/dev/null)
fi
for t in "${targets[@]:-}"; do
  [ -z "$t" ] && continue
  cp "$ROOT/browser-client.mjs" "$t/scripts/browser-client.mjs"
  cp "$ROOT/api.json" "$t/docs/api.json"
  echo "    [OK] $t"
done

# ---------- 重签名 + 自检 ----------
echo "[*] 重签名 + 清除隔离属性 ..."
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true

echo "[*] 自检 ..."
ok1=$(grep -aq 'executeCdp' "$RES/app.asar" && echo y || echo n)
ok2=$(grep -aq 'literal("cdp")' "$RES/app.asar" && echo y || echo n)
ok3=$(grep -aq 'literal("cdp")' "$BROKER" && echo y || echo n)
echo "  asar 主进程桥 : $([ "$ok1" = y ] && echo Patched || echo FAIL)"
echo "  asar schema   : $([ "$ok2" = y ] && echo Patched || echo FAIL)"
echo "  Broker        : $([ "$ok3" = y ] && echo Patched || echo FAIL)"

if [ "$ok1" = y ] && [ "$ok2" = y ] && [ "$ok3" = y ]; then
  echo ""
  echo "✅ 重装完成！启动 ZCode，新开对话验证："
  echo '   打开 https://www.baidu.com 然后执行 tab.cdp.evaluate("1+1") 和 tab.openDevTools()'
else
  echo ""
  echo "❌ 存在未通过项，请截图反馈" >&2
  exit 1
fi
