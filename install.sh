#!/usr/bin/env bash
# 把 dsh-loop-breaker 装进 web profile（幂等）。
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROF="$HOME/.dsh/profiles/web"
BK="/nas/dsh/backups/loop-breaker-$(date +%Y%m%d-%H%M%S)"

echo "== 0. 备份 profile 清单 =="
mkdir -p "$BK"
cp -a "$PROF/package.json" "$BK/" 2>/dev/null || true
cp -a "$PROF/pnpm-lock.yaml" "$BK/" 2>/dev/null || true
echo "   → $BK"

echo "== 1. 安装到 profile（pnpm 转发）=="
dsh plugin --profile web add "$SRC"

echo "== 2. 核对 bundles 列表 =="
python3 -c "
import json;d=json.load(open('$PROF/package.json'))
print('   bundles:', d['dsh']['profile']['bundles'])
print('   deps 里有 dsh-loop-breaker:', 'dsh-loop-breaker' in (d.get('dependencies') or {}))
"

echo "== 3. 组合配置自检（会真正加载插件，出错即暴露）=="
dsh --profile web --dump-config 2>&1 | grep -A6 "loop-breaker" || echo "   ⚠️ 未在配置树里找到 loop-breaker"

echo
echo "== 完成 =="
echo "   生效需要重启 dsh web： dsh-restart   （会短暂断开网页，会话不丢）"
