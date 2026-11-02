#!/usr/bin/env node
/**
 * Offline acceptance check for the panel: model drag-to-reorder, the gateway
 * thinking-level probe, and the capability fills (context window, output cap,
 * modalities, name) the panel writes alongside them.
 *
 * The plugin is a browser module: it registers itself through
 * `window.__ModuleLoader__` and builds its UI with `React.createElement`. This
 * script supplies both — a loader stub that captures the module, and a small
 * hook runtime that renders the real component tree as plain objects — so the
 * real `client.js` is exercised without a browser: the real drag handlers, the
 * real order state, the real save payload, and the real bookkeeping of both
 * detection endpoints.
 *
 * Rows are addressed by display position throughout, because the panel writes
 * an order as a permutation of document indices: an entry with no id and two
 * entries sharing one are exactly the cases an id-addressed test cannot see.
 *
 * Run: node tools/check-panel.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'client.js');
const SOURCE = readFileSync(CLIENT, 'utf8');

/** The layout the sweep walks: rows stacked from ROW_TOP, ROW_HEIGHT tall. */
const ROW_TOP = 100;
const ROW_HEIGHT = 20;

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

/**
 * A minimal `react` stand-in: `createElement` plus the three hooks the panel
 * uses, with dependency-checked effects and React's same-value bail-out.
 */
function createReact() {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let queued = [];

  function createElement(type, props, ...children) {
    const flat = [];
    const push = (value) => {
      if (value === null || value === undefined || typeof value === 'boolean') return;
      if (Array.isArray(value)) {
        for (const item of value) push(item);
        return;
      }
      flat.push(value);
    };
    for (const child of children) push(child);
    const element = { type, props: { ...(props ?? {}), children: flat } };
    // A function component renders during its parent's pass, so calling it here
    // keeps every hook in the order the real runtime would see.
    if (typeof type === 'function') return type(element.props);
    return element;
  }

  function useState(initial) {
    const at = cursor++;
    if (slots[at] === undefined) slots[at] = { value: typeof initial === 'function' ? initial() : initial };
    const slot = slots[at];
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      dirty = true;
    };
    return [slot.value, set];
  }

  function useRef(initial) {
    const at = cursor++;
    if (slots[at] === undefined) slots[at] = { current: initial };
    return slots[at];
  }

  function useEffect(fn, deps) {
    const at = cursor++;
    const previous = slots[at];
    const changed =
      previous === undefined ||
      deps === undefined ||
      previous.deps === undefined ||
      previous.deps.length !== deps.length ||
      deps.some((value, index) => !Object.is(value, previous.deps[index]));
    slots[at] = { deps: deps ?? undefined, cleanup: previous?.cleanup };
    if (changed) queued.push({ at, fn, cleanup: previous?.cleanup });
  }

  /** Run the effects this render scheduled, after their own cleanups. */
  function flushEffects() {
    const batch = queued;
    queued = [];
    for (const entry of batch) {
      if (typeof entry.cleanup === 'function') entry.cleanup();
      const cleanup = entry.fn();
      slots[entry.at].cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
  }

  /** Render to quiescence: effects, promise callbacks, and re-renders. */
  async function act(render) {
    let tree = null;
    for (let round = 0; round < 60; round += 1) {
      dirty = false;
      cursor = 0;
      queued = [];
      tree = render();
      flushEffects();
      // A macrotask flushes every microtask the effects started (the probe).
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!dirty) return tree;
    }
    throw new Error('render did not settle after 60 rounds');
  }

  return { createElement, useState, useRef, useEffect, act };
}

/** Every host element in a tree, in document order. */
function elements(tree) {
  const out = [];
  const visit = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node.type !== 'string') return;
    out.push(node);
    visit(node.props?.children);
  };
  visit(tree);
  return out;
}

/** Whether an element carries a class token. */
function hasClass(node, name) {
  return String(node?.props?.className ?? '').split(/\s+/).includes(name);
}

/** The text an element renders. */
function textOf(node) {
  return (node?.props?.children ?? []).filter((child) => typeof child === 'string').join('');
}

