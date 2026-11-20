#!/usr/bin/env node
/**
 * Orbit reference bridge.
 * Polls a workspace for agent actions, hands each to ORBIT_AGENT_CMD, posts results.
 * Environment: ORBIT_BASE, ORBIT_ARTIFACT_BRIDGE_TOKEN, ORBIT_AGENT_CMD,
 *              ORBIT_BRIDGE_WORKER, ORBIT_BRIDGE_INTERVAL_MS
 */
import { spawn } from 'node:child_process';

const BASE = (process.env.ORBIT_BASE || '').replace(/\/$/, '');
const TOKEN = process.env.ORBIT_ARTIFACT_BRIDGE_TOKEN || process.env.ORBIT_TOKEN || '';
const CMD = process.env.ORBIT_AGENT_CMD || '';
const WORKER = process.env.ORBIT_BRIDGE_WORKER || 'orbit-bridge';
const INTERVAL = Number(process.env.ORBIT_BRIDGE_INTERVAL_MS || 4000);

if (!BASE || !TOKEN || !CMD) {
  console.error('Missing ORBIT_BASE, ORBIT_ARTIFACT_BRIDGE_TOKEN or ORBIT_AGENT_CMD. See README.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'orbit-bridge/0.1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text || '{}'); } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error || data.raw || ''}`);
  return data;
}

function runAgent(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', CMD], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('agent timeout')); }, 10 * 60 * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`agent exited ${code}: ${err.slice(-300)}`));
      const match = out.match(/\{[\s\S]*\}/);
      if (!match) return reject(new Error('agent produced no JSON'));
      try { resolve(JSON.parse(match[0])); } catch (e) { reject(new Error(`bad JSON from agent: ${e.message}`)); }
    });
    child.stdin.end(prompt);
  });
}

function promptFor(action) {
  return `You are an agent working inside Orbit (${BASE}).

Action: ${action.action}
Workspace work id: ${action.work_id || '(none)'}
Task input:
${JSON.stringify(action.input || action.payload || {}, null, 2)}

Respond with ONE JSON object and nothing else:
{"reply":"<short markdown note>","plan":{"goal":"","rationale":"","steps":[{"title":"","detail":""}]},"interaction":null,"result":{"summary":"","verified":[],"links":[],"remaining":""},"state":"awaiting_direction|working|completed|awaiting_feedback"}

Rules:
- For a planning action: return a 2-5 step plan and state "awaiting_direction".
- For an execution action: do the work, return a result and state "completed".
- Never claim success you did not verify. If something fails, say so in reply.
- Do not include prose outside the JSON object.`;
}

async function handle(action) {
  const claimed = await call(`/api/v1/agent/actions/${action.id}/claim`, 'POST', {});
  const token = claimed.claim_token || claimed.token;
  const out = await runAgent(promptFor(action));

  if (action.work_id) {
    await call(`/api/v1/work/${action.work_id}/agent-result`, 'POST', {
      actionId: action.id,
      reply: out.reply || '',
      plan: out.plan || null,
      interaction: out.interaction || null,
      result: out.result || null,
      state: out.state || 'working',
      token,
    });
  } else {
    await call(`/api/v1/agent/actions/${action.id}/complete`, 'POST', {
      reply: out.reply || JSON.stringify(out), token,
    });
  }
  console.log(`[${new Date().toISOString()}] ${action.action} ${action.id} done`);
}

async function main() {
  console.log(`orbit-bridge ${WORKER} -> ${BASE}`);
  let backoff = INTERVAL;
  for (;;) {
    try {
      const { requests = [] } = await call('/api/v1/agent/actions');
      for (const action of requests) {
        try { await handle(action); }
        catch (e) {
          console.error(`action ${action.id} failed: ${e.message}`);
          try { await call(`/api/v1/agent/actions/${action.id}/fail`, 'POST', { error: e.message, retryable: true }); } catch {}
        }
      }
      backoff = INTERVAL;
    } catch (e) {
      console.error(`poll: ${e.message}`);
      backoff = Math.min(backoff * 2, 60000);
    }
    await sleep(backoff);
  }
}

main();
