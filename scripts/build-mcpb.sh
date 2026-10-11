#!/usr/bin/env bash
# Builds the Claude Desktop extension: release/wise-mcp-<version>.mcpb
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p 'require("./package.json").version')
OUT=build/mcpb
rm -rf "$OUT" && mkdir -p "$OUT" release
npm run build --silent
cp -R dist public package.json package-lock.json LICENSE "$OUT"/
cp public/logo.png "$OUT"/icon.png  # 512×512, the size Claude Desktop recommends
node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync("mcpb/manifest.json","utf8"));m.version=process.argv[1];fs.writeFileSync(process.argv[2],JSON.stringify(m,null,2)+"\n")' "$VERSION" "$OUT/manifest.json"
(cd "$OUT" && npm ci --omit=dev --ignore-scripts --silent)
npx -y @anthropic-ai/mcpb@2.1.2 validate "$OUT/manifest.json"
npx -y @anthropic-ai/mcpb@2.1.2 pack "$OUT" "release/wise-mcp-$VERSION.mcpb"
echo "Built release/wise-mcp-$VERSION.mcpb"
