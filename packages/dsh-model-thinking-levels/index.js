/**
 * Host half of the thinking-level bundle.
 *
 * The Client half can read a route's configuration and write model entries,
 * but it cannot ask the gateway which levels a model actually supports: that
 * needs the route's credential, and a browser must never hold one. This half
 * owns that call, and the capability search around it.
 *
 * Two questions are answered here, on one RPC channel:
 *
 * - `probe` — which thinking levels will this gateway accept? A CLIProxyAPI-style
 *   gateway keeps a per-model `thinking.levels` table (`internal/registry/models/models.json`,
 *   plus a capability fetch for Antigravity home models) and validates
 *   `reasoning_effort` against it. A level outside the table is *clamped* rather
 *   than rejected on a cross-family request, so the table never surfaces in
 *   normal traffic — but a value that is not a level at all is rejected
 *   outright, and the refusal carries the table:
 *
 *       level "bogus" not supported, valid levels: low, medium, high
 *
 *   So one deliberately-invalid request per model reveals the authoritative set.
 *
 * - `detect` — what else can be known about these models? Two sources, neither
 *   of which the browser can reach:
 *
 *   1. The endpoint's own model listing (`GET /models`). Compatibility gateways
 *      disagree about how much it discloses; the standard `data` array usually
 *      carries ids only, while enriched gateways (OpenRouter/NewAPI/LiteLLM
 *      shapes) also publish context capacity, output capacity, modalities, and
 *      the upstream vendor as `owned_by`.
 *   2. The installed pi-ai catalog. A hand-declared route is unknown to it, but
 *      the model ids it serves usually are not: the same `gpt-6.1-sol` appears
 *      in the shipped catalog under its vendor with the context window, output
 *      cap, modalities, and thinking-level table the vendor publishes. Matching
 *      by id turns "you must type these in" into "these were detected".
 *
 *   The catalog is read through a dynamic import of the pi-ai package that this
 *   deployment's own `@deepseek-ai/dsh-llm-pi-ai` depends on, because a plugin
 *   installed outside the profile cannot resolve that package itself.
 *
 * The Client names a route — a settings namespace plus a path inside it — and
 * never a URL or a credential. Both come from the profile document this half
 * reads itself, so the channel cannot be turned into a way to make the Host
 * send someone's key somewhere else.
 *
 * @module dsh-model-thinking-levels
 */

import { createRequire, findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** RPC channel the Client half calls; a bare path, as the connection service requires. */
const CHANNEL = '/dsh-model-thinking-levels';
/** A value no table-driven gateway accepts, so the table reveals itself in the refusal. */
const BOGUS = 'dsh-probe-invalid-level';
/** How many models one call may cover, so a bad caller cannot fan out. */
const MAX_MODELS = 40;
/** A probe must not hang the settings page that asked for it. */
const TIMEOUT_MS = 15000;
/** Ceiling on a model-listing reply; a listing is metadata, not a payload. */
const MAX_LISTING_BYTES = 4 * 1024 * 1024;
/** pi-ai thinking levels in escalation order, as the installed catalog names them. */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Wire protocols whose model listing this half can read, as the adapter's discovery does. */
const LISTABLE = new Set(['openai-completions', 'openai-responses', 'anthropic-messages']);
/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01';
/**
 * A gateway may expose one aliased copy per thinking level — CLIProxyAPI turns
 * a model into `<model>-high`, `<model>-low` — while the catalog keys the bare
 * id. Only the suffix is removed, and only when the bare id is in the catalog.
 */
const LEVEL_SUFFIX = /-(?:off|minimal|low|medium|high|xhigh|max)$/i;
/**
 * Model families whose vendor ships a first-party catalog entry. A gateway
 * serves a reseller's copy of a model far more often than a reseller-only
 * model, so the vendor's own row is the best reading of "what this model is";
 * the listing's `owned_by` and the route's protocol then break the remaining
 * ties.
 */
const VENDOR_PREFIXES = [
  [/^claude/i, 'anthropic'],
  [/^(?:gpt|chatgpt|o[1-9](?![0-9]))/i, 'openai'],
  [/^codex/i, 'openai'],
  [/^gemini/i, 'google'],
  [/^deepseek/i, 'deepseek'],
  [/^grok/i, 'xai'],
  [/^qwen/i, 'qwen'],
  [/^(?:kimi|moonshot)/i, 'moonshotai'],
  [/^(?:glm|zai)/i, 'zai'],
  [/^minimax/i, 'minimax'],
  [/^llama/i, 'meta'],
  [/^(?:mistral|magistral|codestral)/i, 'mistral'],
];
/** HTTP methods that carry no body, so no request shape to validate. */
const GET = 'GET';

/** Read one path out of a settings value. */
function atPath(root, path) {
  let node = root;
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[segment];
  }
  return node;
}

