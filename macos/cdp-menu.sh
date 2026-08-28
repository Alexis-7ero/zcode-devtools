#!/usr/bin/env bash
# ZCode DevTools 交互菜单（macOS）—— 双击 Menu.command 或 bash cdp-menu.sh
cd "$(dirname "$0")"

while true; do
  clear
  echo "+------------------------------------------+"
  echo "|   ZCode DevTools  -  CDP Patch (macOS)   |"
  echo "+------------------------------------------+"
  echo "|   [1] 安装 / 重装补丁（自动退出ZCode）   |"
  echo "|   [2] 备份当前原版文件                   |"
  echo "|   [3] 卸载补丁（自动退出ZCode+还原）     |"
  echo "|   [4] 查看补丁状态                       |"
  echo "|   [0] 退出                               |"
  echo "+------------------------------------------+"
  read -rp "请选择: " ch
  case "$ch" in
    1) bash reinstall.sh ;;
    2) bash cdp-patch.sh Backup ;;
    3) bash cdp-patch.sh Remove --wait ;;
    4) bash cdp-patch.sh Status ;;
    0) exit 0 ;;
  esac
  echo ""
  read -rp "操作完成，按回车返回菜单..." _
done
