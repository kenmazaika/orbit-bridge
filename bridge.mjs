#!/usr/bin/env node
/**
 * Orbit reference bridge.
 * Polls a workspace for agent actions, hands each to ORBIT_AGENT_CMD, posts results.
 *
 * Env: ORBIT_BASE, ORBIT_ARTIFACT_BRIDGE_TOKEN, ORBIT_AGENT_CMD,
 *      ORBIT_BRIDGE_WORKER, ORBIT_BRIDGE_INTERVAL_MS,
 *      ORBIT_PUBLISH_ENABLED (optional, "1" to allow artifact.publish)
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
const enc = encodeURIComponent;

async function call(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'orbit-bridge/0.2',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text || '{}'); } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error || data.raw || ''}`);
  return data;
}

/** Run the agent command; it reads the prompt on stdin and prints one JSON object. */
function runAgent(prompt, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', CMD], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('agent timeout')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`agent exited ${code}: ${err.slice(-300)}`));
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) return reject(new Error('agent produced no JSON'));
      try { resolve(JSON.parse(m[0])); } catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
    });
    child.stdin.end(prompt);
  });
}

const JSON_RULES = `Return ONLY one JSON object, no prose outside it. Never claim work you did not do; if something failed, say so in "reply".`;

// ---------------------------------------------------------------- prompts ---

function workPrompt(a) {
  return `You are an agent working inside Orbit (${BASE}).
Action: ${a.action}
Work session: ${a.work_id || '(none)'}
Task input:
${JSON.stringify(a.input || a.payload || {}, null, 2)}

Respond with:
{"reply":"<short markdown note>","plan":{"goal":"","rationale":"","steps":[{"title":"","detail":""}]},"interaction":null,"result":{"summary":"","verified":[],"links":[],"remaining":""},"state":"awaiting_direction|working|completed|awaiting_feedback"}

Rules: a planning action returns a 2-5 step plan with state "awaiting_direction"; an execution action does the work and returns a result with state "completed". Put verification in the final step. ${JSON_RULES}`;
}

function artifactPrompt(a) {
  const review = (a.result_kind || 'revision') === 'review';
  const critique = (a.critique?.findings || []).map((f, i) =>
    `${i + 1}. [${f.category || 'finding'}] ${f.summary || ''}${f.explanation ? ` — ${f.explanation}` : ''}`).join('\n');
  return `You are editing a document inside Orbit (${BASE}).
Action: ${a.kind || 'feedback'}${a.workflow ? ` (workflow: ${a.workflow})` : ''}
Document: ${a.article_title || a.article_id}

CURRENT DOCUMENT
<<<DOC
${String(a.base?.markdown || a.markdown || '').slice(0, 60000)}
DOC>>>

REQUEST
${a.text || a.instructions || '(see critique)'}

${critique ? `CRITIQUE FINDINGS\n${critique}` : ''}

${review
  ? `You are reviewing, not rewriting. Return:
{"reply":"<short note>","review":{"summary":"","findings":[{"id":"finding-1","category":"","summary":"","explanation":"","anchors":[]}]}}`
  : `Return the complete revised document, not a diff:
{"reply":"<short note>","markdown":"<full document>","dispositions":[{"findingId":"finding-1","status":"addressed|retained|unresolved","note":""}]}`}

${JSON_RULES}`;
}

function inboxPrompt(a) {
  return `An Orbit inbox decision has been approved (${BASE}).
Item: ${a.title || a.id}
Selected: ${JSON.stringify(a.choices || a.actions || [])}
Instruction: ${a.instruction || a.text || '(none)'}
Body:
${String(a.body || '').slice(0, 20000)}

Carry out the approved action and report what you actually did.
Return: {"reply":"<markdown report>"}
${JSON_RULES}`;
}

function mastheadPrompt(a) {
  return `Generate a masthead image for a document in Orbit (${BASE}).
Document: ${a.article_title || a.article_id}
Direction: ${a.options?.instructions || a.text || 'clean editorial header'}

Return the image inline:
{"reply":"<short note>","asset":{"filename":"masthead.png","mime":"image/png","dataBase64":"<base64 bytes>"}}
${JSON_RULES}`;
}

function publishPrompt(a) {
  return `Publish a document from Orbit (${BASE}).
Document: ${a.article_title || a.article_id}
Target: ${JSON.stringify(a.options || {})}

Return:
{"reply":"<short note>","publication":{"url":"","status":"published"}}
${JSON_RULES}`;
}

// --------------------------------------------------------------- handlers ---

const handlers = {
  'work.plan': workAction,
  'work.explore': workAction,
  'work.execute': workAction,
  'artifact.feedback': artifactAction,
  'artifact.workflow': artifactAction,
  'artifact.masthead': mastheadAction,
  'artifact.publish': publishAction,
  'inbox.decision': inboxAction,
};

