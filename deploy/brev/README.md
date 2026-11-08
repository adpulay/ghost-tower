# Run Ghost Tower on the Brev box

One script starts everything on the GPU instance:

| Piece | Port | Reached by |
|---|---|---|
| vLLM serving Nemotron | 5000 | the agent, over localhost |
| Classifier `/score` | 8001 | phones, through a Cloudflare quick tunnel (`https://…trycloudflare.com`) |
| Agent service | none | outbound only (Maincloud, Twilio) |

## First time

```bash
git clone https://github.com/adpulay/ghost-tower && cd ghost-tower
cp .env.example .env    # fill in Spacetime and Twilio; NEMOTRON_PROVIDER/BREV_BASE_URL are set by the script
bash deploy/brev/start.sh
bash deploy/brev/start.sh install-cron   # optional: start everything on every boot
```

It installs Node (nvm) and `cloudflared` if they are missing, creates a venv for the classifier,
and is safe to re-run: anything already up is left alone.

## Every restart

The quick-tunnel URL is random and **changes every time**. The script prints the new one and the
APK rebuild command (`./gradlew assembleDebug -PscoreUrl=<url>/score`). A phone with an old URL still
reports, using the fallback score 0.97.

```bash
bash deploy/brev/start.sh status   # what's up, current /score URL, log paths (~/.ghost-tower/)
bash deploy/brev/start.sh stop
```

`TUNNEL_LLM=1` also exposes vLLM publicly (for an agent running on a laptop). Anyone with that URL can
use the GPU, so turn it off and stop the instance after judging.
