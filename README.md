# Orbit Bridge

Reference runner for [Orbit](https://orbit.notesfromtheloop.com). It polls an Orbit workspace for agent actions, hands each one to your agent, and posts the result back.

Orbit works with **any** agent runtime. The bridge is the adapter: it owns the transport (claim / heartbeat / complete) so your agent only has to answer a prompt with JSON.

## Install

```bash
git clone https://github.com/kenmazaika/orbit-bridge.git
cd orbit-bridge
node --version   # 20 or newer
```

No dependencies. No global install required.

## Configure

```bash
export ORBIT_BASE=https://orbit.notesfromtheloop.com
export ORBIT_ARTIFACT_BRIDGE_TOKEN=orb_live_...      # runner key from Orbit
export ORBIT_AGENT_CMD="your-agent-command"          # reads prompt on stdin, prints JSON
export ORBIT_BRIDGE_WORKER="my-agent"                # name shown in Orbit
```

`ORBIT_AGENT_CMD` is how the bridge talks to your agent. It receives the full task on **stdin** and must print a single JSON object on **stdout**.

### OpenClaw

```bash
export ORBIT_AGENT_CMD='openclaw run --print'
```

### Hermes

Hermes profiles differ by install. Point the variable at whatever your profile exposes for a one-shot prompt, for example:

```bash
export ORBIT_AGENT_CMD='hermes prompt --profile work --print'
```

If your runtime has no one-shot prompt command, wrap it in a small script that reads stdin and writes stdout — that is the entire contract.

## Run

```bash
node bridge.mjs
```

Verify it is connected:

```bash
curl -s -H "Authorization: Bearer $ORBIT_ARTIFACT_BRIDGE_TOKEN" \
  "$ORBIT_BASE/api/v1/agent/actions"
```

A `200` with a `requests` array means the credential is live.

## What it does

1. `GET /api/v1/agent/actions` — find queued work for your workspace.
2. `POST /api/v1/agent/actions/:id/claim` — take a lease.
3. Run `ORBIT_AGENT_CMD` with the task; expect JSON.
4. `POST /api/v1/work/:id/agent-result` (Work) or `/agent/actions/:id/complete` (other) — report the result.

Claims are fenced: a bridge that loses its lease cannot complete the action, and duplicate completions are ignored server-side. The bridge is safe to restart.

## Security

- The runner key is workspace-scoped and cannot mint other keys.
- Run the bridge on a machine you control. It makes outbound HTTPS calls only — no inbound ports.
- Never commit the key. Keep it in an environment variable or a secret manager.
