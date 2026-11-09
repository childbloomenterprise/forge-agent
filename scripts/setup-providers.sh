#!/usr/bin/env bash
# Registers Gemini (primary) and Groq (fallback) in a local TrueForge. Keys come from .env, never from the repo.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
TF="${TRUEFORGE_URL:-http://localhost:8790}"
put() { curl -fsS -X PUT "$TF/api/v1/settings/model-providers" -H 'content-type: application/json' -d "$1" >/dev/null && echo "registered $2"; }
if [ -n "${GEMINI_API_KEY:-}" ]; then
  put "{\"manifest\":{\"type\":\"google-gemini\",\"name\":\"google-gemini\",\"auth\":{\"api_key\":\"$GEMINI_API_KEY\"},\"models\":[{\"model_id\":\"gemini-3.5-flash\",\"name\":\"gemini-3-5-flash\",\"properties\":{\"context_length\":1048576,\"max_output_tokens\":65536}}]}}" google-gemini
fi
if [ -n "${GROQ_API_KEY:-}" ]; then
  put "{\"manifest\":{\"type\":\"custom\",\"name\":\"groq\",\"base_url\":\"https://api.groq.com/openai/v1\",\"auth\":{\"api_key\":\"$GROQ_API_KEY\"},\"models\":[{\"model_id\":\"qwen/qwen3.8-27b\",\"name\":\"qwen3-8-27b\",\"properties\":{\"context_length\":131072,\"max_output_tokens\":8192}}]}}" groq
fi
curl -fsS "$TF/api/v1/models" | python3 -c 'import json,sys; [print(" ", m.get("name") or m.get("id")) for m in json.load(sys.stdin)["data"]]'
