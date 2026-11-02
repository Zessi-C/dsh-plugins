#!/usr/bin/env node
/**
 * Offline acceptance check for the Host half's two endpoints.
 *
 * The Host half is where detection actually happens: the gateway's level table
 * comes from one deliberately-invalid request, its model listing from one GET,
 * and the capacities from the pi-ai catalog's own row for each id. None of that
 * needs a browser or the real Host, so this script supplies the pieces the
 * plugin reads — a settings service describing one route, a credentials service
 * answering one key, and a stubbed `fetch` — and calls the real handlers.
 *
 * Catalog matching reads the pi-ai install a DSH checkout already has, so the
 * catalog cases need one:
 *
 *   node tools/check-detect.mjs --dsh /path/to/dsh          # a dir holding node_modules/@deepseek-ai
 *   DSH_CHECKOUT=/path/to/dsh node tools/check-detect.mjs
 *
 * Without one those cases report SKIP and the wire-level cases still run.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chooseCatalog, dispatch, handleDetect, handleProbe, locatePiAiDir, readListing } from '../index.js';

let failures = 0;
let checks = 0;

/** Record one assertion. */
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

/** Compare two lists. */
function same(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** The DSH checkout to read the pi-ai catalog from. */
function findCheckout() {
  const at = process.argv.indexOf('--dsh');
  const candidates = [at === -1 ? undefined : process.argv[at + 1], process.env.DSH_CHECKOUT];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) continue;
    const packages = join(candidate, 'node_modules', '@deepseek-ai');
    if (existsSync(join(packages, 'dsh', 'package.json'))) return packages;
  }
  return undefined;
}

/** The context the handlers read, over one described route and one key. */
function makeContext({ baseURL = 'https://gateway.example/v1', api = 'openai-completions', apiKeyEnv = 'GW_KEY', key = 'sk-test', headers } = {}) {
  const settings = {
    describe: () => [
      {
        ns: 'llm-pi-ai',
        revision: 1,
        value: { providers: { cpa: { apiKeyEnv, api, baseURL, models: [], ...(headers === undefined ? {} : { headers }) } } },
      },
    ],
  };
  const credentials = { resolve: async () => (key === undefined ? undefined : { value: key }) };
  return { get: (name) => (name === 'settings' ? settings : name === 'credentials' ? credentials : undefined) };
}

/** Replace `fetch` for the duration of one case and record what it was asked. */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** A JSON response, as the handlers consume one. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const REQUEST = { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'cpa'], models: ['gpt-6.1-sol'] };

