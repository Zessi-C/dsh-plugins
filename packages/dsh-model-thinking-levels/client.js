/**
 * Thinking levels for a custom model API route.
 *
 * `@deepseek-ai/dsh-llm-pi-ai` decides whether a model offers an Effort row
 * from the model entry's own `reasoningEfforts`. An entry without the field
 * carries no reasoning metadata, so the composer hides the row; `false`
 * declares a non-reasoning model explicitly. The Models settings card edits no
 * reasoning field, so a route declared through the custom-API form has no way
 * to declare one.
 *
 * This Client module fills that gap from outside the shipped page. It
 * registers into the `settings.models.provider-card` seat — a keyed slot that
 * `@deepseek-ai/dsh-client-ui-settings-models` dispatches per settings
 * namespace, hand-declared routes included — and reads/writes the pi-ai
 * section through the `configForms` service `ui-settings` provides for exactly
 * this: reads ride the shared describe mirror (the same raw view the Models
 * page renders), writes ride the shared form whose queue owns the revision and
 * folds each answer back into that mirror.
 *
 * The seat allocates space inside the provider's card, immediately before the
 * provider editor; the editor itself declares no seat, and placement is never
 * inferred from the DOM (the plugin rules forbid it), so the panel is a
 * one-line disclosure that auto-opens while a model still declares nothing.
 * Its styling copies the host's own declarations — `.xuTnra_*` in
 * `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js` — renamed under
 * this plugin's prefix and reduced to theme tokens, so it sits in the card like
 * another field of the page.
 *
 * Models that declare nothing are pre-filled with the levels an
 * OpenAI-compatible gateway accepts, so the usual flow is one click.
 *
 * Scope: only routes the pi-ai adapter reports as `declared` (a route no
 * installed catalog describes). A catalog route's `models` array replaces the
 * installed catalog wholesale, so materializing it from here would silently
 * drop every catalog model; those routes already carry catalog reasoning
 * metadata.
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-thinking-levels',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace, shared with the package name. */
    const NS = 'dsh-model-thinking-levels';
    /** The one settings namespace that describes whole pi-ai routes. */
    const SETTINGS_NS = 'llm-pi-ai';
    /** The RPC channel the Host half answers on; see `index.js`. */
    const PROBE_CHANNEL = '/dsh-model-thinking-levels';
    /** pi-ai's selectable levels, in escalation order. */
    const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    /**
     * What an OpenAI-compatible gateway takes: the OpenAI effort levels plus
     * "no thinking". `off` writes a bare level, which pi-ai sends as no
     * thinking field at all.
     */
    const RECOMMENDED = ['off', 'low', 'medium', 'high'];
    /**
     * How long to wait before retrying a probe the desktop's update lock
     * refused. That lock is short-lived by nature, so one retry covers it.
     */
    const RETRY_MS = 2500;

    /**
     * Copied from the Models page's own CSS module (`.xuTnra_rowCard`,
     * `.xuTnra_customized`, `.xuTnra_customizedSummary`, `.xuTnra_rowTag`,
     * `.xuTnra_secondaryButton`, `.xuTnra_primaryButton`, `.xuTnra_linkButton`,
     * `.xuTnra_advancedHint`, `.xuTnra_error`), with the classes renamed under
     * this plugin's prefix and literal colors replaced by the same theme tokens
     * the host uses. Rendered as a React element, so it leaves with the panel.
     */
    const CSS = `
.dsh-tl{display:flex;flex-direction:column;gap:10px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}
.dsh-tl-summary{display:inline-flex;align-items:center;gap:6px;width:fit-content;margin-left:-4px;padding:2px 4px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;line-height:18px;cursor:pointer}
.dsh-tl-summary:hover{color:var(--dsw-alias-label-primary)}
.dsh-tl-summary:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
.dsh-tl-caret{width:5px;height:5px;flex:none;border-bottom:1.5px solid;border-right:1.5px solid;transform:rotate(-45deg) translate(-1px,-1px);transition:transform .12s}
.dsh-tl-summary[aria-expanded="true"] .dsh-tl-caret{transform:rotate(45deg) translate(-1px,-1px)}
.dsh-tl-value{color:var(--dsw-alias-label-tertiary);font-weight:400}
.dsh-tl-body{display:flex;flex-direction:column;gap:8px}
.dsh-tl-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-tl-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dsh-tl-row{display:flex;flex-direction:column;gap:6px}
.dsh-tl-row-dragging{opacity:.45}
.dsh-tl-row-drop-before{box-shadow:inset 0 2px 0 0 var(--dsw-alias-state-business-primary)}
.dsh-tl-row-drop-after{box-shadow:inset 0 -2px 0 0 var(--dsw-alias-state-business-primary)}
.dsh-tl-rowhead{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsh-tl-grip{display:inline-block;flex:none;width:14px;height:14px;border-radius:var(--dsw-radius-xs);cursor:grab;color:var(--dsw-alias-label-dimmed);user-select:none;background-image:radial-gradient(currentColor 1px,transparent 1.2px);background-size:5px 5px;background-position:1px 1px;background-repeat:repeat}
.dsh-tl-grip:hover{color:var(--dsw-alias-label-secondary)}
.dsh-tl-grip:active{cursor:grabbing}
.dsh-tl-grip:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
.dsh-tl-grip-off{visibility:hidden}
.dsh-tl-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-left:auto}
.dsh-tl-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsh-tl-chips{display:flex;flex-wrap:wrap;gap:4px}
.dsh-tl-chip{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);background:0 0;color:var(--dsw-alias-label-secondary);padding:1px 6px;font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.dsh-tl-chip-undeclared{border-style:dashed;color:var(--dsw-alias-label-dimmed)}
.dsh-tl-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-tl-chip[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}
.dsh-tl-chip:disabled{opacity:.4;cursor:default}
.dsh-tl-chip:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
.dsh-tl-wire{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-tl-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dsh-tl-status{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-tl-primary{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dsh-tl-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-tl-primary:disabled{opacity:.4;cursor:default}
.dsh-tl-primary:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
.dsh-tl-link{box-sizing:border-box;display:inline-flex;align-items:center;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dsh-tl-link:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-tl-link:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
`;

    const zh = {
      title: '思考强度',
      summaryEmpty: '无模型',
      summaryUndeclared: '未声明',
      summaryPreset: '关闭 / 低 / 中 / 高',
      summaryCustom: '按模型设置',
      intro: '为每个模型勾选它支持的档位；未勾选的模型不会出现 Effort 行。',
      orderHint: '拖动每行左侧的手柄可以调整模型顺序（聚焦手柄后按 ↑ / ↓ 也能移动）；顺序和档位一起保存，模型选择器里的顺序也会跟着变。',
      grip: '拖动排序',
      gripOf: '拖动排序：{id}',
      gripKeys: '拖动排序；聚焦后按 ↑ / ↓ 移动',
      preset: '未声明的模型已按通用档位预填，确认后点保存即可。',
      detecting: '正在探测网关支持的档位…',
      detected: '网关接受',
      detectNone: '网关不接受任何思考档位，建议声明为「非推理模型」',
      detectUnchecked: '网关不校验档位名，所以每个档位都照常显示',
      detectCaveat: '这是网关会接受并转发的档位；自定义 provider 若没在网关里显式声明，网关可能报的是它自己的默认档位。',
      undeclaredChip: '网关未声明此档位：多半会被归并到相邻档位，勾了也不会真正生效',
      detectFailed: '探测失败：{detail}',
      detectBusy: 'DSH 桌面端正在做应用更新，这段时间它会拒绝所有请求（HTTP 503）。稍后会自动重试，也可以点「重新探测」。',
      detectNoChannel: '宿主侧的探测通道没有注册（{detail}）。这通常意味着 Host 半没加载或没生效，重启 DSH 后再试。',
      detectModelFailed: '探测失败：{detail}',
      detectPartial: '有 {count} 个模型没探到（{detail}）；档位照常可以勾选，稍后可点「重新探测」。',
      redetect: '重新探测',
      hint: '“关闭”= 不发送思考字段（pi-ai 的 off 档），交给网关自行决定；它不等同于不思考。',
      loading: '载入中…',
      unavailable: '当前部署没有提供可写的模型配置。',
      empty: '这个提供商还没有模型，请先在下方添加。',
      reload: '重新载入',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      unsaved: '有未保存的改动',
      failed: '保存被拒绝，配置可能已被其他页面修改，请核对后重试。',
      unnamed: '（未命名模型，请先在下方补上 id）',
      wire: '将写入',
      wireNone: 'false（非推理模型）',
      'level.off': '关闭',
      'level.minimal': '最小',
      'level.low': '低',
      'level.medium': '中',
      'level.high': '高',
      'level.xhigh': '极高',
      'level.max': '最大',
    };

    const en = {
      title: 'Thinking levels',
      summaryEmpty: 'No models',
      summaryUndeclared: 'Not declared',
      summaryPreset: 'Off / Low / Medium / High',
      summaryCustom: 'Per model',
      intro: 'Tick the levels each model accepts; a model with none gets no Effort row.',
      orderHint: 'Drag the handle on the left of a row to reorder models (or focus it and press ↑ / ↓); the order saves with the levels, and the model picker follows it.',
      grip: 'Reorder',
      gripOf: 'Reorder {id}',
      gripKeys: 'Drag to reorder; focus it and press ↑ / ↓ to move',
      preset: 'Models that declare nothing are pre-filled with the common levels. Just save.',
      detecting: 'Asking the gateway which levels it accepts…',
      detected: 'Gateway accepts',
      detectNone: 'The gateway accepts no thinking level here; consider marking it non-reasoning',
      detectUnchecked: 'The gateway does not validate level names, so every level stays available',
      detectCaveat: 'These are the levels the gateway accepts and forwards; a custom provider that declares nothing in the gateway may be reporting the gateway\'s own default.',
      undeclaredChip: 'The gateway does not declare this level: it is likely folded into a neighbouring one, so ticking it changes nothing',
      detectFailed: 'Detection failed: {detail}',
      detectBusy: 'The desktop app is running an update task, and it refuses every request with HTTP 503 until that finishes. This retries on its own; you can also press "Detect again".',
      detectNoChannel: 'The probe channel is not registered on the Host ({detail}). That usually means the Host half did not load — restart DSH and try again.',
      detectModelFailed: 'Detection failed: {detail}',
      detectPartial: '{count} model(s) could not be probed ({detail}); the levels stay available, and "Detect again" retries.',
      redetect: 'Detect again',
      hint: '"Off" sends no thinking field at all (pi-ai\'s off level) and leaves the choice to the gateway; it is not a guarantee of no thinking.',
      loading: 'Loading…',
      unavailable: 'This deployment offers no writable model configuration.',
      empty: 'This provider has no models yet; add one below.',
      reload: 'Reload',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      unsaved: 'Unsaved changes',
      failed: 'The write was refused; the configuration may have changed elsewhere. Check and retry.',
      unnamed: '(Unnamed model — add its id below first)',
      wire: 'Writes',
      wireNone: 'false (non-reasoning)',
      'level.off': 'Off',
      'level.minimal': 'Minimal',
      'level.low': 'Low',
      'level.medium': 'Medium',
      'level.high': 'High',
      'level.xhigh': 'X-high',
      'level.max': 'Max',
    };

    /** Read one path out of a settings value. */
    function atPath(root, path) {
      let node = root;
      for (const segment of path) {
        if (node === null || typeof node !== 'object') return undefined;
        node = node[segment];
      }
      return node;
    }

    /** The id one model entry carries, or an empty string when it has none. */
    function idOf(model) {
      return typeof model?.id === 'string' ? model.id : '';
    }

    /**
     * Whether a probe failure is the desktop's own update lock rather than a
     * real error.
     *
     * `dsh-desktop-host` installs an admission lock while an update task runs:
     * it answers every API request with a bare `503` and releases the lock when
     * the task ends, so the RPC transport reports `… HTTP 503` for a request
     * that was never wrong. That is a "try again in a moment", and it is worth
     * telling apart from a gateway that really refused the probe.
     * @param detail - the transport failure's message.
     * @returns whether the failure looks like that lock.
     */
    function isTransportBusy(detail) {
      return /HTTP\s+503\b/i.test(String(detail));
    }

    /**
     * Whether a probe failure says the channel itself is missing from the Host.
     *
     * A channel that was never registered leaves the browser's POST to the
     * static handler, which answers `405` to a POST and `404` to a GET — the
     * one failure whose fix is a restart rather than a retry, so it is worth
     * naming instead of showing the transport's own wording.
     * @param detail - the transport failure's message.
     * @returns whether the failure looks like an unregistered channel.
     */
    function isTransportNoChannel(detail) {
      return /HTTP\s+(?:404|405)\b/i.test(String(detail));
    }

    /** The document's named model ids, in the order the document lists them. */
    function documentOrder(models) {
      return models.map(idOf).filter((id) => id.length > 0);
    }

    /**
     * The document's rows in the order `order` asks for.
     *
     * An order holds *document indices*, not ids: two entries may share an id
     * (a configuration the adapter refuses, but one the panel can still be
     * looking at) and an entry may have no id at all, and neither is a thing a
     * list can address by name. Indices address every row exactly once, so a
     * drag can neither relocate an entry the user did not touch nor drop one
     * from the write. An index the order does not mention — a row the provider
     * editor added since the drag — keeps its document place at the end.
     *
     * @param models - the document's model entries.
     * @param order - document indices, or null to follow the document.
     * @returns the rows to render and to write, each with its document index.
     */
    function orderedRows(models, order) {
      if (order === null) return models.map((model, index) => ({ model, index }));
      const rows = [];
      const placed = new Set();
      for (const index of order) {
        if (!Number.isInteger(index) || index < 0 || index >= models.length || placed.has(index)) continue;
        placed.add(index);
        rows.push({ model: models[index], index });
      }
      for (let index = 0; index < models.length; index += 1) {
        if (!placed.has(index)) rows.push({ model: models[index], index });
      }
      return rows;
    }

    /**
     * `order` with the row at `from` moved into `over`'s slot, before it or
     * after it. Both positions are display positions; the entry that moves is
     * the document index the order holds there.
     * @returns a new array, or `order` itself when nothing moves.
     */
    function moveModel(order, from, over, after) {
      if (from < 0 || over < 0 || from === over) return order;
      let to = over + (after ? 1 : 0);
      if (from < to) to -= 1;
      if (to === from) return order;
      const next = order.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    }

    /**
     * The arrangement the drag handlers work from: always a full permutation of
     * the current document's rows.
     *
     * A display position and an order slot have to be the same number for the
     * move arithmetic to mean anything, and that only holds while the order
     * covers every row. A pending order can be one render behind a document
     * that just changed, so it is repaired here rather than trusted: an index
     * out of range or named twice is dropped, and every row the order forgot is
     * appended in document order.
     *
     * @param order - the pending order, or null to follow the document.
     * @param length - how many rows the document has now.
     * @returns document indices, one per row.
     */
    function normalizeOrder(order, length) {
      if (order === null) return Array.from({ length }, (_unused, index) => index);
      const base = [];
      const placed = new Set();
      for (const index of order) {
        if (!Number.isInteger(index) || index < 0 || index >= length || placed.has(index)) continue;
        placed.add(index);
        base.push(index);
      }
      for (let index = 0; index < length; index += 1) {
        if (!placed.has(index)) base.push(index);
      }
      return base;
    }

    /** Whether two landing marks name the same slot. */
    function sameMark(left, right) {
      if (left === right) return true;
      if (left === null || right === null) return false;
      return left.at === right.at && left.after === right.after;
    }

    /** The levels one model entry declares, in escalation order. */
    function levelsOf(model) {
      const declared = model === null || typeof model !== 'object' ? undefined : model.reasoningEfforts;
      if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) return [];
      return LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(declared, level));
    }

    /** The declared object these levels write, or undefined when none is ticked. */
    function declaredOf(levels) {
      if (levels.length === 0) return undefined;
      const declared = {};
      for (const level of LEVELS) {
        if (!levels.includes(level)) continue;
        // A bare `off` is pi-ai's "supported, send nothing"; every other level
        // carries its wire spelling, which for these gateways is the level id.
        declared[level] = level === 'off' ? null : level;
      }
      return declared;
    }

    /** The `reasoningEfforts` value these levels produce; `false` means "non-reasoning". */
    function valueOf(levels) {
      return declaredOf(levels) ?? false;
    }

    /** One model entry carrying exactly `levels`. */
    function withLevels(model, levels) {
      return { ...model, reasoningEfforts: valueOf(levels) };
    }

    /**
     * The editable draft of every named model, keyed by model id. A model that
     * declares nothing starts at the recommended levels so the common case is
     * a single save; a model that already decides for itself keeps its levels.
     */
    function draftsOf(models) {
      const draft = {};
      for (const model of models) {
        const id = idOf(model);
        if (id.length === 0) continue;
        draft[id] = model.reasoningEfforts === undefined ? [...RECOMMENDED] : levelsOf(model);
      }
      return draft;
    }

    /** Level tables already asked of one gateway, keyed by route and model set. */
    const detectionCache = new Map();

    /** Whether two level lists hold the same levels. */
    function sameLevels(left, right) {
      return left.length === right.length && left.every((level, index) => level === right[index]);
    }

    /** Whether two `reasoningEfforts` values decide the same thing. */
    function sameDeclared(left, right) {
      if (left === right) return true;
      if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
      const keys = Object.keys(left).sort();
      const other = Object.keys(right).sort();
      return keys.length === other.length && keys.every((key, index) => key === other[index] && left[key] === right[key]);
    }

    /**
     * The pi-ai section's shared form. `ui-settings` owns it and the Models
     * page edits through it, so a read is a snapshot and a write lands in the
     * same queue and mirror the page itself uses.
     */
    function createApi(ctx) {
      const t = ctx.locale.bind(NS);
      // Reads ride the shared describe mirror — the same raw view the Models
      // page renders, so no schema re-decode of our own can strand the panel.
      // Writes ride the shared form, whose queue owns the revision and folds
      // each answer back into that mirror.
      const mirror = ctx.configForms.describe();
      const form = ctx.configForms.get(SETTINGS_NS);
      return {
        t,
        snapshot: () => mirror.getSnapshot(),
        subscribe: (listener) => mirror.subscribe(listener),
        write: (ops) => form.mutate(ops),
        /** Ask the shared mirror for a fresh read; it answers with its own snapshot. */
        reload: () => {
          if (typeof mirror?.load !== 'function') return undefined;
          return Promise.resolve(mirror.load()).catch(() => undefined);
        },
        /**
         * Ask the Host half which levels this route's gateway accepts.
         *
         * Resolved at call time rather than at apply time, so the panel still
         * renders on a page whose connection service arrives late. Always
         * resolves to an RPC result — `{ ok: true, value }` or
         * `{ ok: false, error }` — and never throws.
         */
        probe: (payload) => {
          const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
          if (connection === undefined || typeof connection.rpc?.call !== 'function') {
            return Promise.resolve({ ok: false, error: { code: 'no-connection', message: 'this page has no connection to the Host' } });
          }
          return Promise.resolve(connection.rpc.call(PROBE_CHANNEL, 'probe', payload)).catch((error) => ({
            ok: false,
            error: { code: 'transport', message: String(error?.message ?? error) },
          }));
        },
      };
    }

    /**
     * The provider card's thinking-level panel.
     *
     * The guard is its own component so the panel's hooks never depend on
     * whether this route is hand-declared.
     */
    function ThinkingLevels(props) {
      if (props.provider.declared !== true) return null;
      return h(ThinkingLevelsPanel, props);
    }

    /** The panel itself, for a route the pi-ai catalog does not describe. */
    function ThinkingLevelsPanel(props) {
      const { provider, api } = props;
      const t = api.t;
      const settingsPath = provider.settingsPath;
      const pathKey = settingsPath.join('/');
      const [state, setState] = React.useState(api.snapshot);
      const [draft, setDraft] = React.useState(null);
      const [write, setWrite] = React.useState({ status: 'idle' });
      // What the gateway said about this route, and a nonce that forces a fresh
      // ask when the user does not believe the cached answer.
      const [detect, setDetect] = React.useState({ status: 'idle' });
      const [nonce, setNonce] = React.useState(0);
      // null follows the document: open while a model still declares nothing,
      // closed once every model has decided.
      const [manual, setManual] = React.useState(null);
      // The document indices in the order the user dragged the rows into, or
      // null while the panel still follows the document. Reset whenever the
      // document's model set moves.
      const [order, setOrder] = React.useState(null);
      // The document index being dragged, for the drag styling, and the slot it
      // would land in. The ref is what the drag handlers read, so they never
      // work from a stale closure.
      const [dragId, setDragId] = React.useState(null);
      const [dropAt, setDropAt] = React.useState(null);
      const dragRef = React.useRef(null);
      // Whether the desktop's update lock has already been retried for this
      // trigger, so a lock that stays on cannot become a retry loop.
      const busyRetried = React.useRef(false);

      React.useEffect(() => {
        setState(api.snapshot());
        return api.subscribe(() => setState(api.snapshot()));
      }, [api]);

      const view = state.view;
      const row = view?.namespaces.find((entry) => entry.ns === SETTINGS_NS);
      const ready = row !== undefined;
      const writable = ready && view.writable === true;
      // The mirror never answered (a slow read, or a page that keeps settings in
      // memory) versus an answered document that does not serve this namespace.
      const pending = !ready && state.status !== 'ready' && state.status !== 'unavailable';
      const unavailable = !ready && !pending;
      const profile = atPath(row?.value, settingsPath);
      const models = Array.isArray(profile?.models) ? profile.models : [];
      const revision = row?.revision;
      const modelIds = documentOrder(models);
      const modelKey = modelIds.join(',');
      // The arrangement the handlers work from — repaired against the document
      // as it is now, so a display position is always an order slot — and the
      // rows it renders, which is the same list the save writes.
      const baseOrder = normalizeOrder(order, models.length);
      const ordered = orderedRows(models, baseOrder);

      // Re-derive the drafts whenever the document moves under us — an outside
      // edit, our own accepted write, or a manual reload — and drop the dragged
      // order and any drag in flight with them: a drag belongs to the document
      // it started on, so it must not be applied to a list that has moved. The
      // write status is deliberately left alone so an accepted write keeps
      // saying so.
      React.useEffect(() => {
        if (!ready) return;
        setDraft(draftsOf(models));
        setOrder(null);
        dragRef.current = null;
        setDragId(null);
        setDropAt(null);
      }, [ready, revision, pathKey, modelKey]);

      const undeclared = models.some((model) => model?.reasoningEfforts === undefined);
      // null follows the document: open while a model still declares nothing or
      // the read has not answered, closed once every model has decided.
      const expanded = manual ?? (undeclared || pending || unavailable);

      const detectKey = `${SETTINGS_NS}|${pathKey}|${modelKey}`;

      // Ask the gateway once per route and model set. It is the only authority
      // on which levels a model really has: the profile declares them, the
      // catalog has no entry for a hand-declared route, and discovery carries
      // no capability metadata. The answer is cached for the session, because
      // each ask costs one request per model.
      React.useEffect(() => {
        if (!expanded || !ready || modelIds.length === 0) return undefined;
        const cached = detectionCache.get(detectKey);
        if (cached !== undefined) {
          setDetect({ status: 'ready', byModel: cached.byModel, failures: cached.failures });
          return undefined;
        }
        let live = true;
        let retry;
        setDetect({ status: 'probing' });
        api.probe({ settingsNs: SETTINGS_NS, settingsPath, models: modelIds }).then((answer) => {
          if (!live) return;
          if (answer?.ok !== true) {
            const detail = answer?.error?.message ?? 'unknown';
            // A desktop update task locks the whole API surface and answers a
            // bare 503 until it finishes, so this is a "come back in a moment",
            // not a failure the user should have to read a transport error for.
            // One automatic retry covers the ordinary case; a second visit to
            // this effect is what the retry is, so it can only happen once.
            const busy = isTransportBusy(detail);
            setDetect({ status: 'error', detail, busy, missing: isTransportNoChannel(detail) });
            if (busy && !busyRetried.current) {
              busyRetried.current = true;
              retry = setTimeout(() => setNonce((value) => value + 1), RETRY_MS);
            }
            return;
          }
          busyRetried.current = false;
          const byModel = {};
          const failures = [];
          for (const row of answer.value?.results ?? []) {
            // `off` is added to every table: pi-ai implements it by sending no
            // thinking field at all, so it never depends on the gateway. A
            // model with no thinking support gets an empty table instead —
            // declaring only `off` is not a valid pi-ai configuration, so the
            // panel offers nothing and clearing it writes `false`.
            if (row?.kind === 'levels') {
              byModel[row.model] = ['off', ...row.levels.filter((level) => LEVELS.includes(level) && level !== 'off')];
            } else if (row?.kind === 'none') {
              byModel[row.model] = [];
            } else if (row?.kind === 'refused' || row?.kind === 'unreachable') {
              // Anything else the gateway said is still an answer about this
              // model. Dropping it would let a 502 read as "the gateway does
              // not validate level names", which is the opposite of the truth.
              failures.push({
                model: row.model,
                text: row.kind === 'unreachable' ? String(row.detail) : `HTTP ${row.status}`,
              });
            }
          }
          // Only a clean answer is worth caching: a model that failed may well
          // answer on the next visit, and a cached failure would hide it.
          if (failures.length === 0) detectionCache.set(detectKey, { byModel, failures });
          setDetect({ status: 'ready', byModel, failures });
        });
        return () => {
          live = false;
          clearTimeout(retry);
        };
      }, [expanded, ready, detectKey, nonce]);

      // Let the gateway's table refine the generic preset. Only a model that
      // declares nothing and still sits exactly on that preset is rewritten, so
      // a level the user picked by hand — or a level the document already
      // decided — survives detection.
      React.useEffect(() => {
        if (detect.status !== 'ready') return;
        setDraft((current) => {
          if (current === null) return current;
          let changed = false;
          const next = { ...current };
          for (const model of models) {
            const id = idOf(model);
            if (id.length === 0 || model.reasoningEfforts !== undefined) continue;
            const table = detect.byModel?.[id];
            if (table === undefined || sameLevels(next[id] ?? [], table)) continue;
            if (!sameLevels(next[id] ?? [], RECOMMENDED)) continue;
            next[id] = [...table];
            changed = true;
          }
          return changed ? next : current;
        });
      }, [detect]);

      const levelsDirty =
        draft !== null &&
        models.some((model) => {
          const id = idOf(model);
          if (id.length === 0 || draft[id] === undefined) return false;
          return !sameDeclared(valueOf(draft[id]), model.reasoningEfforts);
        });
      // Compare the arrangement that would be written, not the dragged list:
      // an order that happens to be the document's own sequence — including one
      // dragged back by hand — is not a change to save.
      const orderDirty = ordered.some((row, at) => row.index !== at);
      const dirty = levelsDirty || orderDirty;

      const toggle = (id, level) => {
        setWrite({ status: 'idle' });
        setDraft((current) => {
          const held = current?.[id] ?? [];
          const chosen = held.includes(level) ? held.filter((entry) => entry !== level) : [...held, level];
          return { ...current, [id]: LEVELS.filter((entry) => chosen.includes(entry)) };
        });
      };

      /**
       * The document index of the row being dragged, or null when there is no
       * drag to honour.
       *
       * A drag is pinned to the document it started on, by the `models` array
       * it saw. Indices only name the same row within one document, so a list
       * that changed under the pointer — an outside write, or this panel's own
       * save folding in — must abandon the drag rather than move whichever
       * model inherited the index.
       */
      const dragHeld = () => {
        const held = dragRef.current;
        if (held === null || held.models !== models) return null;
        return held.index;
      };

      const startDrag = (index) => (event) => {
        dragRef.current = { index, models };
        setDragId(index);
        const transfer = event.dataTransfer;
        if (transfer === null || transfer === undefined) return;
        transfer.effectAllowed = 'move';
        // Some browsers refuse to start a drag that carries no payload at all;
        // the model id is also the most useful thing to hand anything that
        // accepts the drop.
        transfer.setData('text/plain', idOf(models[index]) || String(index));
        // The grip alone is a 14px drag image; showing the whole row instead
        // is what makes the drag read as moving a row rather than a handle.
        const row = event.currentTarget.closest?.('.dsh-tl-row');
        if (row !== null && row !== undefined && typeof transfer.setDragImage === 'function') {
          transfer.setDragImage(row, 12, 12);
        }
      };

      const endDrag = () => {
        dragRef.current = null;
        setDragId(null);
        setDropAt(null);
      };

      /** Apply the move a landing slot asks for; false when there is no drag. */
      const commitDrop = (at, after) => {
        const held = dragHeld();
        if (held === null) return false;
        const from = baseOrder.indexOf(held);
        if (from >= 0 && from !== at) {
          setWrite({ status: 'idle' });
          setOrder(moveModel(baseOrder, from, at, after));
        }
        return true;
      };

      /**
       * Mark where the dragged row would land. The rows themselves do not move
       * until the drop: reordering the DOM under a live drag is what makes a
       * browser cancel the gesture, and the workspace sidebar's own row drag
       * marks the landing slot the same way.
       */
      const dragOver = (at) => (event) => {
        const held = dragHeld();
        if (held === null) return;
        event.preventDefault();
        if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move';
        const from = baseOrder.indexOf(held);
        if (from < 0 || from === at) {
          setDropAt(null);
          return;
        }
        const box = event.currentTarget.getBoundingClientRect();
        const after = event.clientY > box.top + box.height / 2;
        // No mark where the row already is: dropping there would do nothing.
        const next = moveModel(baseOrder, from, at, after) === baseOrder ? null : { at, after };
        setDropAt((current) => (sameMark(current, next) ? current : next));
      };

      /** Commit the move once, on drop. */
      const drop = (at) => (event) => {
        if (dragHeld() === null) return;
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        commitDrop(at, event.clientY > box.top + box.height / 2);
        endDrag();
      };

      /** The panel's own drag-over, for the gaps a row does not cover. */
      const bodyOver = (event) => {
        if (dragHeld() === null) return;
        event.preventDefault();
        if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move';
      };

      const bodyDrop = (event) => {
        if (dragHeld() === null) return;
        event.preventDefault();
        if (dropAt !== null) commitDrop(dropAt.at, dropAt.after);
        endDrag();
      };

      /** One step for the keyboard, so the order is reachable without a pointer. */
      const nudge = (index) => (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        const from = baseOrder.indexOf(index);
        const to = from + (event.key === 'ArrowUp' ? -1 : 1);
        if (from < 0 || to < 0 || to >= baseOrder.length) return;
        const next = baseOrder.slice();
        next.splice(from, 1);
        next.splice(to, 0, index);
        setWrite({ status: 'idle' });
        setOrder(next);
      };

      const save = async () => {
        // Keep the disclosure open through the write: the status and the levels
        // stay in reach for a follow-up adjustment.
        setManual(true);
        setWrite({ status: 'saving' });
        const next = ordered.map(({ model }) => {
          const id = idOf(model);
          return id.length > 0 && draft?.[id] !== undefined ? withLevels(model, draft[id]) : model;
        });
        const accepted = await api.write([{ op: 'set', path: [...settingsPath, 'models'], value: next }]);
        setWrite(accepted ? { status: 'saved' } : { status: 'error' });
      };

      const summary =
        models.length === 0
          ? t('summaryEmpty')
          : undeclared
            ? t('summaryUndeclared')
            : models.every((model) => sameLevels(levelsOf(model), RECOMMENDED))
              ? t('summaryPreset')
              : t('summaryCustom');

      // Every level stays on offer — the palette must not move under the user's
      // hands, and a level the gateway does not list is still a thing the user
      // may want to see removed. What the gateway said is reported per model
      // instead, and an undeclared chip is drawn as one.
      const isDeclared = (id, level) => {
        const table = detect.byModel?.[id];
        return table === undefined || table.includes(level);
      };

      /**
       * What the gateway said about one model, or an empty string when it said
       * nothing about it. Detection is per model because the gateway's table is
       * per model: two models on one route can declare different sets.
       */
      const noteFor = (id) => {
        if (detect.status !== 'ready') return '';
        const failure = detect.failures?.find((entry) => entry.model === id);
        if (failure !== undefined) return t('detectModelFailed', { detail: failure.text });
        const table = detect.byModel?.[id];
        if (table === undefined) return '';
        const named = table.filter((level) => level !== 'off');
        if (named.length === 0) return t('detectNone');
        return `${t('detected')}：${named.map((level) => t(`level.${level}`)).join(' / ')}`;
      };

      /**
       * The route-level line: the states that belong to the whole probe, plus
       * the caveat that a custom provider's table can be the gateway's default
       * rather than a fact about the model. Never a table — that is per model.
       */
      const detectText = (() => {
        if (detect.status === 'probing') return t('detecting');
        if (detect.status === 'error') {
          if (detect.busy) return t('detectBusy');
          if (detect.missing) return t('detectNoChannel', { detail: detect.detail });
          return t('detectFailed', { detail: detect.detail });
        }
        if (detect.status !== 'ready') return '';
        const failures = detect.failures ?? [];
        // A model the gateway refused is not a model whose levels are free for
        // the taking, so the "the gateway does not validate names" reading is
        // only right when every model actually answered that way.
        if (failures.length > 0) return t('detectPartial', { count: String(failures.length), detail: failures[0].text });
        const tables = modelIds.map((id) => detect.byModel?.[id]).filter((table) => Array.isArray(table));
        return tables.length === 0 ? t('detectUnchecked') : t('detectCaveat');
      })();

      const statusText =
        write.status === 'saving'
          ? t('saving')
          : dirty
            ? t('unsaved')
            : write.status === 'saved'
              ? t('saved')
              : '';

      return h(
        'div',
        { className: 'dsh-tl' },
        h('style', { key: 'css' }, CSS),
        h(
          'button',
          {
            key: 'summary',
            type: 'button',
            className: 'dsh-tl-summary',
            'aria-expanded': expanded,
            onClick: () => setManual(!expanded),
          },
          h('span', { className: 'dsh-tl-caret', 'aria-hidden': true }),
          h('span', null, t('title')),
          h('span', { className: 'dsh-tl-value' }, summary),
        ),
        expanded
          ? h(
              'div',
              {
                className: 'dsh-tl-body',
                key: 'body',
                // The panel accepts the drop too, so releasing in the gap
                // between two rows lands on the slot marked last instead of
                // discarding the drag. A row's own drop ends the drag before
                // this runs, which is what keeps the two from committing twice.
                onDragOver: writable ? bodyOver : undefined,
                onDrop: writable ? bodyDrop : undefined,
              },
              h('p', { className: 'dsh-tl-hint' }, t('intro')),
              ready && ordered.length > 1 ? h('p', { className: 'dsh-tl-hint' }, t('orderHint')) : null,
              pending ? h('p', { className: 'dsh-tl-hint' }, t('loading')) : null,
              unavailable ? h('p', { className: 'dsh-tl-hint' }, t('unavailable')) : null,
              ready && models.length === 0 ? h('p', { className: 'dsh-tl-hint' }, t('empty')) : null,
              undeclared ? h('p', { className: 'dsh-tl-hint' }, t('preset')) : null,
              detectText.length === 0
                ? null
                : h('p', { className: detect.status === 'error' ? 'dsh-tl-error' : 'dsh-tl-hint' }, detectText),
              ready
                ? ordered.map(({ model, index }, at) => {
                    const id = idOf(model);
                    const named = id.length > 0;
                    const held = named ? draft?.[id] ?? levelsOf(model) : [];
                    const declared = valueOf(held);
                    const note = named ? noteFor(id) : '';
                    // Every row is addressable — by its document index, not by
                    // its id — so an entry without an id can move too; only a
                    // read-only document has nowhere to put an order. The key
                    // is that same index, which stays stable as rows move.
                    const movable = writable;
                    const classes = ['dsh-tl-row'];
                    if (dragId === index) classes.push('dsh-tl-row-dragging');
                    if (dropAt !== null && dropAt.at === at) classes.push(dropAt.after ? 'dsh-tl-row-drop-after' : 'dsh-tl-row-drop-before');
                    return h(
                      'div',
                      {
                        className: classes.join(' '),
                        key: index,
                        onDragOver: movable ? dragOver(at) : undefined,
                        onDrop: movable ? drop(at) : undefined,
                      },
                      h(
                        'div',
                        { className: 'dsh-tl-rowhead' },
                        h('span', {
                          className: movable ? 'dsh-tl-grip' : 'dsh-tl-grip dsh-tl-grip-off',
                          role: 'button',
                          tabIndex: movable ? 0 : -1,
                          draggable: movable,
                          'aria-label': named ? t('gripOf', { id }) : t('grip'),
                          title: movable ? t('gripKeys') : undefined,
                          onDragStart: movable ? startDrag(index) : undefined,
                          onDragEnd: movable ? endDrag : undefined,
                          onKeyDown: movable ? nudge(index) : undefined,
                        }),
                        h('code', { className: 'dsh-tl-id' }, named ? id : t('unnamed')),
                        note.length === 0 ? null : h('span', { className: 'dsh-tl-note' }, note),
                      ),
                      h(
                        'span',
                        { className: 'dsh-tl-chips', role: 'group', 'aria-label': named ? id : t('unnamed') },
                        LEVELS.map((level) => {
                          const offered = isDeclared(id, level);
                          return h(
                            'button',
                            {
                              key: level,
                              type: 'button',
                              className: offered ? 'dsh-tl-chip' : 'dsh-tl-chip dsh-tl-chip-undeclared',
                              title: offered ? undefined : t('undeclaredChip'),
                              disabled: !writable || !named,
                              'aria-pressed': held.includes(level),
                              onClick: () => toggle(id, level),
                            },
                            t(`level.${level}`),
                          );
                        }),
                      ),
                      // Quiet while the model keeps the recommended levels; the
                      // exact wire value matters once it departs from them.
                      sameLevels(held, RECOMMENDED)
                        ? null
                        : h(
                            'p',
                            { className: 'dsh-tl-wire' },
                            `${t('wire')}: ${declared === false ? t('wireNone') : JSON.stringify(declared)}`,
                          ),
                    );
                  })
                : null,
              write.status === 'error' ? h('p', { className: 'dsh-tl-error' }, t('failed')) : null,
              h(
                'div',
                { className: 'dsh-tl-actions' },
                h('span', { className: 'dsh-tl-status' }, statusText),
                ready
                  ? h(
                      'button',
                      { type: 'button', className: 'dsh-tl-primary', disabled: !writable || !dirty, onClick: save },
                      t('save'),
                    )
                  : null,
                pending ? h('button', { type: 'button', className: 'dsh-tl-link', onClick: () => api.reload() }, t('reload')) : null,
                ready && (detect.status === 'ready' || detect.status === 'error')
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-tl-link',
                        onClick: () => {
                          detectionCache.delete(detectKey);
                          busyRetried.current = false;
                          setNonce((value) => value + 1);
                        },
                      },
                      t('redetect'),
                    )
                  : null,
              ),
              h('p', { className: 'dsh-tl-hint' }, t('hint')),
            )
          : null,
      );
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model-thinking-levels: copy dictionaries');
        const api = createApi(ctx);
        ctx.slots.inject('settings.models.provider-card', () =>
          ctx.slots.register(
            {
              name: 'settings.models.provider-card',
              id: 'model-thinking-levels',
              key: SETTINGS_NS,
              order: 60,
              inject: () => ({ api }),
            },
            ThinkingLevels,
          ),
        );
      },
    };
  },
});