/** A refused RPC result, in the envelope the connection service relays. */
function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/** The one settings namespace whose profiles describe whole pi-ai routes. */
const SETTINGS_NS = 'llm-pi-ai';

/**
 * The Client's request, or undefined when it is not shaped like one.
 *
 * The namespace and path are pinned to `llm-pi-ai`'s provider dict rather than
 * accepted as given: a channel that reads any namespace would let a page make
 * the Host resolve some other profile's credential reference and send it as a
 * bearer token to that profile's endpoint. The destination still comes from the
 * stored document, so nothing leaves the deployment — but the probe has no
 * business outside the routes it renders for, and pinning it keeps it that way.
 */
function readRequest(payload) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const { settingsNs, settingsPath, models } = payload;
  if (settingsNs !== SETTINGS_NS) return undefined;
  if (!Array.isArray(settingsPath) || settingsPath.length !== 2 || settingsPath[0] !== 'providers') return undefined;
  if (settingsPath.some((segment) => typeof segment !== 'string' || segment.length === 0)) return undefined;
  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_MODELS) return undefined;
  if (models.some((model) => typeof model !== 'string' || model.length === 0 || model.length > 200)) return undefined;
  return { settingsNs, settingsPath, models };
}

/**
 * The route the Client named, read from the profile document.
 * @param settings - the Host settings service.
 * @param ns - settings namespace the route lives in.
 * @param path - path inside that namespace's value.
 * @returns the route's endpoint and credential reference, or undefined.
 */
function readRoute(settings, ns, path) {
  const rows = settings.describe();
  const row = Array.isArray(rows) ? rows.find((entry) => entry?.ns === ns) : undefined;
  if (row === undefined) return undefined;
  const profile = atPath(row.value, path);
  if (profile === null || typeof profile !== 'object') return undefined;
  const headers = {};
  if (profile.headers !== null && typeof profile.headers === 'object' && !Array.isArray(profile.headers)) {
    for (const [name, value] of Object.entries(profile.headers)) {
      if (typeof value === 'string' && name.length > 0) headers[name] = value;
    }
  }
  return {
    baseURL: typeof profile.baseURL === 'string' && profile.baseURL.length > 0 ? profile.baseURL : undefined,
    apiKeyEnv: typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0 ? profile.apiKeyEnv : undefined,
    api: typeof profile.api === 'string' && profile.api.length > 0 ? profile.api : undefined,
    headers,
  };
}

/** The credential behind one reference name; the value never leaves this module. */
async function readKey(ctx, ref) {
  if (ref === undefined) return undefined;
  const credentials = ctx.get('credentials');
  if (credentials !== undefined) {
    let hit;
    try {
      hit = await credentials.resolve(ref);
    } catch {
      // A credential provider that refuses is "this route has no usable key",
      // which callers already report; it is not a broken channel.
      hit = undefined;
    }
    const value = hit?.value;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  // The adapter also reads a route's credential from the launch environment;
  // a key configured only there is usable by every normal request, so the
  // probe must not report the route as credential-less.
  const fromEnvironment = process.env[ref];
  return typeof fromEnvironment === 'string' && fromEnvironment.length > 0 ? fromEnvironment : undefined;
}

/** The gateway's own message out of an error body, JSON or not. */
function errorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  } catch {
    // Not JSON; the raw body is the best available detail.
  }
  return text.slice(0, 300);
}

/**
 * Ask one model for its level table.
 *
 * The request carries the smallest possible completion so that a gateway which
 * accepts the bogus level anyway spends almost nothing answering it.
 * @param baseURL - the route's endpoint.
 * @param key - the resolved credential.
 * @param model - model id to ask about.
 * @param signal - the RPC call's own abort signal, when any.
 * @returns one result row for the Client.
 */