async function main() {
  process.stdout.write('\nlisting — what a gateway publishes about its models\n');

  const enriched = readListing(
    JSON.stringify({
      object: 'list',
      data: [
        {
          id: 'gpt-6.1-sol',
          owned_by: 'openai',
          context_length: 272000,
          max_tokens: 128000,
          architecture: { input_modalities: ['text', 'image'], modality: 'text+image->text' },
        },
        { id: 'text-only', context_window: '128000', max_completion_tokens: 8192, input: ['text'] },
        { name: 'no id at all' },
      ],
    }),
  );
  check('a standard data array is read', enriched?.size === 2, String(enriched?.size));
  check('capacities are read from every spelling listed', enriched?.get('gpt-6.1-sol')?.contextWindow === 272000 && enriched?.get('gpt-6.1-sol')?.maxTokens === 128000);
  check('the upstream vendor is kept', enriched?.get('gpt-6.1-sol')?.ownedBy === 'openai');
  check('modalities are normalised', same(enriched?.get('gpt-6.1-sol')?.input ?? [], ['text', 'image']), JSON.stringify(enriched?.get('gpt-6.1-sol')?.input));
  check('numeric strings are accepted', enriched?.get('text-only')?.contextWindow === 128000 && enriched?.get('text-only')?.maxTokens === 8192, JSON.stringify(enriched?.get('text-only')));
  check('an entry without an id is skipped', !enriched?.has('no id at all'));

  const mapped = readListing(
    JSON.stringify({
      models: {
        'alias-model': { id: 'canonical-model', display_name: 'Alias Model', limit: { context: 64000, output: 4096 } },
        ignored: 7,
      },
    }),
  );
  check('an enriched models map is read by its keys', mapped?.has('alias-model') && mapped?.get('alias-model')?.contextWindow === 64000, JSON.stringify([...(mapped?.keys() ?? [])]));
  check('and its display name is kept', mapped?.get('alias-model')?.name === 'Alias Model');
  check('a primitive property is not a model', !mapped?.has('ignored'));
  check('a body that is not a listing is refused', readListing('{"error":{"message":"nope"}}') === undefined);
  const emptyInput = readListing(JSON.stringify({ data: [{ id: 'no-input', input: [] }] }));
  check('an empty modality list states no modalities', emptyInput?.get('no-input')?.input === undefined, JSON.stringify(emptyInput?.get('no-input')));

  process.stdout.write('\nprobe — the gateway\'s own level table\n');

  let stub = stubFetch(() => json({ error: { message: 'level "x" not supported, valid levels: low, medium, high' } }, 400));
  const tabled = await handleProbe(makeContext(), REQUEST);
  stub.restore();
  check('a refusal reveals the table inline', same(tabled?.value?.results?.[0]?.levels ?? [], ['low', 'medium', 'high']), JSON.stringify(tabled));
  check('the probe speaks chat completions with the bogus level', stub.calls[0]?.url === 'https://gateway.example/v1/chat/completions' && JSON.parse(stub.calls[0]?.init?.body).reasoning_effort === 'dsh-probe-invalid-level');

  stub = stubFetch(() => json({ error: { message: 'thinking not supported for this model' } }, 400));
  const none = await handleProbe(makeContext(), REQUEST);
  stub.restore();
  check('a model with no thinking support is reported as such', none?.value?.results?.[0]?.kind === 'none', JSON.stringify(none?.value?.results?.[0]));

  stub = stubFetch(() => json({ id: 'ok', choices: [] }, 200));
  const unchecked = await handleProbe(makeContext(), REQUEST);
  stub.restore();
  check('a gateway that takes the bogus level validates nothing', unchecked?.value?.results?.[0]?.kind === 'unchecked', JSON.stringify(unchecked?.value?.results?.[0]));

  stub = stubFetch(() => json({ error: { message: 'boom' } }, 502));
  const refused = await handleProbe(makeContext(), REQUEST);
  stub.restore();
  check('another refusal keeps its status', refused?.value?.results?.[0]?.kind === 'refused' && refused?.value?.results?.[0]?.status === 502, JSON.stringify(refused?.value?.results?.[0]));

  const noKey = await handleProbe(makeContext({ apiKeyEnv: 'MISSING_KEY', key: null }), REQUEST);
  check('a route whose credential does not resolve is reported', noKey?.ok === false && noKey?.error?.code === 'no-credential', JSON.stringify(noKey));

  const wrongProtocol = await handleProbe(makeContext({ api: 'anthropic-messages' }), REQUEST);
  check('a protocol the probe cannot speak is refused by name', wrongProtocol?.error?.code === 'unsupported-protocol', JSON.stringify(wrongProtocol));

  process.stdout.write('\nranking — which catalog row describes this model\n');

  const vendorWins = chooseCatalog(
    [
      { id: 'gpt-6.1-sol', provider: 'opencode', api: 'openai-responses', contextWindow: 1050000, maxTokens: 128000, input: ['text', 'image'], levels: ['low', 'high'] },
      { id: 'gpt-6.1-sol', provider: 'openai', api: 'openai-responses', contextWindow: 272000, maxTokens: 128000, input: ['text', 'image'], levels: ['low', 'high'] },
    ],
    'openai-completions',
    'opencode',
  );
  check('the vendor\'s own row beats a reseller and the listing hint', vendorWins.confidence === 'vendor' && vendorWins.provider === 'openai', JSON.stringify(vendorWins));
  check('the losing readings are reported', Array.isArray(vendorWins.variants) && vendorWins.variants.length === 2, JSON.stringify(vendorWins.variants));

  const hintWins = chooseCatalog(
    [
      { id: 'mystery-one', provider: 'acme', api: 'openai-completions', contextWindow: 1000, maxTokens: 100, input: ['text'], levels: ['low'] },
      { id: 'mystery-one', provider: 'other', api: 'openai-completions', contextWindow: 2000, maxTokens: 200, input: ['text'], levels: ['low'] },
    ],
    'openai-completions',
    'acme',
  );
  check('the listed vendor breaks a tie no family prefix can', hintWins.confidence === 'provider' && hintWins.provider === 'acme', JSON.stringify(hintWins));

  const agreement = chooseCatalog(
    [
      { id: 'mystery-two', provider: 'one', contextWindow: 1000, maxTokens: 100, input: ['text'], levels: ['low'] },
      { id: 'mystery-two', provider: 'two', contextWindow: 1000, maxTokens: 100, input: ['text'], levels: ['low'] },
    ],
    undefined,
    undefined,
  );
  check('rows that agree are an answer', agreement.confidence === 'agreement', JSON.stringify(agreement));

  const ambiguous = chooseCatalog(
    [
      { id: 'mystery-three', provider: 'one', contextWindow: 1000, maxTokens: 100, input: ['text'], levels: ['low'] },
      { id: 'mystery-three', provider: 'two', contextWindow: 2000, maxTokens: 200, input: ['text'], levels: ['low'] },
    ],
    undefined,
    undefined,
  );
  check('unranked disagreement is not an answer', ambiguous.confidence === 'ambiguous', JSON.stringify(ambiguous));
  check('and names both readings', ambiguous.variants?.length === 2, JSON.stringify(ambiguous.variants));

  const majority = chooseCatalog(
    [
      { id: 'mystery-four', provider: 'one', api: 'openai-completions', contextWindow: 1000, maxTokens: 100, input: ['text'], levels: ['low'] },
      { id: 'mystery-four', provider: 'two', api: 'openai-completions', contextWindow: 1000, maxTokens: 100, input: ['text'], levels: ['low'] },
      { id: 'mystery-four', provider: 'three', api: 'openai-completions', contextWindow: 2000, maxTokens: 200, input: ['text'], levels: ['low'] },
    ],
    'openai-responses',
    undefined,
  );
  check('a majority of rows agreeing is an answer', majority.confidence === 'majority', JSON.stringify(majority));

  const apiNarrowed = chooseCatalog(
    [
      { id: 'mystery-five', provider: 'one', api: 'openai-completions', contextWindow: 1000, maxTokens: 100, input: ['text'], levels: ['low'] },
      { id: 'mystery-five', provider: 'two', api: 'openai-completions', contextWindow: 1000, maxTokens: 100, input: ['text'], levels: ['low'] },
      { id: 'mystery-five', provider: 'three', api: 'anthropic-messages', contextWindow: 2000, maxTokens: 200, input: ['text'], levels: ['low'] },
    ],
    'openai-completions',
    undefined,
  );
  check('the rows speaking the route protocol break the tie', apiNarrowed.confidence === 'api', JSON.stringify(apiNarrowed));

  process.stdout.write('\nchannel — dispatch, request scoping, stored headers\n');

  // The channel dispatches by endpoint; an unknown one must be refused, not
  // silently routed to a handler.
  const unrouted = dispatch(makeContext(), 'nope', REQUEST);
  check('an unknown endpoint is refused', unrouted?.ok === false && unrouted?.error?.code === 'bad-endpoint', JSON.stringify(unrouted));

  // The namespace and path are pinned: a page cannot point this channel at
  // another section's credential reference.
  const wrongNamespace = await handleDetect(makeContext(), { ...REQUEST, settingsNs: 'llm-deepseek' });
  check('another settings namespace is refused', wrongNamespace?.error?.code === 'bad-request', JSON.stringify(wrongNamespace));
  const wrongPath = await handleDetect(makeContext(), { ...REQUEST, settingsPath: ['providers'] });
  check('a path outside the provider dict is refused', wrongPath?.error?.code === 'bad-request', JSON.stringify(wrongPath));

  // The route's own stored headers reach the listing request.
  stub = stubFetch(() => json({ data: [] }));
  await handleDetect(makeContext({ headers: { 'x-gateway': 'route-token' } }), REQUEST);
  stub.restore();
  check('the route\'s configured headers are sent with the listing', stub.calls[0]?.init?.headers?.['x-gateway'] === 'route-token', JSON.stringify(stub.calls[0]?.init?.headers));

  // A key configured only in the launch environment still probes.
  stub = stubFetch(() => json({ error: { message: 'level "x" not supported, valid levels: high' } }, 400));
  process.env.GW_KEY = 'sk-from-environment';
  const fromEnvironment = await handleProbe(makeContext({ key: undefined }), REQUEST);
  delete process.env.GW_KEY;
  stub.restore();
  check('a key from the launch environment is usable', fromEnvironment?.ok === true && same(fromEnvironment?.value?.results?.[0]?.levels ?? [], ['high']), JSON.stringify(fromEnvironment));

  // An undersized listing is a bound, not a buffered whole: a declared length
  // past the ceiling is refused without reading the body.
  stub = stubFetch(() => new Response('x', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '9000000' } }));
  const oversized = await handleDetect(makeContext(), REQUEST);
  stub.restore();
  check('an oversized listing is refused by its declared length', oversized?.value?.gateway?.ok === false && String(oversized?.value?.gateway?.detail).includes('more than'), JSON.stringify(oversized?.value?.gateway));

  process.stdout.write('\ndetect — the route listing plus the installed catalog\n');
  const packages = findCheckout();
  if (packages === undefined) {
    process.stdout.write('  SKIP no DSH checkout: pass --dsh <dir> or set DSH_CHECKOUT\n');
  } else {
    process.env.DSH_CATALOG_BASE = join(packages, 'dsh') + '/';
    stub = stubFetch((url) => {
      if (url.endsWith('/models')) return json({ object: 'list', data: [{ id: 'gpt-6.1-sol', owned_by: 'openai' }, { id: 'gemini-3.8-flash-high', owned_by: 'antigravity' }, { id: 'totally-unknown-model', owned_by: 'acme' }] });
      return json({ error: { message: 'unexpected request' } }, 500);
    });
    const detected = await handleDetect(makeContext(), {
      ...REQUEST,
      models: ['gpt-6.1-sol', 'gemini-3.8-flash-high', 'totally-unknown-model'],
    });
    stub.restore();
    check('detect answers for every model it was asked about', detected?.value?.results?.length === 3, JSON.stringify(detected?.value?.results?.map((row) => row.model)));
    const sol = detected?.value?.results?.[0];
    check('the listing names the upstream vendor', sol?.gateway?.ownedBy === 'openai', JSON.stringify(sol?.gateway));
    check('the catalog supplies the capacities', sol?.official?.contextWindow === 272000 && sol?.official?.maxTokens === 128000, JSON.stringify(sol?.official));
    check('the catalog supplies the published levels', same(sol?.official?.levels ?? [], ['low', 'medium', 'high', 'xhigh', 'max']), JSON.stringify(sol?.official?.levels));
    const gemini = detected?.value?.results?.[1];
    check('a thinking-level suffix is matched to the bare catalog id', gemini?.official?.provider === 'google' && gemini?.official?.contextWindow === 1048576, JSON.stringify(gemini?.official));
    const unknown = detected?.value?.results?.[2];
    check('a model the catalog does not know gets no catalog row', unknown?.official === undefined && unknown?.gateway?.ownedBy === 'acme', JSON.stringify(unknown));
    check('the route reports the listing worked', detected?.value?.gateway?.ok === true, JSON.stringify(detected?.value?.gateway));
    check('and that the catalog was readable', detected?.value?.catalog?.ok === true, JSON.stringify(detected?.value?.catalog));

    // A listing the endpoint refuses must not take the catalog down with it:
    // the catalog is local, and it is the only answer an ids-only gateway gives.
    stub = stubFetch(() => json({ error: { message: 'forbidden' } }, 403));
    const noListing = await handleDetect(makeContext(), REQUEST);
    stub.restore();
    check('a refused listing is reported as a detail', noListing?.value?.gateway?.ok === false && String(noListing?.value?.gateway?.detail).includes('403'), JSON.stringify(noListing?.value?.gateway));
    check('and the catalog still answers', noListing?.value?.results?.[0]?.official?.contextWindow === 272000, JSON.stringify(noListing?.value?.results?.[0]));

    // An unreachable endpoint must not throw out of the handler.
    stub = stubFetch(() => {
      throw new Error('fetch failed');
    });
    const unreachable = await handleDetect(makeContext(), REQUEST);
    stub.restore();
    check('an unreachable endpoint stays a result', unreachable?.ok === true && unreachable?.value?.gateway?.ok === false, JSON.stringify(unreachable?.value?.gateway));

    // The anthropic listing path is asked the way that protocol expects.
    stub = stubFetch(() => json({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] }));
    const anthropicRoute = await handleDetect(makeContext({ api: 'anthropic-messages', baseURL: 'https://api.example.com/v1' }), REQUEST);
    stub.restore();
    check('an anthropic route lists through its own endpoint', stub.calls[0]?.url === 'https://api.example.com/v1/models?limit=1000', stub.calls[0]?.url);
    check('with the protocol header and key', stub.calls[0]?.init?.headers?.['anthropic-version'] === '2023-06-01' && stub.calls[0]?.init?.headers?.['x-api-key'] === 'sk-test');
    check('and its listing is read', anthropicRoute?.value?.gateway?.ok === true, JSON.stringify(anthropicRoute?.value?.gateway));
  }

  process.stdout.write(`\n${checks - failures}/${checks} checks passed\n\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write(`\nharness error: ${error?.stack ?? error}\n\n`);
  process.exit(2);
});
