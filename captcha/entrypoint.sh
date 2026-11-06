#!/bin/sh
# CAPTCHA_HEADFUL=1：在 Xvfb 虚拟显示里以有头模式运行浏览器（无头被识别时再开）
set -e
if [ "${CAPTCHA_HEADFUL:-0}" = "1" ]; then
  exec xvfb-run -a -s "-screen 0 1280x800x24" node server.mjs
fi
exec node server.mjs
