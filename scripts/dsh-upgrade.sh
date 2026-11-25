#!/bin/bash
# dsh-fnos 安全升级包装（2026-11-18 根治"升级把自己卸载"）
# 用法: dsh-upgrade.sh <stage目录> <install.env> <应用名> <期望版本> [fpk文件]
# 流程: 装前冷备 target → install-local（stop→uninstall→install→start）
#       → 装后校验（manifest 版本 + 进程拉起 + GUI 探针）
#       → 失败/超时自动用 install-fpk 重装兜底 → 仍失败则报错退出非 0
set -Eeuo pipefail
STAGE="${1:?用法: dsh-upgrade.sh <stage目录> <install.env> <应用名> <期望版本> [fpk文件]}"
ENV_FILE="${2:?缺少 install.env}"
APP_NAME="${3:?缺少应用名}"
EXPECT_VER="${4:?缺少期望版本}"
FPK_EXPLICIT="${5:-}"
CLI=/usr/local/bin/appcenter-cli
TS=$(date +%Y%m%d-%H%M%S)
LOG_PREFIX="[dsh-upgrade]"
MARKER="/vol1/1000/DSH-Recovery/dsh-fnos/upgrade-marker-${APP_NAME}.json"

log(){ printf "%s %s %s\n" "$(date '+%F %T')" "$LOG_PREFIX" "$*" >&2; }

# 0. 断点续装：marker 显示目标版本已装好且进程在跑 → 之前那次升级其实成功了（rc 丢失），直接收尾退出
if [ -f "$MARKER" ] && grep -q "$EXPECT_VER" "$MARKER" 2>/dev/null; then
  if grep -q "^version.*$EXPECT_VER" "/var/apps/$APP_NAME/manifest" 2>/dev/null && pgrep -f "$APP_NAME/supervisor.js" >/dev/null; then
    log "marker 显示 $APP_NAME 已在 $EXPECT_VER 且进程在跑；上次升级实际成功，收尾退出"
    rm -f "$MARKER"
    exit 0
  fi
fi
printf '{"target":"%s","startedAt":"%s"}' "$EXPECT_VER" "$(date -Iseconds)" > "$MARKER"

# 1. 装前冷备 target（可回滚的完整副本）
TARGET_DIR="/var/apps/$APP_NAME/target"
BACKUP_DIR="/vol1/1000/DSH-Recovery/dsh-fnos/upgrade-backups/$APP_NAME-$TS"
if [ -d "$TARGET_DIR" ]; then
  log "冷备 $TARGET_DIR → $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
  cp -a "$TARGET_DIR/." "$BACKUP_DIR/"
  OLD_VER=$(grep "^version" "/var/apps/$APP_NAME/manifest" | awk '{print $3}')
  log "当前版本 $OLD_VER"
fi

# 2. install-local（后台跑，轮询超时 30 分钟）
log "启动 install-local"
systemd-run --unit="dsh-upgrade-$APP_NAME-$TS" --description="dsh upgrade $APP_NAME to $EXPECT_VER" \
  "$CLI" install-local --dir "$STAGE" --autostart yes --env "$ENV_FILE" &
UNIT="dsh-upgrade-$APP_NAME-$TS"

# 3. 轮询装后状态（最多 30 分钟）
UP_OK=0
for i in $(seq 1 60); do
  sleep 30
  if systemctl is-active "$UNIT" >/dev/null 2>&1; then
    if grep -q "^version.*$EXPECT_VER" "/var/apps/$APP_NAME/manifest" 2>/dev/null; then
      if pgrep -f "$APP_NAME/supervisor.js" >/dev/null; then
        log "新版本已就位且进程已拉起（第 $i 次检查）"
        UP_OK=1
        break
      fi
    fi
  else
    log "install-local unit 已结束（第 $i 次检查）"
    if grep -q "^version.*$EXPECT_VER" "/var/apps/$APP_NAME/manifest" 2>/dev/null && pgrep -f "$APP_NAME/supervisor.js" >/dev/null; then
      UP_OK=1
    fi
    break
  fi
done

# 4. 装后校验
if [ "$UP_OK" = 1 ]; then
  GUI_OK=0
  for i in $(seq 1 10); do
    sleep 30
    case "$APP_NAME" in
      dsh-fnos) PORT=3081;;
      dsh-fnos2) PORT=3091;;
      *) PORT=$(grep -o "FNOS_PORT.*" "/var/apps/$APP_NAME/cmd/main" 2>/dev/null | head -1 || echo 3081);;
    esac
    CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" 2>/dev/null || echo 000)
    if [ "$CODE" != "000" ]; then
      log "GUI 探针 http://127.0.0.1:$PORT/ → $CODE（升级成功）"
      GUI_OK=1
      break
    fi
  done
  if [ "$GUI_OK" = 1 ]; then
    log "升级完成：$APP_NAME → $EXPECT_VER"
    rm -f "$MARKER"
    exit 0
  fi
  log "GUI 探针 5 分钟未通，尝试兜底重装"
fi

# 5. 兜底：install-fpk 重装（能覆盖已装/半装状态）
log "兜底 install-fpk 重装"
if [ -n "$FPK_EXPLICIT" ] && [ -f "$FPK_EXPLICIT" ]; then
  FPK_FILE="$FPK_EXPLICIT"
else
  FPK_FILE=$(ls "$STAGE"/*.fpk "$(dirname "$STAGE")"/*.fpk "$(dirname "$STAGE")/../artifacts"/dsh-fnos*.fpk /vol1/1000/deepseek_harness/1dsh_dist/dsh-fnos/*/dsh-fnos*.fpk 2>/dev/null | head -1 || true)
fi
if [ -z "$FPK_FILE" ]; then
  log "找不到 fpk 产物，无法兜底；target 冷备在 $BACKUP_DIR"
  exit 1
fi
log "兜底使用 $FPK_FILE"
systemd-run --unit="dsh-upgrade-fpk-$APP_NAME-$TS" --description="dsh upgrade fallback install-fpk" \
  "$CLI" install-fpk "$FPK_FILE" -e "$ENV_FILE" &
FPK_UNIT="dsh-upgrade-fpk-$APP_NAME-$TS"
for i in $(seq 1 30); do
  sleep 30
  if ! systemctl is-active "$FPK_UNIT" >/dev/null 2>&1; then break; fi
done
if grep -q "^version.*$EXPECT_VER" "/var/apps/$APP_NAME/manifest" 2>/dev/null && pgrep -f "$APP_NAME/supervisor.js" >/dev/null; then
  log "兜底重装成功：$APP_NAME → $EXPECT_VER"
  rm -f "$MARKER"
  exit 0
fi
log "兜底重装也失败；target 冷备在 $BACKUP_DIR，请手动恢复"
exit 1
