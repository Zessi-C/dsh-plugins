#!/usr/bin/env node
/**
 * Ask a CLIProxyAPI-style gateway which thinking levels a model actually
 * supports, and whether they change how much it thinks.
 *
 * DSH cannot answer this from configuration: a route's `reasoningEfforts` is
 * what *you* declare, the installed catalog has no entry for a hand-declared
 * route, and neither `GET /v1/models` nor DSH's own `llm.discoverModels`
 * carries any per-model capability metadata — both return ids and capacities
 * only.
 *
 * The gateway, however, knows. CLIProxyAPI keeps a per-model `thinking.levels`
 * table (`internal/registry/models/models.json`, plus a capability fetch for
 * Antigravity home models) and uses it to validate `reasoning_effort`; when a
 * level is not in the table it answers 400 with the table inline:
 *
 *     level "bogus" not supported, valid levels: low, medium, high
 *
 * So one deliberately-invalid request per model reveals the authoritative set,
 * with no management key and no source checkout. This tool does exactly that,
 * then optionally measures each level to show whether it has any effect.
 *
 * Usage:
 *   node tools/probe-levels.mjs <baseURL> <model> [<model>...]
 *   node tools/probe-levels.mjs https://gateway.example.com/v1 some-model --reps 3
 *
 * The API key comes from the `*_API_KEY` entries of
 * `~/.dsh/.credentials.yaml`, or from `--key <value>`.
 *
 * Two different things are reported, and they are not the same:
 *   - "accepted" — the level the gateway's own table lists for that model.
 *   - "thinking" — `reasoning_tokens` in the answer. A level can be accepted
 *     and change nothing at all, which is what a model whose reasoning is not
 *     driven by this field looks like.
 *
 * A level outside the table is not an error on a cross-family request: this
 * gateway *clamps* it to the nearest supported level, which is why `xhigh` and
 * `max` look identical to `high` and `minimal` looks identical to `low`.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A level no gateway accepts, used to make the table reveal itself. */
const BOGUS = 'dsh-probe-invalid-level';

/** A prompt that makes a reasoning model actually spend thinking tokens. */
const PROMPT = 'A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How much is the ball? Answer with the number only.';

/**
 * A descriptive User-Agent. Some gateways sit behind a CDN that rejects
 * library-default agents outright, which would otherwise look like an
 * unreachable endpoint.
 */
const USER_AGENT = 'dsh-model-thinking-levels/1.0 (+https://github.com/Zessi-C/dsh-model-thinking-levels)';

/** Read the first credential whose name matches, so any provider works. */
function credentialFromHome() {
  let text;
  try {
    text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
  } catch {
    return undefined;
  }
  const match = text.match(/^\s*([A-Za-z0-9_]*API_KEY)\s*:\s*(\S+)\s*$/m);
  return match === null ? undefined : { name: match[1], value: match[2].replace(/^["']|["']$/g, '') };
}

/** One completion, reporting the status and how much thinking it took. */
async function ask(baseURL, key, model, level, maxTokens = 64) {
  const body = { model, messages: [{ role: 'user', content: PROMPT }], max_tokens: maxTokens };
  // `off` is pi-ai's "supported, send no thinking field at all".
  if (level !== null) body.reasoning_effort = level;
  let response;
  try {
    response = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { status: 0, detail: String(error?.message ?? error) };
  }
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text)?.error?.message ?? message;
    } catch {
      // Not JSON; the raw slice is the best available detail.
    }
    return { status: response.status, detail: message };
  }
  let tokens;
  try {
    tokens = JSON.parse(text)?.usage?.completion_tokens_details?.reasoning_tokens;
  } catch {
    tokens = undefined;
  }
  return { status: response.status, tokens };
}

/**
 * The gateway's own table for one model, read out of the error it returns for
 * a level it does not list. `undefined` means it accepted the bogus level,
 * which no table-driven gateway should.
 */
async function declaredLevels(baseURL, key, model) {
  const answer = await ask(baseURL, key, model, BOGUS, 4);
  if (answer.status === 200) return { kind: 'accepted-bogus' };
  const detail = answer.detail ?? '';
  const listed = detail.match(/valid levels:\s*(.+?)\s*$/i);
  if (listed !== null) return { kind: 'levels', levels: listed[1].split(',').map((entry) => entry.trim()).filter(Boolean) };
  if (/thinking not supported/i.test(detail)) return { kind: 'none' };
  return { kind: 'other', detail };
}

const argv = process.argv.slice(2);
let explicitKey;
let reps = 2;
const rest = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--key') {
    explicitKey = argv[index + 1];
    index += 1;
    continue;
  }
  if (argv[index] === '--reps') {
    reps = Number(argv[index + 1]);
    index += 1;
    continue;
  }
  rest.push(argv[index]);
}
const [baseURL, ...models] = rest;

if (baseURL === undefined || models.length === 0) {
  console.error('usage: node tools/probe-levels.mjs <baseURL> <model> [<model>...] [--key <value>] [--reps <n>]');
  process.exit(2);
}

const credential = explicitKey === undefined ? credentialFromHome() : { name: '--key', value: explicitKey };
if (credential === undefined) {
  console.error('no credential found in ~/.dsh/.credentials.yaml; pass --key <value>');
  process.exit(2);
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

console.log(`gateway  ${baseURL}`);
console.log(`credential  ${credential.name}\n`);

for (const model of models) {
  console.log(model);
  const table = await declaredLevels(baseURL, credential.value, model);

  if (table.kind === 'none') {
    console.log('  → 该模型不支持思考档位（网关："thinking not supported for this model"）');
    console.log('    在 DSH 里应声明 reasoningEfforts: false\n');
    continue;
  }
  if (table.kind === 'other') {
    console.log(`  → 网关没有给出档位表：${table.detail}\n`);
    continue;
  }
  if (table.kind === 'accepted-bogus') {
    console.log('  → 网关接受了非法档位名，说明它不做档位校验（任何值都会被原样放行）\n');
    continue;
  }

  console.log(`  → 网关声明支持: ${table.levels.join(', ')}`);
  const rows = [];
  for (const level of [null, ...table.levels]) {
    const runs = [];
    for (let index = 0; index < reps; index += 1) runs.push(await ask(baseURL, credential.value, model, level));
    const ok = runs.filter((run) => run.status === 200);
    const label = level === null ? '(不发送)' : level;
    if (ok.length === 0) {
      rows.push([label, String(runs[0].status), runs[0].detail ?? '']);
      continue;
    }
    const tokens = ok.map((run) => run.tokens).filter((value) => typeof value === 'number');
    rows.push([label, '200', tokens.length === 0 ? '?' : `${median(tokens)}  (${tokens.join(', ')})`]);
  }
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, status, detail] of rows) console.log(`     ${label.padEnd(width)}  ${status.padEnd(4)} ${detail}`);
  console.log('');
}

console.log('Reading the result:');
console.log('  - The listed levels are the gateway\'s own table for that model — declare exactly those.');
console.log('  - Levels outside the table are silently clamped to the nearest one, not rejected,');
console.log('    so offering them in DSH produces a chip that does nothing distinct.');
console.log('  - Compare reasoning_tokens to see whether a level has any real effect at all.');