async function probeModel(baseURL, key, model, signal) {
  const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
        reasoning_effort: BOGUS,
      }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
  } catch (error) {
    return { model, kind: 'unreachable', detail: String(error?.message ?? error) };
  }
  const text = await response.text();
  // A gateway that takes the bogus level does no validation at all, so it has
  // no table to give; the Client keeps its generic preset for that model.
  if (response.ok) return { model, kind: 'unchecked' };
  const message = errorMessage(text);
  const listed = message.match(/valid levels:\s*(.+?)\s*$/i);
  if (listed !== null) {
    return { model, kind: 'levels', levels: listed[1].split(',').map((entry) => entry.trim()).filter(Boolean) };
  }
  if (/thinking not supported/i.test(message)) return { model, kind: 'none' };
  return { model, kind: 'refused', status: response.status, detail: message };
}

/** Answer one probe call; every failure is a result, not a thrown transport error. */
async function handleProbe(ctx, payload, signal) {
  const request = readRequest(payload);
  if (request === undefined) return fail('bad-request', 'probe needs a settings namespace, a settings path, and 1..40 model ids');
  const settings = ctx.get('settings');
  if (settings === undefined) return fail('no-settings', 'this deployment has no settings service to read the route from');
  let route;
  try {
    route = readRoute(settings, request.settingsNs, request.settingsPath);
  } catch (error) {
    return fail('no-settings', String(error?.message ?? error));
  }
  if (route === undefined) return fail('no-route', `no route at ${request.settingsNs} ${request.settingsPath.join('.')}`);
  if (route.baseURL === undefined) return fail('no-base-url', 'that route declares no baseURL to probe');
  // The probe speaks the OpenAI chat-completions shape. Saying so beats letting
  // an anthropic-messages or responses route fail as an unreachable endpoint.
  if (route.api !== undefined && route.api !== 'openai-completions') {
    return fail('unsupported-protocol', `this probe speaks the OpenAI chat-completions shape, and the route declares api: ${route.api}`);
  }
  const key = await readKey(ctx, route.apiKeyEnv);
  if (key === undefined) {
    return fail('no-credential', `that route resolves ${route.apiKeyEnv ?? '(no apiKeyEnv)'}, which is not set`);
  }
  const results = [];
  for (const model of request.models) results.push(await probeModel(route.baseURL, key, model, signal));
  return { ok: true, value: { results } };
}

/** The first non-empty string among the candidates. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** The first positive integer among the candidates, whether it arrives as a number or a numeric string. */
function firstCapacity(...values) {
  for (const value of values) {
    const numeric = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value;
    if (typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  }
  return undefined;
}

/** Every modality list a listing entry may publish, or undefined when it publishes none. */
function readModalities(entry) {
  const candidates = [entry?.input, entry?.input_modalities, entry?.inputModalities, entry?.modalities?.input, entry?.architecture?.input_modalities];
  const found = new Set();
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      if (item === 'text' || item === 'image') found.add(item);
    }
  }
  // OpenRouter spells the pair as one string: "text+image->text".
  const descriptor = entry?.architecture?.modality;
  if (typeof descriptor === 'string') {
    for (const item of descriptor.split('->', 1)[0].split('+')) {
      if (item === 'text' || item === 'image') found.add(item);
    }
  }
  if (found.size === 0) return undefined;
  return ['text', 'image'].filter((modality) => found.has(modality));
}

/**
 * Read one supported model-listing reply.
 *
 * The standard `data` array and the enriched `models` map are both accepted,
 * matching the pi-ai adapter's own discovery parser; the `data` array wins when
 * both appear. Entries without a usable id are skipped, because one malformed
 * row should not deny the rest of a working listing.
 * @param text - the reply body.
 * @returns ids mapped to the metadata the entry disclosed, or undefined when the reply is not a listing.
 */
function readListing(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  const data = body?.data;
  let listed;
  if (Array.isArray(data)) {
    listed = data.map((raw) => ({ key: undefined, raw }));
  } else {
    const models = body?.models;
    if (models === null || typeof models !== 'object' || Array.isArray(models)) return undefined;
    listed = Object.entries(models)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }));
  }
  const entries = new Map();
  for (const { key, raw } of listed) {
    const id = firstString(key, raw?.id);
    if (id === undefined) continue;
    const entry = {
      name: firstString(raw?.name, raw?.display_name, raw?.displayName),
      contextWindow: firstCapacity(raw?.contextWindow, raw?.context_window, raw?.context_length, raw?.max_input_tokens, raw?.limit?.context),
      maxTokens: firstCapacity(raw?.maxOutputTokens, raw?.max_output_tokens, raw?.maxTokens, raw?.max_tokens, raw?.max_completion_tokens, raw?.limit?.output, raw?.top_provider?.max_completion_tokens),
      input: readModalities(raw),
      ownedBy: firstString(raw?.owned_by, raw?.ownedBy),
    };
    for (const field of Object.keys(entry)) if (entry[field] === undefined) delete entry[field];
    entries.set(id, entry);
  }
  return entries;
}

