#!/usr/bin/env bash
# Ghost Tower on one Brev GPU box: vLLM (Nemotron) + classifier + Cloudflare quick tunnel + agent.
#
#   bash deploy/brev/start.sh                start whatever is not already running (safe to re-run)
#   bash deploy/brev/start.sh status         what is up, plus the public /score URL
#   bash deploy/brev/start.sh stop           stop agent, tunnels, classifier, vLLM
#   bash deploy/brev/start.sh install-cron   run `start` on every boot (instance restart = everything back)
#
# The agent talks to vLLM over localhost, so only the classifier needs a public URL (phones POST /score).
# Quick-tunnel URLs are random and change on every restart: the script prints the new one.
# Set TUNNEL_LLM=1 to also expose vLLM (e.g. for an agent on a laptop). Anyone with that URL can use the GPU.
#
# Needs: the repo cloned on the box with a filled-in .env at the repo root (see .env.example).
# Values here override .env: NEMOTRON_PROVIDER=brev and BREV_BASE_URL=http://127.0.0.1:$LLM_PORT/v1.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="${GHOST_STATE:-$HOME/.ghost-tower}"
MODEL="${MODEL:-nvidia/NVIDIA-Nemotron-Nano-3-30B-A3B-FP8}"
LLM_PORT="${LLM_PORT:-5000}"
SCORE_PORT="${SCORE_PORT:-8001}"
TUNNEL_LLM="${TUNNEL_LLM:-0}"
NODE_MIN="22.23.4"
mkdir -p "$STATE"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
pidfile() { echo "$STATE/$1.pid"; }
running() { local p; p="$(cat "$(pidfile "$1")" 2>/dev/null)" && [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
listening() { curl -s -m 2 -o /dev/null "http://127.0.0.1:$1$2"; }
# Each service gets its own process group (setsid), so `stop` also ends children (npm -> tsx -> node).
SETSID=""; command -v setsid >/dev/null && SETSID="setsid"

wait_http() { # name port path timeout_s
  local i
  for ((i = 0; i < $4; i += 2)); do
    listening "$2" "$3" && return 0
    sleep 2
  done
  return 1
}

# --- Node ≥ 22.23.4 (via nvm if the system one is missing or too old) ---
node_ok() { command -v node >/dev/null && [ "$(printf '%s\n%s\n' "$NODE_MIN" "$(node -v | tr -d v)" | sort -V | head -1)" = "$NODE_MIN" ]; }
ensure_node() {
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null
  node_ok && return
  log "Node ≥$NODE_MIN not found; installing with nvm"
  if [ ! -s "$HOME/.nvm/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null || die "nvm install failed"
  fi
  . "$HOME/.nvm/nvm.sh"
  nvm install 22 >/dev/null && nvm alias default 22 >/dev/null
  node_ok || die "Node $(node -v 2>/dev/null) is older than $NODE_MIN"
}

# --- cloudflared (official release binary) ---
ensure_cloudflared() {
  command -v cloudflared >/dev/null && { CLOUDFLARED=cloudflared; return; }
  CLOUDFLARED="$STATE/cloudflared"
  [ -x "$CLOUDFLARED" ] && return
  local arch
  case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64 | arm64) arch=arm64 ;; *) die "unknown arch $(uname -m)" ;; esac
  log "Downloading cloudflared ($arch)"
  curl -fsSL -o "$CLOUDFLARED" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch" || die "cloudflared download failed"
  chmod +x "$CLOUDFLARED"
}

start_vllm() {
  if listening "$LLM_PORT" /v1/models; then log "vLLM already up on :$LLM_PORT"; return; fi
  local bin="${VLLM_BIN:-$(command -v vllm)}"
  [ -n "$bin" ] || die "vllm not on PATH (set VLLM_BIN=/path/to/vllm)"
  log "Starting vLLM ($MODEL); loading takes 1-3 min"
  # Flags that worked on the RTX PRO 6000 (vLLM 0.31): Triton attention and no FlashInfer sampler (no nvcc on the box).
  VLLM_USE_FLASHINFER_SAMPLER=0 $SETSID nohup "$bin" serve "$MODEL" --trust-remote-code \
    --served-model-name nemotron --host 0.0.0.0 --port "$LLM_PORT" \
    --enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser deepseek_r1 \
    --attention-backend TRITON_ATTN --kv-cache-dtype auto --max-model-len 32768 \
    >"$STATE/vllm.log" 2>&1 &
  echo $! >"$(pidfile vllm)"
  wait_http vllm "$LLM_PORT" /v1/models 600 || die "vLLM did not come up in 10 min; see $STATE/vllm.log"
  log "vLLM up"
}

start_classifier() {
  if listening "$SCORE_PORT" /health; then log "Classifier already up on :$SCORE_PORT"; return; fi
  local py="$STATE/venv/bin/python"
  if [ ! -x "$py" ]; then
    log "Creating classifier venv"
    python3 -m venv "$STATE/venv" || die "python3 -m venv failed (try: sudo apt-get install -y python3-venv)"
  fi
  "$py" -c "import sklearn, numpy, joblib" 2>/dev/null || "$py" -m pip install -q -r "$REPO/classifier/requirements.txt" || die "classifier pip install failed"
  log "Starting classifier on :$SCORE_PORT"
  $SETSID nohup "$py" "$REPO/classifier/server.py" --host 127.0.0.1 --port "$SCORE_PORT" >"$STATE/classifier.log" 2>&1 &
  echo $! >"$(pidfile classifier)"
  wait_http classifier "$SCORE_PORT" /health 60 || die "classifier did not start; see $STATE/classifier.log"
}

tunnel_url() { grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$STATE/tunnel-$1.log" 2>/dev/null | head -1; }

start_tunnel() { # name port
  if running "tunnel-$1" && [ -n "$(tunnel_url "$1")" ]; then log "Tunnel $1 already up: $(tunnel_url "$1")"; return; fi
  : >"$STATE/tunnel-$1.log"
  $SETSID nohup "$CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:$2" >"$STATE/tunnel-$1.log" 2>&1 &
  echo $! >"$(pidfile "tunnel-$1")"
  local i
  for ((i = 0; i < 30; i++)); do [ -n "$(tunnel_url "$1")" ] && break; sleep 1; done
  [ -n "$(tunnel_url "$1")" ] || die "no tunnel URL for $1; see $STATE/tunnel-$1.log"
  tunnel_url "$1" >"$STATE/$1_url"
  log "Tunnel $1: $(tunnel_url "$1")"
}

start_agent() {
  if running agent; then log "Agent already running (pid $(cat "$(pidfile agent)"))"; return; fi
  [ -f "$REPO/.env" ] || die "missing $REPO/.env (copy .env.example and fill in Spacetime/Twilio)"
  [ -x "$REPO/agent/node_modules/.bin/tsx" ] || (cd "$REPO/agent" && npm ci --no-audit --no-fund >/dev/null) || die "npm ci in agent/ failed"
  log "Starting agent"
  (cd "$REPO/agent" && NEMOTRON_PROVIDER=brev BREV_BASE_URL="http://127.0.0.1:$LLM_PORT/v1" BREV_MODEL=nemotron \
    $SETSID nohup npm start >"$STATE/agent.log" 2>&1 &
    echo $! >"$(pidfile agent)")
  sleep 3
  running agent || die "agent exited; see $STATE/agent.log"
}

stop_one() {
  local f p
  f="$(pidfile "$1")"
  p="$(cat "$f" 2>/dev/null)" || return 0
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
    [ -n "$SETSID" ] && kill -TERM -- "-$p" 2>/dev/null
    pkill -TERM -P "$p" 2>/dev/null
    kill "$p" 2>/dev/null
    log "Stopped $1"
  fi
  rm -f "$f"
}

status() {
  for n in vllm classifier tunnel-score tunnel-llm agent; do
    if running "$n"; then echo "  $n: running (pid $(cat "$(pidfile "$n")"))"; else echo "  $n: -"; fi
  done
  listening "$LLM_PORT" /v1/models && echo "  vLLM answering on :$LLM_PORT" || echo "  vLLM not answering on :$LLM_PORT"
  [ -s "$STATE/score_url" ] && echo "  /score URL: $(cat "$STATE/score_url")/score"
  [ -s "$STATE/llm_url" ] && running tunnel-llm && echo "  vLLM URL:   $(cat "$STATE/llm_url")/v1"
  echo "  logs: $STATE/{vllm,classifier,tunnel-score,agent}.log"
}

summary() {
  local url
  url="$(cat "$STATE/score_url")"
  curl -s -m 15 -X POST "$url/score" -H 'Content-Type: application/json' -d '{"text":"TxTag: unpaid toll. Pay now: txtag-pay-demo.example"}' | grep -q '"score"' &&
    log "Public /score check passed" || log "WARNING: public /score did not answer yet (new tunnels can take a few seconds)"
  cat <<EOF

Ghost Tower is up on this box.
  Phones' classifier URL: $url/score
  Rebuild the APK with it:   cd android && ./gradlew assembleDebug -PscoreUrl=$url/score
  (Phones on an old URL still work: they fall back to score 0.97 when /score is unreachable.)
EOF
  [ "$TUNNEL_LLM" = 1 ] && echo "  vLLM for laptops: BREV_BASE_URL=$(cat "$STATE/llm_url")/v1"
  echo "  Status: bash $REPO/deploy/brev/start.sh status    Stop: bash $REPO/deploy/brev/start.sh stop"
}

install_cron() {
  ensure_node
  local vbin="${VLLM_BIN:-$(command -v vllm)}"
  [ -n "$vbin" ] || die "vllm not on PATH (set VLLM_BIN=/path/to/vllm)"
  local line="@reboot VLLM_BIN=$vbin PATH=$(dirname "$(command -v node)"):$(dirname "$vbin"):/usr/local/bin:/usr/bin:/bin TUNNEL_LLM=$TUNNEL_LLM bash $REPO/deploy/brev/start.sh >>$STATE/boot.log 2>&1"
  (crontab -l 2>/dev/null | grep -v 'deploy/brev/start.sh'; echo "$line") | crontab -
  log "Installed @reboot entry; after a restart, check: bash $REPO/deploy/brev/start.sh status"
}

case "${1:-start}" in
  start)
    ensure_node
    ensure_cloudflared
    start_vllm
    start_classifier
    start_tunnel score "$SCORE_PORT"
    [ "$TUNNEL_LLM" = 1 ] && start_tunnel llm "$LLM_PORT"
    start_agent
    summary
    ;;
  stop) for n in agent tunnel-score tunnel-llm classifier vllm; do stop_one "$n"; done ;;
  status) status ;;
  install-cron) install_cron ;;
  *) die "usage: $0 [start|status|stop|install-cron]" ;;
esac
