#!/usr/bin/env bash
cd "$(dirname "$0")"
bash cdp-patch.sh Remove --wait
read -rp "操作完成，按回车关闭窗口..." _
