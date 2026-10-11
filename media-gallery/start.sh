#!/usr/bin/env bash
# macOS / Linux 一键启动
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "未检测到 Node.js，请先安装：https://nodejs.org"; exit 1; }
exec node server.js