async function workAction(a, token) {
  const out = await runAgent(workPrompt(a));
  await call(`/work/${enc(a.work_id)}/agent-result`, 'POST', {
    actionId: a.id,
    reply: out.reply || '',
    plan: out.plan || null,
    interaction: out.interaction || null,
    result: out.result || null,
    state: out.state || 'working',
    token,
  });
}

async function artifactAction(a, token) {
  const out = await runAgent(artifactPrompt(a));
  if (out.reply) await call(`/agent/actions/${enc(a.id)}/progress`, 'POST', { status: 'working', reply: out.reply, token });

  if (out.review && Array.isArray(out.review.findings)) {
    await call(`/artifacts/${enc(a.article_id)}/reviews`, 'POST', {
      revisionId: a.base?.id || null,
      workflow: a.workflow || 'review',
      actionId: a.id,
      summary: out.review.summary || '',
      findings: out.review.findings,
    });
    return call(`/agent/actions/${enc(a.id)}/complete`, 'POST', { reply: out.reply || '', revisionId: null, token, dispositions: out.dispositions || [] });
  }

  let revisionId = null;
  if (out.markdown) {
    const r = await call(`/artifacts/${enc(a.article_id)}/revisions`, 'POST', {
      id: `revision_action_${a.id}`,
      markdown: out.markdown,
      source: a.kind || 'feedback',
      expectedRevisionId: a.base?.id || null,
    });
    revisionId = r.revision?.id || null;
  }
  await call(`/agent/actions/${enc(a.id)}/complete`, 'POST', { reply: out.reply || '', revisionId, token, dispositions: out.dispositions || [] });
}

async function inboxAction(a, token) {
  const out = await runAgent(inboxPrompt(a));
  if (out.reply) await call(`/agent/actions/${enc(a.id)}/progress`, 'POST', { status: 'working', reply: out.reply, token });
  await call(`/agent/actions/${enc(a.id)}/complete`, 'POST', { reply: out.reply || '', token });
}

async function mastheadAction(a, token) {
  const out = await runAgent(mastheadPrompt(a));
  const asset = out.asset || {};
  if (!asset.dataBase64) throw new Error('masthead_missing: agent returned no image bytes');
  const uploaded = await call(`/artifacts/${enc(a.article_id)}/images`, 'POST', {
    filename: asset.filename || 'masthead.png',
    mime: asset.mime || 'image/png',
    dataBase64: asset.dataBase64,
    role: 'masthead',
    assetState: 'active',
    provider: a.options?.provider || 'bridge',
    referenceAssetId: a.options?.referenceAssetId || undefined,
    revisionId: a.base?.id || undefined,
    instruction: a.options?.instructions || a.text || undefined,
  });
  await call(`/agent/actions/${enc(a.id)}/complete`, 'POST', { reply: out.reply || '', assetId: uploaded.id, token });
}

async function publishAction(a, token) {
  if (process.env.ORBIT_PUBLISH_ENABLED !== '1') throw new Error('publish_not_enabled: set ORBIT_PUBLISH_ENABLED=1 to allow publishing');
  if (a.options?.confirm !== true) throw new Error('publish_not_confirmed: resubmit with options.confirm = true');
  const out = await runAgent(publishPrompt(a));
  if (!out.publication?.url) throw new Error('publish_failed: agent returned no publication url');
  await call(`/artifacts/${enc(a.article_id)}/publication`, 'POST', {
    status: 'published', revisionId: a.base?.id, detail: { reply: out.reply, url: out.publication.url },
  });
  await call(`/agent/actions/${enc(a.id)}/complete`, 'POST', { reply: out.reply || '', token });
}

async function processAction(a) {
  const claimed = await call(`/agent/actions/${enc(a.id)}/claim`, 'POST', {});
  const token = claimed.claim_token || claimed.token;
  const handler = handlers[a.action];
  if (!handler) throw new Error(`no handler for ${a.action}`);
  await handler(a, token);
  console.log(`[${new Date().toISOString()}] ${a.action} ${a.id} done`);
}

// -------------------------------------------------------------------- loop ---

async function main() {
  console.log(`orbit-bridge ${WORKER} -> ${BASE}`);
  let backoff = INTERVAL;
  for (;;) {
    try {
      const { requests = [] } = await call('/agent/actions');
      for (const a of requests) {
        try { await processAction(a); }
        catch (e) {
          console.error(`action ${a.id} failed: ${e.message}`);
          try { await call(`/agent/actions/${enc(a.id)}/fail`, 'POST', { error: e.message, retryable: true }); } catch {}
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