/** The listing URL one protocol reads, mirroring the pi-ai adapter's discovery. */
function listingUrl(baseURL, api) {
  const base = baseURL.replace(/\/+$/, '');
  if (api !== 'anthropic-messages') return `${base}/models`;
  return `${base.endsWith('/v1') ? base.slice(0, -3) : base}/v1/models?limit=1000`;
}

/**
 * A bounded reply body; a listing endpoint has no business streaming megabytes.
 *
 * A declared length is checked before transferring anything, and the running
 * total enforces the same ceiling for a server that under-declares or streams
 * without a length — the reason reading the whole body first and measuring it
 * afterwards would not be a bound at all.
 * @param response - the listing reply.
 * @returns its decoded body.
 */
async function readBounded(response) {
  const oversized = () => new Error(`model listing answered with more than ${MAX_LISTING_BYTES} bytes`);
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_LISTING_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw oversized();
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_LISTING_BYTES) throw oversized();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/**
 * Ask the route's endpoint which models it serves, and whatever it publishes
 * about them.
 * @param route - the route's endpoint and protocol.
 * @param key - the resolved credential.
 * @param signal - the RPC call's own abort signal.
 * @returns the listing entries, or a detail that explains why there are none.
 */
async function fetchListing(route, key, signal) {
  const api = route.api ?? 'openai-completions';
  if (!LISTABLE.has(api)) return { ok: false, detail: `the route declares api: ${api}, which has no model listing this probe can read` };
  if (route.baseURL === undefined) return { ok: false, detail: 'that route declares no baseURL to ask' };
  const url = listingUrl(route.baseURL, api);
  // The route's own configured headers go first: a gateway that authenticates
  // through a header or needs its own routing header serves normal requests
  // fine, and a listing that skipped them would report a false failure.
  const headers = { ...route.headers, accept: 'application/json' };
  if (api === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    if (key !== undefined) headers['x-api-key'] = key;
  } else if (key !== undefined) {
    headers.authorization = `Bearer ${key}`;
  }
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { method: GET, headers, signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) });
  } catch (error) {
    return { ok: false, detail: `could not reach ${url}: ${String(error?.message ?? error)}` };
  }
  // Status first: a huge error page should be reported as the status it was,
  // not buffered and measured as an oversized listing.
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, detail: `${url} answered ${response.status}` };
  }
  let text;
  try {
    text = await readBounded(response);
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  }
  const entries = readListing(text);
  if (entries === undefined) return { ok: false, detail: `${url} did not answer with a model listing` };
  return { ok: true, entries };
}

/**
 * Resolve the pi-ai package this deployment's adapter uses.
 *
 * A plugin installed into a profile has no `node_modules` of its own, so it
 * cannot resolve pi-ai as a bare specifier. The Host process, however, can:
 * this module runs inside it, and `process.argv[1]` is the dsh entry point, so
 * Node's own package lookup from there finds the very copy the adapter loaded.
 * `findPackageJSON` answers the nested layout a global install uses and the
 * `.pnpm` layout a profile uses without choosing between them; the walk over
 * `@deepseek-ai/dsh-llm-pi-ai`'s location is the fallback for a Node too old to
 * ship `findPackageJSON`.
 * @returns the pi-ai package directory, or undefined when it cannot be found.
 */
