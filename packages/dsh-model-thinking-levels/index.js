/**
 * Host half of the thinking-level bundle.
 *
 * The Client half can read a route's configuration and write
 * `reasoningEfforts`, but it cannot ask the gateway which levels a model
 * actually supports: that needs the route's credential, and a browser must
 * never hold one. This half owns that call.
 *
 * A CLIProxyAPI-style gateway keeps a per-model `thinking.levels` table
 * (`internal/registry/models/models.json`, plus a capability fetch for
 * Antigravity home models) and validates `reasoning_effort` against it. A
 * level outside the table is *clamped* rather than rejected on a cross-family
 * request, so the table never surfaces in normal traffic — but a value that is
 * not a level at all is rejected outright, and the refusal carries the table:
 *
 *     level "bogus" not supported, valid levels: low, medium, high
 *
 * So one deliberately-invalid request per model reveals the authoritative set.
 *
 * The Client names a route — a settings namespace plus a path inside it — and
 * never a URL or a credential. Both come from the profile document this half
 * reads itself, so the channel cannot be turned into a way to make the Host
 * send someone's key somewhere else.
 *
 * @module dsh-model-thinking-levels
 */

/** RPC channel the Client half calls; a bare path, as the connection service requires. */
const CHANNEL = '/dsh-model-thinking-levels';
/** A value no table-driven gateway accepts, so the table reveals itself in the refusal. */
const BOGUS = 'dsh-probe-invalid-level';
/** How many models one call may cover, so a bad caller cannot fan out. */
const MAX_MODELS = 40;
/** A probe must not hang the settings page that asked for it. */
const TIMEOUT_MS = 15000;

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

/** The Client's request, or undefined when it is not shaped like one. */
function readRequest(payload) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const { settingsNs, settingsPath, models } = payload;
  if (typeof settingsNs !== 'string' || settingsNs.length === 0) return undefined;
  if (!Array.isArray(settingsPath) || settingsPath.some((segment) => typeof segment !== 'string' || segment.length === 0)) return undefined;
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
  return {
    baseURL: typeof profile.baseURL === 'string' && profile.baseURL.length > 0 ? profile.baseURL : undefined,
    apiKeyEnv: typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0 ? profile.apiKeyEnv : undefined,
    api: typeof profile.api === 'string' && profile.api.length > 0 ? profile.api : undefined,
  };
}

/** The credential behind one reference name; the value never leaves this module. */
async function readKey(ctx, ref) {
  if (ref === undefined) return undefined;
  const credentials = ctx.get('credentials');
  if (credentials === undefined) return undefined;
  const hit = await credentials.resolve(ref);
  const value = hit?.value;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
      () => connection.rpc.handle(CHANNEL, (endpoint, payload, signal) => {
        if (endpoint !== 'probe') return fail('bad-endpoint', `unknown endpoint ${JSON.stringify(endpoint)}`);
        return handleProbe(owner, payload, signal);
      }),
      'model-thinking-levels: gateway level probe channel',
    );
  });
}
