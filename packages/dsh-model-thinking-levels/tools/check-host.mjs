#!/usr/bin/env node
/**
 * Host-contract check for the probe channel.
 *
 * The browser's probe is only reachable if the Host half registers its channel
 * on the web server, and that registration has a trap: `rpc.handle` resolves
 * `owner.webServer` from the Context that *reads* the registry, and Cordis
 * refuses to read a service a Context never injected. Registering from a
 * Context that injected only `connection` therefore throws
 * `cannot get property "webServer" without inject` — inside the `inject`
 * callback, where nothing reports it. The channel then never exists, and the
 * browser's POST falls through to the static handler and comes back as
 * `HTTP 405`.
 *
 * This script boots a real Cordis app with the real `HostConnectionService`
 * from a DSH checkout, a stub `webServer`, and this plugin's real `index.js`,
 * then asserts the channel landed on that server. It needs a DSH checkout to
 * import from:
 *
 *   node tools/check-host.mjs --dsh /path/to/dsh          # a dir holding node_modules/@deepseek-ai
 *   DSH_CHECKOUT=/path/to/dsh node tools/check-host.mjs
 *
 * Without one it reports SKIP and exits 0.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..', 'index.js');
/** The channel the Client half calls, which must appear on the web server. */
const CHANNEL = '/dsh-model-thinking-levels';

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

/** The DSH checkout to import cordis and the connection service from. */
function findCheckout() {
  const at = process.argv.indexOf('--dsh');
  const candidates = [at === -1 ? undefined : process.argv[at + 1], process.env.DSH_CHECKOUT];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) continue;
    const packages = join(candidate, 'node_modules', '@deepseek-ai');
    if (existsSync(join(packages, 'cordis', 'lib', 'index.js'))) return packages;
  }
  return undefined;
}

async function main() {
  process.stdout.write('\nhost channel — probe route registration\n');
  const packages = findCheckout();
  if (packages === undefined) {
    process.stdout.write('  SKIP no DSH checkout: pass --dsh <dir> or set DSH_CHECKOUT\n\n');
    return;
  }

  const { Context, Service } = await import(join(packages, 'cordis', 'lib', 'index.js'));
  const { HostConnectionService } = await import(join(packages, 'dsh-client-connection', 'lib', 'index.js'));
  const plugin = await import(PLUGIN);

  /** The server the channel has to land on, standing in for dsh-host-webserver. */
  class WebServer extends Service {
    constructor(ctx) {
      super(ctx, 'webServer');
      this.routes = [];
    }
    register(route) {
      this.routes.push(route);
      return () => {};
    }
  }
  const browserAuth = { isAuthenticated: () => true, authorizeIndex: () => {}, authenticatedUrl: (url) => url };

  const root = new Context();
  root.on('internal/error', (error) => {
    process.stdout.write(`  (cordis error: ${String(error?.message ?? error)})\n`);
  });
  root.plugin({ name: 'stub-web-server', apply: (ctx) => { ctx.set('webServer', new WebServer(ctx)); } });
  root.plugin({ name: 'stub-connection', apply: (ctx) => { ctx.set('connection', new HostConnectionService(ctx, [], browserAuth)); } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  root.plugin(plugin);
  await new Promise((resolve) => setTimeout(resolve, 80));

  const routes = root.webServer.routes;
  check('the probe channel is registered on the web server', routes.length === 1, `${routes.length} route(s)`);
  check('and it is a prefix route at the channel path', routes[0]?.kind === 'prefix' && routes[0]?.path === CHANNEL, JSON.stringify(routes.map((route) => `${route.kind} ${route.path}`)));
  check('with a handler attached', typeof routes[0]?.handler === 'function');

  // The trap itself, so a Cordis change that alters this rule is noticed here
  // rather than as a 405 in someone's browser.
  let threw = null;
  root.plugin({
    name: 'contract-probe',
    apply(ctx) {
      ctx.inject(['connection'], (web) => {
        try {
          web.connection.rpc.handle('/only-connection', () => {});
        } catch (error) {
          threw = String(error?.message ?? error);
        }
      });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  check(
    'reading the registry from a connection-only Context still refuses (the shape this plugin must not use)',
    threw !== null && /without inject/.test(threw),
    String(threw),
  );

  process.stdout.write(`\n${checks - failures}/${checks} checks passed\n\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write(`\nharness error: ${error?.stack ?? error}\n\n`);
  process.exit(2);
});