/** Every text node under an element, in document order — a rendered line may mix spans and text. */
function deepTextOf(node) {
  const parts = [];
  const visit = (value) => {
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (value === null || value === undefined || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    visit(value.props?.children);
  };
  visit(node?.props?.children);
  return parts.join('');
}

/**
 * One panel instance over a mutable settings document.
 * @param options - the models to serve, whether the document is writable, and
 *   optional `probe`/`detect` answers (or functions returning one per call) to
 *   stand in for the Host half's two endpoints, plus an optional write
 *   behaviour (defaults to an accepted write) standing in for the shared form's
 *   mutate().
 */
function createPanel({ models, writable = true, probe, detect, write } = {}) {
  const React = createReact();
  let captured = null;
  new Function('window', SOURCE)({ __ModuleLoader__: { load: (module) => { captured = module; } } });
  if (captured === null) throw new Error('client.js did not register a module');

  const writes = [];
  const probes = [];
  const detects = [];
  const listeners = new Set();
  let registered = null;
  let revision = 1;
  let current = models;
  const snapshot = () => ({
    status: 'ready',
    view: {
      writable,
      namespaces: [
        { ns: 'llm-pi-ai', revision, value: { providers: { cpa: { displayName: 'cpa', models: current } } } },
      ],
    },
  });

  const plugin = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`client.js required an unexpected module: ${name}`);
  });

  /**
   * Answer one RPC call on the plugin's channel, dispatched by endpoint the way
   * the Host half dispatches. A missing stub falls back to the "no channel"
   * failure the real transport reports.
   */
  const connection = {
    rpc: {
      call: (_channel, endpoint, payload) => {
        const stub = endpoint === 'detect' ? detect : probe;
        const log = endpoint === 'detect' ? detects : probes;
        log.push(payload);
        const answer = typeof stub === 'function' ? stub(log.length, payload) : stub;
        return Promise.resolve(answer ?? { ok: false, error: { code: 'no-connection', message: 'this page has no connection to the Host' } });
      },
    },
  };

  const ctx = {
    effect: (fn) => fn(),
    // Copy lookup the way the Host's locale service does it: a missing key
    // renders as itself, and placeholders make the copy's inputs observable.
    locale: {
      register: () => {},
      bind: () => (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`),
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (spec, component) => {
        registered = { spec, component };
        return () => {};
      },
    },
    configForms: {
      describe: () => ({
        getSnapshot: snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        load: async () => {},
      }),
      // The shared form's write. It may accept, refuse, throw synchronously or
      // reject; the panel must settle on a rendered status in every case.
      get: () => ({
        mutate: (ops) => {
          writes.push(ops);
          return typeof write === 'function' ? write(ops) : Promise.resolve(true);
        },
      }),
    },
    get: (name) => (name === 'connection' ? connection : undefined),
  };
  plugin.apply(ctx);
  if (registered === null) throw new Error('client.js registered no provider-card seat');

  const props = { provider: { declared: true, settingsPath: ['providers', 'cpa'] }, ...registered.spec.inject() };
  let tree = null;

  const panel = {
    writes,
    probes,
    detects,
    get tree() {
      return tree;
    },
    /** Render to quiescence. */
    async render() {
      tree = await React.act(() => registered.component(props));
      return tree;
    },
    /** Call one handler found in the current tree, then settle the re-render. */
    async fire(find, invoke) {
      const node = find(elements(tree));
      if (node === undefined) throw new Error('handler target not found');
      invoke(node);
      await panel.render();
    },
    /** Publish a new document, as another surface of the app would. */
    async setDocument(next) {
      current = next;
      revision += 1;
      for (const listener of listeners) listener();
      await panel.render();
    },
    rows: () => elements(tree).filter((node) => hasClass(node, 'dsh-tl-row')),
    /** Each row's rendered model id, or 'unnamed'. */
    ids: () => panel.rows().map((row) => textOf(elements(row).find((node) => node.type === 'code'))),
    /** Each row's React key — the document index the row is addressed by. */
    keys: () => panel.rows().map((row) => row.props.key),
    rowAt: (at) => panel.rows()[at],
    /** The status line's rendered text (the "saving"/"saved"/"unsaved" slot). */
    statusText: () => textOf(elements(tree).find((node) => hasClass(node, 'dsh-tl-status'))),
    gripAt: (at) => elements(panel.rows()[at]).find((node) => hasClass(node, 'dsh-tl-grip') || hasClass(node, 'dsh-tl-grip-off')),
    save: () => elements(tree).find((node) => hasClass(node, 'dsh-tl-primary')),
    summary: () => elements(tree).find((node) => hasClass(node, 'dsh-tl-summary')),
    body: () => elements(tree).find((node) => hasClass(node, 'dsh-tl-body')),
    hints: () => elements(tree).filter((node) => hasClass(node, 'dsh-tl-hint')).map(textOf),
    /** The probe's route-level line, whichever state it is in (a failure is drawn as an error). */
    detectText: () => elements(tree)
      .filter((node) => hasClass(node, 'dsh-tl-hint') || hasClass(node, 'dsh-tl-error'))
      .map(textOf)
      .find((text) => text.startsWith('detect')) ?? '',
    /** Each row's note (the gateway's table, or a probe failure). */
    notes: () => panel.rows().map((row) => textOf(elements(row).find((node) => hasClass(node, 'dsh-tl-note')))),
    /** Each row's capability line, or an empty string when detection said nothing about it. */
    metas: () => panel.rows().map((row) => deepTextOf(elements(row).find((node) => hasClass(node, 'dsh-tl-meta')))),
    /** The capability line's own class, so a conflict can be told from a plain fill. */
    metaAt: (at) => elements(panel.rows()[at]).find((node) => hasClass(node, 'dsh-tl-meta')),
    /** The "use the detected value" button in one row, when it has one. */
    adoptAt: (at) => elements(panel.rows()[at]).find((node) => hasClass(node, 'dsh-tl-adopt')),
    /** The capability detector's route-level line, whichever state it is in. */
    capsText: () =>
      elements(tree)
        .filter((node) => hasClass(node, 'dsh-tl-hint') || hasClass(node, 'dsh-tl-error'))
        .map(textOf)
        .find((text) => text.startsWith('meta')) ?? '',
    chipAt: (at, level) => elements(panel.rows()[at]).find((node) => hasClass(node, 'dsh-tl-chip') && textOf(node) === `level.${level}`),
  };
  return panel;
}

/** A model entry that already declares the recommended levels. */
function declaredModel(id, extra = {}) {
  return {
    id,
    name: id,
    contextWindow: 1000,
    maxTokens: 100,
    input: ['text'],
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
    ...extra,
  };
}

/** A model entry with an id and nothing else — the case capability detection exists for. */
function plainModel(id, extra = {}) {
  return { id, ...extra };
}

/**
 * A drag payload stand-in. `top` is the target row's own offset, so the
 * midline the handler compares against is the row's, not a fixed one.
 */
function dragEvent({ top = ROW_TOP, clientY = ROW_TOP, ...rest } = {}) {
  return {
    preventDefault: () => {},
    dataTransfer: { effectAllowed: '', dropEffect: '', setData: () => {}, setDragImage: () => {} },
    currentTarget: { getBoundingClientRect: () => ({ top, height: ROW_HEIGHT }), closest: () => null },
    clientY,
    ...rest,
  };
}

/** A drag event that records whether the handler accepted the drop. */
function spyEvent(overrides = {}) {
  const event = dragEvent(overrides);
  const calls = { preventDefault: 0 };
  event.preventDefault = () => {
    calls.preventDefault += 1;
  };
  return { event, calls };
}

/** Expand the panel when it is closed, and return the rendered tree. */
async function expand(panel) {
  await panel.render();
  if (panel.summary().props['aria-expanded'] !== true) {
    await panel.fire(() => panel.summary(), (node) => node.props.onClick());
  }
  return panel.tree;
}

/**
 * Drag the row at `from` onto the row at `to` and drop it there. `after` picks
 * which half of the target the pointer enters — the bottom half moves the row
 * down past the target, the top half moves it up in front of it.
 */
async function dragOnto(panel, from, to, after = true) {
  const top = ROW_TOP + ROW_HEIGHT * to;
  const clientY = after ? top + ROW_HEIGHT - 1 : top + 1;
  await panel.fire(() => panel.gripAt(from), (node) => {
    node.props.onDragStart(dragEvent());
  });
  await panel.fire(() => panel.rowAt(to), (node) => {
    node.props.onDragOver(dragEvent({ top, clientY }));
  });
  await panel.fire(() => panel.rowAt(to), (node) => {
    node.props.onDrop(dragEvent({ top, clientY }));
  });
}

/**
 * Sweep a pointer down the list while dragging the first row, firing one
 * `dragover` per pixel step against the row that really sits under the pointer,
 * then drop on the last row.
 */
async function dragSweep(panel, from, to) {
  await panel.fire(() => panel.gripAt(0), (node) => {
    node.props.onDragStart(dragEvent());
  });
  for (let y = from; y <= to; y += 1) {
    const at = Math.max(0, Math.min(panel.rows().length - 1, Math.floor((y - ROW_TOP) / ROW_HEIGHT)));
    const top = ROW_TOP + ROW_HEIGHT * at;
    await panel.fire(() => panel.rowAt(at), (node) => {
      node.props.onDragOver(dragEvent({ top, clientY: y }));
    });
  }
  const last = panel.rows().length - 1;
  await panel.fire(() => panel.rowAt(last), (node) => {
    node.props.onDrop(dragEvent({ top: ROW_TOP + ROW_HEIGHT * last, clientY: to }));
  });
}

async function main() {
  process.stdout.write('\nmodel order — drag and drop\n');

  // 1. Baseline: rows follow the document, nothing to save yet.
  const panel = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')] });
  await expand(panel);
  check('rows render in document order', same(panel.ids(), ['alpha', 'bravo', 'charlie']), panel.ids().join(','));
  check('rows are keyed by document index', same(panel.keys(), [0, 1, 2]), JSON.stringify(panel.keys()));
  check('every row offers a drag handle', [0, 1, 2].every((at) => {
    const grip = panel.gripAt(at);
    return grip !== undefined && hasClass(grip, 'dsh-tl-grip') && grip.props.draggable === true && grip.props.tabIndex === 0;
  }));
  check('save is disabled while nothing changed', panel.save().props.disabled === true);

  // 2. Dragging marks a slot, and only the drop moves the row.
  const rowTwoTop = ROW_TOP + ROW_HEIGHT * 2;
  const rowTwoLow = rowTwoTop + ROW_HEIGHT - 1;
  await panel.fire(() => panel.gripAt(0), (node) => node.props.onDragStart(dragEvent()));
  await panel.fire(() => panel.rowAt(2), (node) => node.props.onDragOver(dragEvent({ top: rowTwoTop, clientY: rowTwoLow })));
  check('the dragged row is styled', hasClass(panel.rowAt(0), 'dsh-tl-row-dragging'));
  check('the landing slot is marked', hasClass(panel.rowAt(2), 'dsh-tl-row-drop-after'));
  check('and the rows have not moved yet', same(panel.ids(), ['alpha', 'bravo', 'charlie']), panel.ids().join(','));
  await panel.fire(() => panel.rowAt(2), (node) => node.props.onDrop(dragEvent({ top: rowTwoTop, clientY: rowTwoLow })));
  check('dropping commits the move', same(panel.ids(), ['bravo', 'charlie', 'alpha']), panel.ids().join(','));
  check('the drag styling is cleared on drop', !hasClass(panel.rowAt(2), 'dsh-tl-row-dragging') && !hasClass(panel.rowAt(2), 'dsh-tl-row-drop-after'));
  check('save becomes enabled once the order moved', panel.save().props.disabled === false);

  // 3. Saving writes the dragged order, with every field intact.
  await panel.fire(() => panel.save(), (node) => node.props.onClick());
  const ops = panel.writes.at(-1);
  const written = ops?.[0]?.value;
  check('save writes one set op on the route models', ops?.length === 1 && ops[0].op === 'set' && same(ops[0].path, ['providers', 'cpa', 'models']), JSON.stringify(ops?.[0]?.path));
  check('the written array carries the dragged order', same((written ?? []).map((model) => model.id), ['bravo', 'charlie', 'alpha']), JSON.stringify((written ?? []).map((model) => model.id)));
  check('every entry keeps its fields', (written ?? []).every((model) => model.contextWindow === 1000 && model.maxTokens === 100 && model.input?.[0] === 'text'));
  check('every entry keeps its declared levels', (written ?? []).every((model) => model.reasoningEfforts?.low === 'low' && model.reasoningEfforts?.high === 'high'));

  // 3b. A write that FAILS must settle on a rendered status, never sit on
  //     "saving" with the button disabled. The shared form's mutate() can
  //     throw synchronously or reject (no connection, dropped request), and the
  //     panel sets "saving" before it awaits the answer, so an escaping
  //     rejection used to strand the panel: "saving" forever, change unsaved,
  //     no way to retry. Each failure shape is covered separately.
  const failureShapes = {
    'rejects': () => Promise.reject(new Error('transport down')),
    'throws synchronously': () => { throw new Error('no connection to the Host'); },
    'answers false': () => Promise.resolve(false),
  };
  for (const [shape, write] of Object.entries(failureShapes)) {
    const failing = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo')], write });
    await expand(failing);
    await failing.fire(() => failing.gripAt(0), (node) => node.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} }));
    await failing.fire(() => failing.save(), (node) => node.props.onClick());
    // The harness settles promise callbacks, so a stranded "saving" is visible.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await failing.render();
    const status = failing.statusText();
    check(`a write that ${shape} stops saying "saving"`, !/saving|\u4fdd\u5b58\u4e2d/i.test(status), JSON.stringify(status));
    check(`a write that ${shape} leaves the change unsaved, so it can be retried`, status.length > 0 && failing.save().props.disabled === false, JSON.stringify(status));
  }

  // 4. Dragging back to the document's own order is not a change.
  const back = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')] });
  await expand(back);
  await dragOnto(back, 0, 1);
  check('a one-step drag reorders', same(back.ids(), ['bravo', 'alpha', 'charlie']), back.ids().join(','));
  await dragOnto(back, 1, 0, false);
  check('dragging back restores the document order', same(back.ids(), ['alpha', 'bravo', 'charlie']), back.ids().join(','));
  check('and leaves nothing to save', back.save().props.disabled === true);

  // 4b. The upward direction works across more than one row.
  const up = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')] });
  await expand(up);
  await dragOnto(up, 2, 0, false);
  check('dragging upward past two rows reorders', same(up.ids(), ['charlie', 'alpha', 'bravo']), up.ids().join(','));

  // 5. The keyboard reaches the same order state.
  const keys = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')] });
  await expand(keys);
  await keys.fire(() => keys.gripAt(0), (node) => node.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} }));
  check('ArrowDown moves a row one step', same(keys.ids(), ['bravo', 'alpha', 'charlie']), keys.ids().join(','));
  await keys.fire(() => keys.gripAt(1), (node) => node.props.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} }));
  check('ArrowUp moves it back', same(keys.ids(), ['alpha', 'bravo', 'charlie']), keys.ids().join(','));

  // 6. Levels still save, and do not disturb the order.
  const chips = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo')] });
  await expand(chips);
  await chips.fire(() => chips.chipAt(1, 'medium'), (node) => node.props.onClick());
  await chips.fire(() => chips.save(), (node) => node.props.onClick());
  const chipWrite = chips.writes.at(-1)?.[0]?.value;
  check('a chip edit keeps the order', same((chipWrite ?? []).map((model) => model.id), ['alpha', 'bravo']), JSON.stringify((chipWrite ?? []).map((model) => model.id)));
  check('a chip edit drops exactly that level', chipWrite?.[1]?.reasoningEfforts?.medium === undefined && chipWrite?.[1]?.reasoningEfforts?.low === 'low');

  // 7. A read-only document offers no handle.
  const readonly = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo')], writable: false });
  await expand(readonly);
  check('a read-only document hides the handle', hasClass(readonly.gripAt(0), 'dsh-tl-grip-off') && readonly.gripAt(0).props.draggable === false);

  // 8. An entry with no id is a row like any other: a drag permutes it exactly,
  //    never teleports it to the end, and the panel reports the change.
  const unnamed = createPanel({ models: [declaredModel('alpha'), { name: 'no id' }, declaredModel('bravo')] });
  await expand(unnamed);
  check('an id-less entry renders in place', same(unnamed.ids(), ['alpha', 'unnamed', 'bravo']), unnamed.ids().join(','));
  await dragOnto(unnamed, 0, 2);
  check('moving alpha down shifts the id-less entry up', same(unnamed.ids(), ['unnamed', 'bravo', 'alpha']), unnamed.ids().join(','));
  check('that permutation is a change to save', unnamed.save().props.disabled === false);
  await unnamed.fire(() => unnamed.save(), (node) => node.props.onClick());
  const unnamedWrite = unnamed.writes.at(-1)?.[0]?.value ?? [];
  check('the write keeps every entry', unnamedWrite.length === 3, JSON.stringify(unnamedWrite.map((model) => model.id)));
  check('and writes the exact permutation', unnamedWrite[2]?.id === 'alpha' && unnamedWrite[0]?.id === undefined, JSON.stringify(unnamedWrite.map((model) => model.id)));

  // 8b. A permutation dragged back to the document's own order is not a change,
  //     even with an id-less entry sitting in the middle.
  const restore = createPanel({ models: [declaredModel('alpha'), { name: 'no id' }, declaredModel('bravo')] });
  await expand(restore);
  await dragOnto(restore, 0, 2);
  await dragOnto(restore, 2, 0, false);
  check('dragging back restores the document order', same(restore.ids(), ['alpha', 'unnamed', 'bravo']), restore.ids().join(','));
  check('and reports nothing to save', restore.save().props.disabled === true);

  // 9. Two entries sharing an id are two distinct rows, each with a working
  //    handle — the second one included.
  const dupes = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('alpha'), declaredModel('charlie')] });
  await expand(dupes);
  check('the second duplicate row is draggable', dupes.gripAt(2).props.draggable === true && dupes.gripAt(2).props.tabIndex === 0);
  check('duplicate rows carry distinct keys', new Set(dupes.keys()).size === 4, JSON.stringify(dupes.keys()));
  await dragOnto(dupes, 2, 1, false);
  check('the second duplicate row moves', same(dupes.keys(), [0, 2, 1, 3]), JSON.stringify(dupes.keys()));
  await dupes.fire(() => dupes.save(), (node) => node.props.onClick());
  const dupeWrite = dupes.writes.at(-1)?.[0]?.value ?? [];
  check('and the write keeps all four entries', dupeWrite.length === 4, JSON.stringify(dupeWrite.map((model) => model.id)));

  // 10. The keyboard reaches a duplicate row too.
  const dupeKeys = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('alpha')] });
  await expand(dupeKeys);
  await dupeKeys.fire(() => dupeKeys.gripAt(2), (node) => node.props.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} }));
  check('ArrowUp moves the second duplicate row', same(dupeKeys.keys(), [0, 2, 1]), JSON.stringify(dupeKeys.keys()));

  // 11. A drag without a DataTransfer (a synthetic or automated event) must not
  //     throw, and dragend must always clear the styling.
  const synthetic = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo')] });
  await expand(synthetic);
  let threw = null;
  try {
    await synthetic.fire(() => synthetic.gripAt(0), (node) => node.props.onDragStart({ currentTarget: { closest: () => null } }));
  } catch (error) {
    threw = error;
  }
  check('a dragstart with no dataTransfer does not throw', threw === null, String(threw));
  await synthetic.fire(() => synthetic.gripAt(0), (node) => node.props.onDragStart(dragEvent()));
  const synTop = ROW_TOP + ROW_HEIGHT;
  await synthetic.fire(() => synthetic.rowAt(1), (node) => node.props.onDragOver(dragEvent({ top: synTop, clientY: synTop + 1 })));
  await synthetic.fire(() => synthetic.gripAt(0), (node) => node.props.onDragEnd());
  check('dragend clears the drag styling', !hasClass(synthetic.rowAt(0), 'dsh-tl-row-dragging') && !hasClass(synthetic.rowAt(1), 'dsh-tl-row-drop-after'));
  await synthetic.fire(() => synthetic.rowAt(1), (node) => node.props.onDrop(dragEvent({ top: synTop, clientY: synTop + 1 })));
  check('a drop after dragend does nothing', same(synthetic.ids(), ['alpha', 'bravo']), synthetic.ids().join(','));
  check('and leaves nothing to save', synthetic.save().props.disabled === true);

  // 12. Hovering the row that already sits next to the dragged one marks no
  //     slot, because dropping there would move nothing.
  const noop = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')] });
  await expand(noop);
  const noopTop = ROW_TOP + ROW_HEIGHT;
  await noop.fire(() => noop.gripAt(0), (node) => node.props.onDragStart(dragEvent()));
  await noop.fire(() => noop.rowAt(1), (node) => node.props.onDragOver(dragEvent({ top: noopTop, clientY: noopTop + 1 })));
  check('an adjacent no-op hover marks no slot', !hasClass(noop.rowAt(1), 'dsh-tl-row-drop-before') && !hasClass(noop.rowAt(1), 'dsh-tl-row-drop-after'));
  await noop.fire(() => noop.rowAt(1), (node) => node.props.onDrop(dragEvent({ top: noopTop, clientY: noopTop + 1 })));
  check('and its drop changes nothing', same(noop.ids(), ['alpha', 'bravo', 'charlie']), noop.ids().join(','));

  // 13. A document change elsewhere drops the pending arrangement rather than
  //     writing it over a list that moved underneath.
  const external = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')] });
  await expand(external);
  await dragOnto(external, 0, 2);
  check('the arrangement is pending before the outside edit', external.save().props.disabled === false);
  await external.setDocument([declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie'), declaredModel('delta')]);
  check('an outside edit restores the document order', same(external.ids(), ['alpha', 'bravo', 'charlie', 'delta']), external.ids().join(','));
  check('and clears the pending change', external.save().props.disabled === true);

  // 14. A full sweep is a stream of events, not one: the row must still land
  //     where the pointer ends up.
  const sweep = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie'), declaredModel('delta')] });
  await expand(sweep);
  await dragSweep(sweep, ROW_TOP + 5, ROW_TOP + ROW_HEIGHT * 4 - 1);
  check('a full downward sweep lands the row last', same(sweep.ids(), ['bravo', 'charlie', 'delta', 'alpha']), sweep.ids().join(','));

  // 15. A drop is only accepted when the handler says so: a real browser needs
  //     the dragover to cancel the default, or no drop event ever arrives.
  const guard = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')] });
  await expand(guard);
  const guardTop = ROW_TOP + ROW_HEIGHT * 2;
  const guardLow = guardTop + ROW_HEIGHT - 1;
  await guard.fire(() => guard.gripAt(0), (node) => node.props.onDragStart(dragEvent()));
  const over = spyEvent({ top: guardTop, clientY: guardLow });
  await guard.fire(() => guard.rowAt(2), (node) => node.props.onDragOver(over.event));
  check('dragover cancels the default so a drop is allowed', over.calls.preventDefault === 1);
  check('dragover asks for a move', over.event.dataTransfer.dropEffect === 'move');
  const released = spyEvent({ top: guardTop, clientY: guardLow });
  await guard.fire(() => guard.rowAt(2), (node) => node.props.onDrop(released.event));
  check('drop cancels the default', released.calls.preventDefault === 1);

  // 16. Keyboard boundaries, and a drop on the dragged row itself.
  const bounds = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo')] });
  await expand(bounds);
  await bounds.fire(() => bounds.gripAt(0), (node) => node.props.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} }));
  check('ArrowUp on the first row does nothing', same(bounds.ids(), ['alpha', 'bravo']) && bounds.save().props.disabled === true);
  await bounds.fire(() => bounds.gripAt(1), (node) => node.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} }));
  check('ArrowDown on the last row does nothing', same(bounds.ids(), ['alpha', 'bravo']) && bounds.save().props.disabled === true);
  await bounds.fire(() => bounds.gripAt(0), (node) => node.props.onKeyDown({ key: 'Tab', preventDefault: () => {} }));
  check('another key leaves the order alone', same(bounds.ids(), ['alpha', 'bravo']) && bounds.save().props.disabled === true);
  await bounds.fire(() => bounds.gripAt(0), (node) => node.props.onDragStart(dragEvent()));
  await bounds.fire(() => bounds.rowAt(0), (node) => node.props.onDrop(dragEvent({ top: ROW_TOP, clientY: ROW_TOP + 1 })));
  check('dropping a row on itself changes nothing', same(bounds.ids(), ['alpha', 'bravo']) && bounds.save().props.disabled === true);

  // 17. Releasing over the panel rather than on a row commits the slot that was
  //     marked last, instead of silently discarding the drag.
  const gap = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')] });
  await expand(gap);
  await gap.fire(() => gap.gripAt(0), (node) => node.props.onDragStart(dragEvent()));
  await gap.fire(() => gap.rowAt(2), (node) => node.props.onDragOver(dragEvent({ top: guardTop, clientY: guardLow })));
  await gap.fire(() => gap.body(), (node) => node.props.onDrop(dragEvent()));
  check('releasing over the panel commits the marked slot', same(gap.ids(), ['bravo', 'charlie', 'alpha']), gap.ids().join(','));

  // 18. A drag belongs to the document it started on. An outside write during
  //     the drag must abandon it, not move whichever model inherited the index.
  const race = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')] });
  await expand(race);
  await race.fire(() => race.gripAt(2), (node) => node.props.onDragStart(dragEvent()));
  await race.setDocument([declaredModel('delta'), declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')]);
  await race.fire(() => race.rowAt(0), (node) => node.props.onDragOver(dragEvent({ top: ROW_TOP, clientY: ROW_TOP + ROW_HEIGHT - 1 })));
  await race.fire(() => race.rowAt(0), (node) => node.props.onDrop(dragEvent({ top: ROW_TOP, clientY: ROW_TOP + ROW_HEIGHT - 1 })));
  check('an outside write abandons the drag', same(race.ids(), ['delta', 'alpha', 'bravo', 'charlie']), race.ids().join(','));
  check('and leaves nothing to save', race.save().props.disabled === true);

  // 18b. The same race, delivered to the handler captured before the write —
  //      the shape a real browser produces when it fires at a stale listener.
  const stale = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')] });
  await expand(stale);
  await stale.fire(() => stale.gripAt(2), (node) => node.props.onDragStart(dragEvent()));
  const staleRow = stale.rowAt(0);
  await stale.setDocument([declaredModel('delta'), declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')]);
  staleRow.props.onDrop(dragEvent({ top: ROW_TOP, clientY: ROW_TOP + ROW_HEIGHT - 1 }));
  await stale.render();
  check('a stale drop handler cannot move a row', same(stale.ids(), ['delta', 'alpha', 'bravo', 'charlie']), stale.ids().join(','));
  check('and still leaves nothing to save', stale.save().props.disabled === true);

  // 19. Keys stay a permutation of the document indices through a reorder, so
  //     React never sees a duplicate key.
  const keyed = createPanel({ models: [declaredModel('alpha'), declaredModel('bravo'), declaredModel('charlie')] });
  await expand(keyed);
  await dragOnto(keyed, 0, 2);
  check('keys stay a permutation after a reorder', same([...keyed.keys()].sort((a, b) => a - b), [0, 1, 2]), JSON.stringify(keyed.keys()));

  // 20. The reorder hint appears exactly when there is more than one row.
  check('the reorder hint appears with more than one row', keyed.hints().includes('orderHint'));
  const lone = createPanel({ models: [declaredModel('alpha')] });
  await expand(lone);
  check('and not with a single row', !lone.hints().includes('orderHint'));

  // 21. A gateway that accepts the bogus level validates nothing, and that is
  //     the only state that may read as "the names are not checked".
  const unchecked = createPanel({
    models: [declaredModel('alpha'), declaredModel('bravo')],
    probe: {
      ok: true,
      value: { results: [{ model: 'alpha', kind: 'unchecked' }, { model: 'bravo', kind: 'unchecked' }] },
    },
  });
  await expand(unchecked);
  check('an accepting gateway reads as "does not validate names"', unchecked.detectText() === 'detectUnchecked', unchecked.detectText());

  // 22. A model the gateway refused is not the same thing, and must say so.
  const refused = createPanel({
    models: [declaredModel('alpha'), declaredModel('bravo')],
    probe: {
      ok: true,
      value: {
        results: [
          { model: 'alpha', kind: 'refused', status: 502, detail: 'bad gateway' },
          { model: 'bravo', kind: 'levels', levels: ['low', 'high'] },
        ],
      },
    },
  });
  await expand(refused);
  check('a refused model is not read as "does not validate names"', refused.detectText().startsWith('detectPartial'), refused.detectText());
  check('the refused row reports its own failure', refused.notes()[0].startsWith('detectModelFailed'), JSON.stringify(refused.notes()));
  check('the answered row still shows its table', refused.notes()[1] === 'detectedmeta.colonlevel.low / level.high', refused.notes()[1]);

  // 22b. An unreachable model is reported the same way.
  const unreachable = createPanel({
    models: [declaredModel('alpha')],
    probe: { ok: true, value: { results: [{ model: 'alpha', kind: 'unreachable', detail: 'fetch failed' }] } },
  });
  await expand(unreachable);
  check('an unreachable model is reported too', unreachable.detectText().startsWith('detectPartial') && unreachable.notes()[0].startsWith('detectModelFailed'));

  // 23. Only a clean answer is cached, so a failed probe is retried when the
  //     panel is opened again rather than remembered as final.
  const retryable = createPanel({
    models: [declaredModel('alpha')],
    probe: (call) => (call === 1
      ? { ok: true, value: { results: [{ model: 'alpha', kind: 'refused', status: 502, detail: 'bad gateway' }] } }
      : { ok: true, value: { results: [{ model: 'alpha', kind: 'levels', levels: ['low'] }] } }),
  });
  await expand(retryable);
  check('the first probe reports the failure', retryable.detectText().startsWith('detectPartial'), retryable.detectText());
  await retryable.fire(() => retryable.summary(), (node) => node.props.onClick());
  await retryable.fire(() => retryable.summary(), (node) => node.props.onClick());
  check('a failed probe is asked again on the next visit', retryable.probes.length === 2, String(retryable.probes.length));
  check('and the second answer is used', retryable.notes()[0] === 'detectedmeta.colonlevel.low', retryable.notes()[0]);

  // 24. The desktop app's update lock answers every request with a bare 503.
  //     That is a "come back in a moment", not a transport error to read.
  const locked = createPanel({
    models: [declaredModel('alpha')],
    probe: (call) => (call === 1
      ? { ok: false, error: { code: 'transport', message: 'transport failure for /dsh-model-thinking-levels/probe: HTTP 503' } }
      : { ok: true, value: { results: [{ model: 'alpha', kind: 'levels', levels: ['low'] }] } }),
  });
  await expand(locked);
  check('the desktop update lock reads as busy', locked.detectText() === 'detectBusy', locked.detectText());
  await new Promise((resolve) => setTimeout(resolve, 2700));
  await locked.render();
  check('and the panel retries by itself', locked.probes.length === 2, String(locked.probes.length));
  check('the retry is used', locked.notes()[0] === 'detectedmeta.colonlevel.low', locked.notes()[0]);

  // 24b. Any other transport failure is still reported as itself.
  const broken = createPanel({
    models: [declaredModel('alpha')],
    probe: { ok: false, error: { code: 'transport', message: 'transport failure for /x/probe: HTTP 500' } },
  });
  await expand(broken);
  check('another transport failure is reported as itself', broken.detectText().startsWith('detectFailed'), broken.detectText());

  // 24c. A channel that was never registered leaves the POST to the static
  //      handler, which answers 405 — the one failure a restart fixes.
  const missing = createPanel({
    models: [declaredModel('alpha')],
    probe: { ok: false, error: { code: 'transport', message: 'transport failure for /dsh-model-thinking-levels/probe: HTTP 405' } },
  });
  await expand(missing);
  check('a missing host channel is named as such', missing.detectText().startsWith('detectNoChannel'), missing.detectText());

  process.stdout.write('\ncapabilities — detected context, output cap, modalities, name\n');

  // 25. A model entry that states nothing about itself gets the detected
  //     context window, output cap, modalities, and display name, and a save
  //     carries them into the document without the user typing any of it.
  const fill = createPanel({
    models: [declaredModel('alpha'), plainModel('bravo')],
    probe: { ok: true, value: { results: [{ model: 'bravo', kind: 'levels', levels: ['low', 'medium', 'high'] }] } },
    detect: {
      ok: true,
      value: {
        gateway: { ok: true },
        results: [
          { model: 'alpha', gateway: { contextWindow: 1000, maxTokens: 100, input: ['text'] } },
          {
            model: 'bravo',
            official: {
              confidence: 'vendor',
              provider: 'openai',
              name: 'Bravo',
              contextWindow: 272000,
              maxTokens: 128000,
              input: ['text', 'image'],
              levels: ['low', 'medium', 'high'],
            },
          },
        ],
      },
    },
  });
  await expand(fill);
  check('the detect call names the route and its models', JSON.stringify(fill.detects[0]) === JSON.stringify({ settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'cpa'], models: ['alpha', 'bravo'] }), JSON.stringify(fill.detects[0]));
  check('a model that already states its capabilities says nothing', fill.metas()[0] === '', fill.metas()[0]);
  check('the detected capabilities are announced', fill.metas()[1].startsWith('metaFill'), fill.metas()[1]);
  check('with every field named', ['272', '128', 'modality.text+modality.image', 'field.name Bravo'].every((part) => fill.metas()[1].includes(part)), fill.metas()[1]);
  check('and the official catalog named as the source', fill.metas()[1].includes('source.official'), fill.metas()[1]);
  check('the missing fields alone make the panel dirty', fill.save().props.disabled === false);
  await fill.fire(() => fill.save(), (node) => node.props.onClick());
  const filled = fill.writes.at(-1)?.[0]?.value ?? [];
  check('the save writes the detected fields', filled[1]?.contextWindow === 272000 && filled[1]?.maxTokens === 128000, JSON.stringify(filled[1]));
  check('the modalities are written as a pi-ai input list', same(filled[1]?.input ?? [], ['text', 'image']), JSON.stringify(filled[1]?.input));
  check('the display name is written too', filled[1]?.name === 'Bravo', JSON.stringify(filled[1]?.name));
  check('the model that stated its own fields keeps them', filled[0]?.contextWindow === 1000 && filled[0]?.maxTokens === 100);

  // 26. A stated value is never overwritten: the disagreement is reported, and
  //     only the explicit "use detected" action takes it over.
  const clash = createPanel({
    models: [declaredModel('alpha', { contextWindow: 1000000 })],
    probe: { ok: true, value: { results: [{ model: 'alpha', kind: 'levels', levels: ['low', 'medium', 'high'] }] } },
    detect: {
      ok: true,
      value: {
        gateway: { ok: true },
        results: [
          {
            model: 'alpha',
            official: {
              confidence: 'vendor',
              provider: 'google',
              name: 'Alpha',
              contextWindow: 1048576,
              maxTokens: 65536,
              input: ['text', 'image'],
              levels: ['low', 'medium', 'high'],
            },
          },
        ],
      },
    },
  });
  await expand(clash);
  check('a differing value is reported as a conflict', clash.metas()[0].startsWith('metaConflict'), clash.metas()[0]);
  check('both the current and the detected value are shown', clash.metas()[0].includes('1,000,000') && clash.metas()[0].includes('1,048,576'), clash.metas()[0]);
  check('a conflict alone leaves nothing to save', clash.save().props.disabled === true);
  check('and the row offers to take the detected values', clash.adoptAt(0) !== undefined);
  await clash.fire(() => clash.adoptAt(0), (node) => node.props.onClick());
  check('taking them clears the conflict', clash.metas()[0].startsWith('metaAdopted'), clash.metas()[0]);
  check('and makes the change savable', clash.save().props.disabled === false);
  await clash.fire(() => clash.save(), (node) => node.props.onClick());
  const clashed = clash.writes.at(-1)?.[0]?.value ?? [];
  check('the taken value replaces the stated one', clashed[0]?.contextWindow === 1048576, JSON.stringify(clashed[0]?.contextWindow));
  check('the other detected fields were filled at the same time', clashed[0]?.maxTokens === 65536, JSON.stringify(clashed[0]?.maxTokens));

  // 27. A catalog reading nothing can rank is reported, never written.
  const vague = createPanel({
    models: [plainModel('charlie', { reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } })],
    probe: { ok: true, value: { results: [{ model: 'charlie', kind: 'levels', levels: ['low', 'medium', 'high'] }] } },
    detect: {
      ok: true,
      value: {
        gateway: { ok: true },
        results: [
          {
            model: 'charlie',
            official: {
              confidence: 'ambiguous',
              provider: 'opencode',
              levels: ['low', 'medium', 'high'],
              variants: [{ contextWindow: 272000 }, { contextWindow: 1048576 }],
            },
          },
        ],
      },
    },
  });
  await expand(vague);
  check('an unranked reading is reported', vague.metas()[0].startsWith('metaAmbiguous'), vague.metas()[0]);
  check('with the competing values named', vague.metas()[0].includes('272') && vague.metas()[0].includes('1,048,576'), vague.metas()[0]);
  check('and nothing is filled in', vague.save().props.disabled === true);

  // 28. A model the catalog calls non-reasoning stays non-reasoning even when
  //     the gateway lists its own default table — the documented CLIProxyAPI
  //     trap for custom providers it was never told about.
  const nonReasoning = createPanel({
    models: [plainModel('ghost')],
    probe: { ok: true, value: { results: [{ model: 'ghost', kind: 'levels', levels: ['low', 'medium', 'high'] }] } },
    detect: {
      ok: true,
      value: {
        gateway: { ok: true },
        results: [{ model: 'ghost', official: { confidence: 'agreement', provider: 'openai', levels: [] } }],
      },
    },
  });
  await expand(nonReasoning);
  check('the catalog non-reasoning reading makes the panel dirty', nonReasoning.save().props.disabled === false);
  await nonReasoning.fire(() => nonReasoning.save(), (node) => node.props.onClick());
  const ghost = (nonReasoning.writes.at(-1)?.[0]?.value ?? [])[0];
  check('and saving declares the model non-reasoning', ghost?.reasoningEfforts === false, JSON.stringify(ghost?.reasoningEfforts));

  // 29. A detect call that fails leaves the level probe's answer usable and
  //     says so once, at route level.
  const noCaps = createPanel({
    models: [plainModel('delta')],
    probe: { ok: true, value: { results: [{ model: 'delta', kind: 'levels', levels: ['low', 'high'] }] } },
    detect: { ok: false, error: { code: 'transport', message: 'transport failure for /x/detect: HTTP 500' } },
  });
  await expand(noCaps);
  check('a failed capability detection says so', noCaps.capsText().startsWith('metaFailed'), noCaps.capsText());
  check('the level probe still fills what it knows', noCaps.save().props.disabled === false);
  await noCaps.fire(() => noCaps.save(), (node) => node.props.onClick());
  const delta = (noCaps.writes.at(-1)?.[0]?.value ?? [])[0];
  check('and the levels are what the gateway listed', same(Object.keys(delta?.reasoningEfforts ?? {}), ['off', 'low', 'high']), JSON.stringify(delta?.reasoningEfforts));

  // 30. A gateway that discloses no listing still gets the catalog's answers,
  //     and the route line explains where they came from.
  const noListing = createPanel({
    models: [plainModel('echo')],
    probe: { ok: true, value: { results: [{ model: 'echo', kind: 'levels', levels: ['low', 'medium', 'high'] }] } },
    detect: {
      ok: true,
      value: {
        gateway: { ok: false, detail: 'https://gateway.example/v1/models answered 403' },
        results: [{ model: 'echo', official: { confidence: 'vendor', provider: 'openai', name: 'Echo', contextWindow: 272000, maxTokens: 128000, input: ['text'], levels: ['low', 'medium', 'high'] } }],
      },
    },
  });
  await expand(noListing);
  check('a failed listing is explained once', noListing.capsText().startsWith('metaListingFailed'), noListing.capsText());
  check('and the catalog still fills the row', noListing.metas()[0].startsWith('metaFill'), noListing.metas()[0]);

  process.stdout.write(`\n${checks - failures}/${checks} checks passed\n\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write(`\nharness error: ${error?.stack ?? error}\n\n`);
  process.exit(2);
});