function locatePiAiDir() {
  const bases = [process.argv[1], new URL(import.meta.url).href, process.env.DSH_CATALOG_BASE].filter(
    (base) => typeof base === 'string' && base.length > 0,
  );
  for (const base of bases) {
    try {
      const manifest = findPackageJSON('@earendil-works/pi-ai', base);
      if (manifest !== undefined && manifest !== null) return dirname(manifest);
    } catch {
      // This base cannot see pi-ai; the next one may.
    }
  }
  for (const base of bases) {
    try {
      const require = createRequire(base);
      let dir = dirname(require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'));
      for (let step = 0; step < 8; step += 1) {
        for (const candidate of [join(dir, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), join(dir, '@earendil-works', 'pi-ai', 'package.json')]) {
          if (require('node:fs').existsSync(candidate)) return dirname(candidate);
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // This base cannot resolve the adapter; the next one may.
    }
  }
  return undefined;
}

/** The thinking levels the installed catalog says one model supports. */
function catalogLevels(model) {
  if (model.reasoning !== true) return [];
  return LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    // pi-ai's defaulting is asymmetric: the five base levels are supported
    // unless pinned to null, while xhigh and max need an explicit mapping.
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/**
 * Index the installed catalog by model id.
 *
 * The adapter's own `catalogModels` is keyed by route, which is exactly the
 * lookup that cannot help a hand-declared route: the id is known, the route is
 * not. Reading every built-in provider's chat catalog by id is what turns that
 * around.
 * @returns the index, or undefined when the catalog cannot be loaded.
 */
async function buildCatalog() {
  const dir = locatePiAiDir();
  if (dir === undefined) return undefined;
  const module = await import(pathToFileURL(join(dir, 'dist', 'providers', 'all.js')).href);
  const byId = new Map();
  const providers = module.getBuiltinProviders();
  for (const provider of providers) {
    for (const model of module.getBuiltinModels(provider)) {
      if (typeof model?.id !== 'string' || model.id.length === 0) continue;
      const entry = {
        provider: typeof model.provider === 'string' ? model.provider : provider,
        api: typeof model.api === 'string' ? model.api : undefined,
        id: model.id,
        name: typeof model.name === 'string' ? model.name : undefined,
        contextWindow: firstCapacity(model.contextWindow),
        maxTokens: firstCapacity(model.maxTokens),
        input: Array.isArray(model.input) ? model.input.filter((item) => item === 'text' || item === 'image') : [],
        levels: catalogLevels(model),
      };
      for (const field of Object.keys(entry)) if (entry[field] === undefined) delete entry[field];
      if (!byId.has(entry.id)) byId.set(entry.id, []);
      byId.get(entry.id).push(entry);
    }
  }
  return { byId, providers: providers.length };
}

/** The catalog index, loaded once per process when it is first needed. */
let catalogCache;

/** @returns the catalog index, or undefined when this deployment cannot offer one. */
async function loadCatalog() {
  if (catalogCache !== undefined) return catalogCache;
  try {
    const built = await buildCatalog();
    if (built === undefined) return undefined;
    catalogCache = built;
    return built;
  } catch {
    // A deployment without a readable pi-ai install simply gets no catalog
    // data; the panel falls back to the gateway's own answer.
    return undefined;
  }
}

/**
 * The catalog rows for one model id, under the names a gateway may expose it by.
 * @param catalog - the catalog index.
 * @param modelId - the id the route declares.
 * @returns the matched catalog id and its rows, or undefined when the catalog does not know the model.
 */
function catalogLookup(catalog, modelId) {
  const exact = catalog.byId.get(modelId);
  if (exact !== undefined) return { id: modelId, candidates: exact };
  // A gateway may expose one aliased copy per thinking level.
  const stripped = modelId.replace(LEVEL_SUFFIX, '');
  if (stripped !== modelId) {
    const hit = catalog.byId.get(stripped);
    if (hit !== undefined) return { id: stripped, candidates: hit };
  }
  // Resellers sometimes key the catalog by a vendor-prefixed id.
  const vendorPrefixed = modelId.includes('/') ? modelId.slice(modelId.lastIndexOf('/') + 1) : undefined;
  if (vendorPrefixed !== undefined && vendorPrefixed !== modelId) {
    const hit = catalog.byId.get(vendorPrefixed);
    if (hit !== undefined) return { id: vendorPrefixed, candidates: hit };
  }
  return undefined;
}

/** The vendor whose own catalog row describes this model family, when one is known. */
function vendorOf(modelId) {
  for (const [pattern, vendor] of VENDOR_PREFIXES) {
    if (pattern.test(modelId)) return vendor;
  }
  return undefined;
}

/** The fields a catalog choice decides, as one comparable string. */
function choiceKey(candidate) {
  return JSON.stringify([candidate.contextWindow, candidate.maxTokens, candidate.input ?? [], candidate.levels ?? []]);
}

/**
 * Pick the catalog reading one gateway model is best described by.
 *
 * A model id can appear in several providers' catalogs with different
 * capacities — the vendor's own `gpt-6.1-sol` is 272k tokens while a coding
 * subscription serves a 1M-token variant — so a choice needs a reason, and the
 * Client needs to know when there was none:
 *
 * - `vendor`: a first-party row for this model family, from the id's own prefix;
 * - `provider`: a row whose provider the listing named as `owned_by`;
 * - `api`: the rows speaking this route's protocol agree;
 * - `agreement`: every row for the id agrees;
 * - `majority`: most rows agree, and none of the above narrows it;
 * - `ambiguous`: rows disagree and nothing ranks them — the Client must not
 *   write a guess.
 *
 * @param candidates - the catalog rows for one id.
 * @param routeApi - the protocol the route declares, when any.
 * @param ownedBy - the vendor the gateway's listing named, when any.
 * @returns the chosen reading, how confident it is, and the competing values.
 */
function chooseCatalog(candidates, routeApi, ownedBy) {
  const hint = typeof ownedBy === 'string' ? ownedBy.toLowerCase() : undefined;
  const vendor = vendorOf(candidates[0].id);
  const scores = candidates.map((candidate) => {
    const provider = typeof candidate.provider === 'string' ? candidate.provider.toLowerCase() : '';
    let score = 0;
    if (vendor !== undefined && (provider === vendor || provider.startsWith(`${vendor}-`))) score += 100;
    if (hint !== undefined && provider.length > 0 && (provider === hint || provider.includes(hint) || hint.includes(provider))) score += 40;
    if (routeApi !== undefined && candidate.api === routeApi) score += 4;
    // Prefer the row that discloses the most: a reseller entry with no
    // capacities cannot describe the model as well as the vendor's does.
    if (candidate.contextWindow !== undefined) score += 1;
    if (candidate.maxTokens !== undefined) score += 1;
    return { candidate, score };
  });
  const groups = new Map();
  for (const entry of scores) {
    const key = choiceKey(entry.candidate);
    const group = groups.get(key) ?? { candidates: [], score: 0, key };
    group.candidates.push(entry.candidate);
    group.score += entry.score;
    groups.set(key, group);
  }
  const ranked = [...groups.values()].sort((left, right) => right.score - left.score || right.candidates.length - left.candidates.length);
  const winner = ranked[0];
  // Within the winning group every row agrees on the facts; the name and
  // provider reported back should still be the best-ranked one, which is the
  // vendor's own row when it is in the group.
  const individual = new Map(scores.map((entry) => [entry.candidate, entry.score]));
  const winnerRows = [...winner.candidates].sort((left, right) => {
    const difference = (individual.get(right) ?? 0) - (individual.get(left) ?? 0);
    if (difference !== 0) return difference;
    const vendorFirst = (candidate) => (vendor !== undefined && typeof candidate.provider === 'string' && candidate.provider.toLowerCase() === vendor ? 1 : 0);
    return vendorFirst(right) - vendorFirst(left);
  });
  const chosen = winnerRows[0];
  let confidence;
  if (vendor !== undefined && winner.candidates.some((candidate) => typeof candidate.provider === 'string' && (candidate.provider.toLowerCase() === vendor || candidate.provider.toLowerCase().startsWith(`${vendor}-`)))) {
    confidence = 'vendor';
  } else if (hint !== undefined && winner.candidates.some((candidate) => typeof candidate.provider === 'string' && hint !== undefined && (candidate.provider.toLowerCase().includes(hint) || hint.includes(candidate.provider.toLowerCase())))) {
    confidence = 'provider';
  } else if (ranked.length === 1) {
    confidence = 'agreement';
  } else {
    // Every row that speaks this route's protocol landing in the winning group
    // means the route's protocol narrows the answer even though no single
    // vendor does: a 1M-token coding subscription and a 32k chat endpoint can
    // share an id, and only one of them speaks the protocol in use.
    const apiRows = routeApi === undefined ? [] : candidates.filter((candidate) => candidate.api === routeApi);
    const apiAgrees = apiRows.length > 0 && apiRows.every((candidate) => choiceKey(candidate) === winner.key);
    if (apiAgrees) {
      confidence = 'api';
    } else if (winner.candidates.length > candidates.length / 2) {
      confidence = 'majority';
    } else {
      confidence = 'ambiguous';
    }
  }
  const variants = ranked.slice(0, 3).map((group) => ({
    providers: [...new Set(group.candidates.map((candidate) => candidate.provider).filter(Boolean))],
    contextWindow: group.candidates[0].contextWindow,
    maxTokens: group.candidates[0].maxTokens,
    input: group.candidates[0].input,
    levels: group.candidates[0].levels,
  }));
  const picked = {
    confidence,
    provider: chosen.provider,
    name: chosen.name,
    contextWindow: chosen.contextWindow,
    maxTokens: chosen.maxTokens,
    input: chosen.input,
    levels: chosen.levels,
  };
  for (const field of Object.keys(picked)) if (picked[field] === undefined) delete picked[field];
  if (variants.length > 1) picked.variants = variants;
  return picked;
}

/** Answer one capability-detection call; every failure is a result, not a thrown transport error. */
async function handleDetect(ctx, payload, signal) {
  const request = readRequest(payload);
  if (request === undefined) return fail('bad-request', 'detect needs a settings namespace, a settings path, and 1..40 model ids');
  const settings = ctx.get('settings');
  if (settings === undefined) return fail('no-settings', 'this deployment has no settings service to read the route from');
  let route;
  try {
    route = readRoute(settings, request.settingsNs, request.settingsPath);
  } catch (error) {
    return fail('no-settings', String(error?.message ?? error));
  }
  if (route === undefined) return fail('no-route', `no route at ${request.settingsNs} ${request.settingsPath.join('.')}`);
  const key = await readKey(ctx, route.apiKeyEnv);
  const [listing, catalog] = await Promise.all([fetchListing(route, key, signal), loadCatalog()]);
  const results = request.models.map((model) => {
    const result = { model };
    const listed = listing.ok === true ? listing.entries.get(model) : undefined;
    if (listed !== undefined) result.gateway = listed;
    if (catalog !== undefined) {
      const hit = catalogLookup(catalog, model);
      if (hit !== undefined) result.official = chooseCatalog(hit.candidates, route.api ?? 'openai-completions', listed?.ownedBy);
    }
    return result;
  });
  return {
    ok: true,
    value: {
      gateway: listing.ok === true ? { ok: true } : { ok: false, detail: listing.detail },
      // Whether the installed catalog was readable at all: a deployment whose
      // pi-ai install this half cannot reach still gets the listing's answers,
      // and the panel says why the catalog contributed none.
      catalog: { ok: catalog !== undefined },
      results,
    },
  };
}

/**
 * Route one channel call to its endpoint.
 * @param owner - the Context the handlers read services from.
 * @param endpoint - the endpoint the Client named.
 * @param payload - the request payload.
 * @param signal - the RPC call's own abort signal.
 * @returns the RPC result envelope.
 */
function dispatch(owner, endpoint, payload, signal) {
  if (endpoint === 'probe') return handleProbe(owner, payload, signal);
  if (endpoint === 'detect') return handleDetect(owner, payload, signal);
  return fail('bad-endpoint', `unknown endpoint ${JSON.stringify(endpoint)}`);
}

/**
 * Register the probe channel once this deployment has a connection service.
 *
 * A channel lands on the web server of the Context that reads the registry:
 * `rpc.handle` resolves `owner.webServer`, where `owner` is the reading
 * Context. Cordis refuses to read a service a Context never injected, so
 * calling it from a Context that injected only `connection` throws
 * `cannot get property "webServer" without inject` — inside this callback,
 * where nothing surfaces it. The channel then simply never exists, and the
 * browser's POST falls through to the static handler and comes back as
 * `HTTP 405`. Reading the registry through a Context extended with
 * `webServer` is what `dsh-mnemon` does, for the same reason.
 *
 * `ctx.inject` keeps the plugin active without a web server, so the Client half
 * still renders — it just reports that detection is unavailable.
 * @param ctx - this plugin's context.
 */
export function apply(ctx) {
  ctx.inject(['connection', 'webServer'], (web) => {
    const webServer = web.get('webServer');
    if (webServer === undefined) return;
    const owner = web.extend({ webServer });
    const connection = owner.connection;
    if (connection === undefined) return;
    owner.effect(
      () => connection.rpc.handle(CHANNEL, (endpoint, payload, signal) => dispatch(owner, endpoint, payload, signal)),
      'model-thinking-levels: gateway level probe channel',
    );
  });
}

export { chooseCatalog, dispatch, handleDetect, handleProbe, locatePiAiDir, readListing };
