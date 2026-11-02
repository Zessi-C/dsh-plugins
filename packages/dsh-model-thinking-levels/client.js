/**
 * Thinking levels and detected capabilities for a custom model API route.
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
 * OpenAI-compatible gateway accepts, and — where the Host can find them — with
 * the capability fields the stock card cannot detect: context window, output
 * cap, input modalities, and display name. A field the entry omits is filled in
 * and saved with it; a field the entry already states is never overwritten, but
 * a detected value that disagrees is shown next to it with an explicit "use the
 * detected value" action.
 *
 * Scope: only routes the pi-ai adapter reports as `declared` (a route no
 * installed catalog describes). A catalog route's `models` array replaces the
 * installed catalog wholesale, so materializing it from here would silently
 * drop every catalog model; those routes already carry catalog reasoning
 * metadata and catalog capacities.
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
     * The model-entry fields the capability detector may propose, in the order
     * the panel reports them. They are exactly the fields the stock card shows
     * for a hand-declared model: context window, output cap, input modalities,
     * and the display name.
     */
    const CAPABILITY_FIELDS = ['contextWindow', 'maxTokens', 'input', 'name'];
    /** The input modalities pi-ai understands, in the order they are rendered. */
    const MODALITIES = ['text', 'image'];

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
.dsh-tl-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsh-tl-meta-conflict{color:var(--dsw-alias-state-warn-primary)}
.dsh-tl-adopt{box-sizing:border-box;display:inline-flex;align-items:center;height:20px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.dsh-tl-adopt:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-tl-adopt:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
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
      preset: '未声明的模型已按探测结果预填（档位与能力字段），确认后点保存即可。',
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
      metaDetecting: '正在探测模型能力（网关清单 / 官方目录）…',
      metaFailed: '能力探测失败：{detail}',
      metaListingFailed: '网关清单读取失败（{detail}）；下面的能力信息来自官方目录。',
      metaFill: '将补入：{fields}',
      metaConflict: '与探测值不一致：{pairs}',
      metaAdopt: '采用探测值',
      metaAdopted: '已采用探测值，保存后生效',
      metaAmbiguous: '官方目录给出多个取值（{values}），未自动填入',
      metaSource: '来源：{source}',
      'source.gateway': '网关清单',
      'source.official': '官方目录（{provider}）',
      'field.contextWindow': '上下文',
      'field.maxTokens': '输出上限',
      'field.input': '模态',
      'field.name': '名称',
      'modality.text': '文本',
      'modality.image': '图片',
      'meta.pair': '、',
      'meta.colon': '：',
      'meta.line': '；',
      metaNoCatalog: '官方目录读不到（这个部署里找不到 pi-ai 安装），能力信息只能来自网关清单。',
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
      preset: 'Models that declare nothing are pre-filled from detection — levels and capability fields. Just save.',
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
      metaDetecting: 'Detecting model capabilities (gateway listing / official catalog)…',
      metaFailed: 'Capability detection failed: {detail}',
      metaListingFailed: 'The gateway listing could not be read ({detail}); the capability data below comes from the official catalog.',
      metaFill: 'Will add: {fields}',
      metaConflict: 'Differs from the detected value: {pairs}',
      metaAdopt: 'Use detected',
      metaAdopted: 'Detected value adopted; save to apply',
      metaAmbiguous: 'The official catalog gives several values ({values}), so nothing was filled in',
      metaSource: 'Source: {source}',
      'source.gateway': 'gateway listing',
      'source.official': 'official catalog ({provider})',
      'field.contextWindow': 'context',
      'field.maxTokens': 'output cap',
      'field.input': 'modalities',
      'field.name': 'name',
      'modality.text': 'text',
      'modality.image': 'image',
      'meta.pair': ', ',
      'meta.colon': ': ',
      'meta.line': '; ',
      metaNoCatalog: 'The installed pi-ai catalog could not be read on this deployment, so capabilities come from the gateway listing alone.',
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

    /** The modalities one declared value holds, in render order, or undefined when it states none. */
    function modalitiesOf(value) {
      if (!Array.isArray(value)) return undefined;
      const found = new Set(value.filter((item) => MODALITIES.includes(item)));
      const ordered = MODALITIES.filter((modality) => found.has(modality));
      return ordered.length === 0 ? undefined : ordered;
    }

    /** Whether two modality lists say the same thing. */
    function sameModalities(left, right) {
      const leftList = left ?? [];
      const rightList = right ?? [];
      return leftList.length === rightList.length && leftList.every((entry, index) => entry === rightList[index]);
    }

    /** Whether two values of one capability field say the same thing. */
    function sameCapability(field, left, right) {
      if (left === right) return true;
      if (field === 'input') return sameModalities(left, right);
      return false;
    }

    /** The value one model entry states for one capability field, or undefined when it states none. */
    function capabilityOf(model, field) {
      if (model === null || typeof model !== 'object') return undefined;
      if (field === 'contextWindow' || field === 'maxTokens') {
        const value = model[field];
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
      }
      if (field === 'input') return Array.isArray(model.input) ? modalitiesOf(model.input) : undefined;
      if (field === 'name') return typeof model.name === 'string' && model.name.length > 0 ? model.name : undefined;
      return undefined;
    }

    /**
     * The capability values detection found for one model, best source first.
     *
     * The gateway's own listing describes the endpoint being configured, so its
     * word wins over the installed catalog's; the catalog is what answers for a
     * gateway that discloses only ids. An ambiguous catalog reading is not a
     * value at all — the panel reports the competing readings instead of
     * choosing one. The display name is the exception: a listing's name is
     * usually just the id it serves, so the catalog's product name wins.
     * @param row - one `detect` result row.
     * @returns field values, and the source that supplied each.
     */
    function detectedOf(row) {
      const values = {};
      const sources = {};
      const put = (field, value, source, provider) => {
        if (value === undefined || value === null) return;
        if (values[field] !== undefined) return;
        values[field] = value;
        sources[field] = source === 'official' && typeof provider === 'string' ? { source, provider } : { source };
      };
      const official = row?.official !== null && typeof row?.official === 'object' && row.official.confidence !== 'ambiguous' ? row.official : undefined;
      if (official !== undefined) put('name', official.name, 'official', official.provider);
      const gateway = row?.gateway;
      if (gateway !== null && typeof gateway === 'object') {
        for (const field of CAPABILITY_FIELDS) {
          const value = field === 'input' ? modalitiesOf(gateway.input) : gateway[field];
          // A listing usually spells the display name as the id it serves;
          // writing that into `name` would fill a field and say nothing.
          put(field, field === 'name' && value === row.model ? undefined : value, 'gateway');
        }
      }
      if (official !== undefined) {
        for (const field of CAPABILITY_FIELDS) {
          put(field, field === 'input' ? modalitiesOf(official.input) : official[field], 'official', official.provider);
        }
      }
      return { values, sources };
    }

    /**
     * The levels detection suggests for one model, or undefined when nothing
     * was detected.
     *
     * The gateway's table says what the endpoint accepts; the catalog says what
     * the model itself supports. When both speak, their intersection is the set
     * that both passes validation and means something — and a model the catalog
     * calls non-reasoning keeps that reading even when the gateway lists its
     * own default table, which is the trap CLIProxyAPI sets for custom providers
     * it was not told about.
     * @param table - the gateway's accepted table, when the probe produced one.
     * @param official - the catalog reading, when the catalog knows the model.
     * @returns levels in escalation order, or undefined to keep the generic preset.
     */
    function suggestedLevels(table, official) {
      const gateway = Array.isArray(table) ? table : undefined;
      const catalog =
        official !== null && typeof official === 'object' && official.confidence !== 'ambiguous' && Array.isArray(official.levels)
          ? official.levels
          : undefined;
      const withOff = (levels) => LEVELS.filter((level) => level === 'off' || levels.includes(level));
      if (catalog !== undefined && catalog.length === 0) return [];
      if (gateway !== undefined && gateway.length === 0) return [];
      if (gateway !== undefined && catalog !== undefined) {
        const shared = LEVELS.filter((level) => level !== 'off' && gateway.includes(level) && catalog.includes(level));
        if (shared.length > 0) return withOff(shared);
        const known = catalog.filter((level) => level !== 'off');
        return known.length > 0 ? withOff(known) : [];
      }
      if (gateway !== undefined) return withOff(gateway);
      if (catalog !== undefined) return withOff(catalog.filter((level) => level !== 'off'));
      return undefined;
    }

    /**
     * What one model row would change if the detected capabilities were applied.
     *
     * A field the entry omits is filled in; a field it states is compared, and
     * a disagreement is reported for the user to decide on. `adopted` holds the
     * conflicts the user explicitly took over, keyed by model id then field.
     * @param model - the model entry as the document states it.
     * @param row - its `detect` result, when detection answered for it.
     * @param adopted - the conflicts the user already chose to overwrite.
     * @returns the values that would be written, the disagreements to show, and
     *   the catalog readings that could not be ranked.
     */
    function planOf(model, row, adopted) {
      const fills = [];
      const conflicts = [];
      const id = idOf(model);
      if (id.length === 0 || row === undefined) return { fills, conflicts, ambiguous: undefined };
      const { values, sources } = detectedOf(row);
      const taken = adopted?.[id] ?? {};
      for (const field of CAPABILITY_FIELDS) {
        const value = values[field];
        if (value === undefined) continue;
        const current = capabilityOf(model, field);
        if (current === undefined) {
          fills.push({ field, value, source: sources[field], auto: true });
          continue;
        }
        const chosen = taken[field];
        if (chosen !== undefined && !sameCapability(field, chosen, current)) {
          fills.push({ field, value: chosen, source: sources[field], adopted: true });
          continue;
        }
        if (!sameCapability(field, current, value)) conflicts.push({ field, current, detected: value, source: sources[field] });
      }
      const variants = row.official?.confidence === 'ambiguous' && Array.isArray(row.official.variants) ? row.official.variants : undefined;
      return { fills, conflicts, ambiguous: variants };
    }

    /** The model-entry fields these fills write. */
    function fieldsOf(fills) {
      const fields = {};
      for (const fill of fills) fields[fill.field] = fill.value;
      return fields;
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

    /**
     * Capability detection already answered for one route, keyed the same way.
     * The gateway listing costs one request and the catalog lookup is local, so
     * one answer per route and model set lasts a session.
     */
    const capabilityCache = new Map();

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
      /**
       * One call on the Host half's channel.
       *
       * Resolved at call time rather than at apply time, so the panel still
       * renders on a page whose connection service arrives late. Always
       * resolves to an RPC result — `{ ok: true, value }` or
       * `{ ok: false, error }` — and never throws.
       */
      const call = (endpoint, payload) => {
        const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
        if (connection === undefined || typeof connection.rpc?.call !== 'function') {
          return Promise.resolve({ ok: false, error: { code: 'no-connection', message: 'this page has no connection to the Host' } });
        }
        return Promise.resolve(connection.rpc.call(PROBE_CHANNEL, endpoint, payload)).catch((error) => ({
          ok: false,
          error: { code: 'transport', message: String(error?.message ?? error) },
        }));
      };
      return {
        t,
        snapshot: () => mirror.getSnapshot(),
        subscribe: (listener) => mirror.subscribe(listener),
        /**
         * Apply one write through the shared form, and always resolve.
         *
         * `mutate` answers `true` for an accepted write and `false` for a
         * refused one, but it may also throw synchronously or reject — no
         * connection to the Host, a dropped request, a revision conflict that
         * the queue surfaces as an exception. The caller sets a "saving" status
         * before it awaits this, so a rejection that escaped would leave the
         * panel saying "saving" forever with the change unsaved and the button
         * disabled. Like `probe`, this therefore never throws: a failure is a
         * `false` answer, which the panel already renders as a failed save.
         */
        write: (ops) => {
          try {
            return Promise.resolve(form.mutate(ops)).then(
              (accepted) => accepted === true,
              () => false,
            );
          } catch {
            return Promise.resolve(false);
          }
        },
        /** Ask the shared mirror for a fresh read; it answers with its own snapshot. */
        reload: () => {
          if (typeof mirror?.load !== 'function') return undefined;
          return Promise.resolve(mirror.load()).catch(() => undefined);
        },
        /**
         * Ask the Host half which levels this route's gateway accepts.
         * @param payload - the route and the model ids to ask about.
         */
        probe: (payload) => call('probe', payload),
        /**
         * Ask the Host half what else it can detect about these models: the
         * endpoint's own listing, and the installed catalog's row for each id.
         * @param payload - the route and the model ids to describe.
         */
        detect: (payload) => call('detect', payload),
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
      // What the Host could detect about the models themselves — the endpoint's
      // own listing and the installed catalog's row for each id.
      const [caps, setCaps] = React.useState({ status: 'idle' });
      // The conflicts the user chose to overwrite with a detected value, keyed
      // by model id then field. Reset with the document, like the drafts.
      const [adopted, setAdopted] = React.useState(null);
      const [nonce, setNonce] = React.useState(0);
      // Ids whose levels this panel filled from detection, so a later, more
      // specific answer may refine them while a hand-picked set never gets
      // rewritten.
      const autoLevels = React.useRef(new Set());
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
        setAdopted(null);
        autoLevels.current = new Set();
        setOrder(null);
        dragRef.current = null;
        setDragId(null);
        setDropAt(null);
      }, [ready, revision, pathKey, modelKey]);

      const undeclared = models.some((model) => model?.reasoningEfforts === undefined);
      // null follows the document: open while a model still declares nothing or
      // the read has not answered, closed once every model has decided.
      const expanded = manual ?? (undeclared || pending || unavailable);

      // The key carries the endpoint and protocol as well as the model set: a
      // baseURL or api edit on the same route serves different models with
      // different capabilities, and a session cache keyed only by ids would
      // replay the old gateway's answer.
      const detectKey = `${SETTINGS_NS}|${pathKey}|${modelKey}|${String(profile?.baseURL ?? '')}|${String(profile?.api ?? '')}`;

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

      // Ask the Host what else it knows about these models: the endpoint's own
      // listing, and the installed pi-ai catalog's row for each id. Unlike the
      // level probe this costs one listing request plus a local lookup, so it
      // runs beside the probe and caches its answer the same way.
      React.useEffect(() => {
        if (!expanded || !ready || modelIds.length === 0) return undefined;
        const cached = capabilityCache.get(detectKey);
        if (cached !== undefined) {
          setCaps({ status: 'ready', byModel: cached.byModel, gateway: cached.gateway, catalog: cached.catalog });
          return undefined;
        }
        let live = true;
        setCaps({ status: 'loading' });
        api.detect({ settingsNs: SETTINGS_NS, settingsPath, models: modelIds }).then((answer) => {
          if (!live) return;
          if (answer?.ok !== true) {
            setCaps({ status: 'error', detail: answer?.error?.message ?? 'unknown' });
            return;
          }
          const byModel = {};
          for (const entry of answer.value?.results ?? []) {
            if (typeof entry?.model === 'string' && entry.model.length > 0) byModel[entry.model] = entry;
          }
          const value = { byModel, gateway: answer.value?.gateway, catalog: answer.value?.catalog };
          capabilityCache.set(detectKey, value);
          setCaps({ status: 'ready', ...value });
        });
        return () => {
          live = false;
        };
      }, [expanded, ready, detectKey, nonce]);

      // Let detection refine the generic preset. A model that declares nothing
      // is pre-filled with the levels the gateway's table and the catalog agree
      // on; one that already declares something is left alone, and so is a set
      // the user picked by hand. A later answer — the catalog arriving after the
      // probe — may refine only a set this panel filled itself.
      React.useEffect(() => {
        if (detect.status !== 'ready' && caps.status !== 'ready') return;
        setDraft((current) => {
          if (current === null) return current;
          let changed = false;
          const next = { ...current };
          for (const model of models) {
            const id = idOf(model);
            if (id.length === 0 || model.reasoningEfforts !== undefined) continue;
            const table = suggestedLevels(detect.byModel?.[id], caps.byModel?.[id]?.official);
            if (table === undefined) continue;
            const held = next[id] ?? [];
            if (sameLevels(held, table)) {
              autoLevels.current.add(id);
              continue;
            }
            if (!sameLevels(held, RECOMMENDED) && !autoLevels.current.has(id)) continue;
            next[id] = [...table];
            autoLevels.current.add(id);
            changed = true;
          }
          return changed ? next : current;
        });
      }, [detect, caps, ready, revision, modelKey]);

      // What capability detection would change in each row, recomputed from the
      // document as it is now: missing fields are filled on save, stated fields
      // are only compared, and a disagreement waits for the user's say-so.
      const plans = new Map();
      if (caps.status === 'ready') {
        for (const model of models) plans.set(model, planOf(model, caps.byModel?.[idOf(model)], adopted));
      }
      const capsDirty = models.some((model) => (plans.get(model)?.fills.length ?? 0) > 0);

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
      const dirty = levelsDirty || orderDirty || capsDirty;

      const toggle = (id, level) => {
        setWrite({ status: 'idle' });
        // A hand-picked set is the user's answer for this model; a later
        // detection pass must not overwrite it.
        autoLevels.current.delete(id);
        setDraft((current) => {
          const held = current?.[id] ?? [];
          const chosen = held.includes(level) ? held.filter((entry) => entry !== level) : [...held, level];
          return { ...current, [id]: LEVELS.filter((entry) => chosen.includes(entry)) };
        });
      };

      /** Take the detected values behind one row's disagreements, into the draft. */
      const adopt = (id, plan) => {
        if (id.length === 0 || plan === undefined || plan.conflicts.length === 0) return;
        const values = {};
        for (const conflict of plan.conflicts) values[conflict.field] = conflict.detected;
        setWrite({ status: 'idle' });
        setAdopted((current) => ({ ...(current ?? {}), [id]: { ...(current?.[id] ?? {}), ...values } }));
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
          if (id.length === 0) return model;
          // Rewrite the levels only when they really differ: `withLevels`
          // re-spells every level from its id, and a hand-written wire value
          // (a gateway that maps "low" to something else) must survive a write
          // that was only adding a context window.
          const levelsChanged = draft?.[id] !== undefined && !sameDeclared(valueOf(draft[id]), model.reasoningEfforts);
          const entry = levelsChanged ? withLevels(model, draft[id]) : model;
          // Detected capabilities ride the same write: the fields the entry
          // omits are filled in, and the disagreements the user took over are
          // overwritten. A conflict left alone keeps the entry's own value.
          const fills = plans.get(model)?.fills ?? [];
          return fills.length === 0 ? entry : { ...entry, ...fieldsOf(fills) };
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
        return `${t('detected')}${t('meta.colon')}${named.map((level) => t(`level.${level}`)).join(' / ')}`;
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

      /**
       * The route-level line for capability detection: a pending ask, a
       * failure, or the one state worth explaining — the endpoint disclosed no
       * listing, so what follows comes from the installed catalog alone.
       */
      const capsText = (() => {
        if (caps.status === 'loading') return t('metaDetecting');
        if (caps.status === 'error') return t('metaFailed', { detail: caps.detail });
        if (caps.status === 'ready' && caps.gateway?.ok === false) return t('metaListingFailed', { detail: caps.gateway.detail ?? '' });
        if (caps.status === 'ready' && caps.catalog?.ok === false) return t('metaNoCatalog');
        return '';
      })();

      /** One capability value as the row renders it. */
      const formatCapability = (field, value) => {
        if (field === 'input') return (value ?? []).map((modality) => t(`modality.${modality}`)).join('+');
        if (field === 'contextWindow' || field === 'maxTokens') return Number(value).toLocaleString();
        return String(value);
      };

      /** Where one fill or conflict came from, as the row names it. */
      const sourceLabel = (source) => {
        if (source?.source === 'official' && typeof source.provider === 'string') return t('source.official', { provider: source.provider });
        return t('source.gateway');
      };

      /**
       * What capability detection would do with one row, as the line under its
       * chips. The fills are what a save writes; the conflicts are the ones the
       * user may take over with one click; the ambiguous readings are reported
       * because nothing ranked them.
       */
      const metaFor = (plan) => {
        if (plan === undefined) return undefined;
        const parts = [];
        const fillText = (fills) =>
          fills.map((fill) => `${t(`field.${fill.field}`)} ${formatCapability(fill.field, fill.value)}`).join(t('meta.pair'));
        const auto = plan.fills.filter((fill) => fill.adopted !== true);
        const taken = plan.fills.filter((fill) => fill.adopted === true);
        if (auto.length > 0) parts.push(t('metaFill', { fields: fillText(auto) }));
        if (taken.length > 0) parts.push(`${t('metaAdopted')}${t('meta.colon')}${fillText(taken)}`);
        if (plan.conflicts.length > 0) {
          const pairs = plan.conflicts
            .map((conflict) => `${t(`field.${conflict.field}`)} ${formatCapability(conflict.field, conflict.current)} → ${formatCapability(conflict.field, conflict.detected)}`)
            .join(t('meta.pair'));
          parts.push(t('metaConflict', { pairs }));
        }
        if (plan.ambiguous !== undefined && plan.fills.length === 0 && plan.conflicts.length === 0) {
          const values = plan.ambiguous
            .filter((variant) => variant.contextWindow !== undefined)
            .map((variant) => formatCapability('contextWindow', variant.contextWindow))
            .join(' / ');
          if (values.length > 0) parts.push(t('metaAmbiguous', { values }));
        }
        if (parts.length === 0) return undefined;
        const sources = [...new Set([...plan.fills, ...plan.conflicts].map((entry) => sourceLabel(entry.source)))];
        if (sources.length > 0) parts.push(t('metaSource', { source: sources.join(' / ') }));
        return { text: parts.join(t('meta.line')), conflict: plan.conflicts.length > 0 };
      };

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
              capsText.length === 0
                ? null
                : h('p', { className: caps.status === 'error' ? 'dsh-tl-error' : 'dsh-tl-hint' }, capsText),
              ready
                ? ordered.map(({ model, index }, at) => {
                    const id = idOf(model);
                    const named = id.length > 0;
                    const held = named ? draft?.[id] ?? levelsOf(model) : [];
                    const declared = valueOf(held);
                    const note = named ? noteFor(id) : '';
                    const plan = named ? plans.get(model) : undefined;
                    const meta = plan === undefined ? undefined : metaFor(plan);
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
                      meta === undefined
                        ? null
                        : h(
                            'div',
                            { className: meta.conflict ? 'dsh-tl-meta dsh-tl-meta-conflict' : 'dsh-tl-meta' },
                            h('span', null, meta.text),
                            meta.conflict && writable
                              ? h('button', { type: 'button', className: 'dsh-tl-adopt', onClick: () => adopt(id, plan) }, t('metaAdopt'))
                              : null,
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
                          capabilityCache.delete(detectKey);
                          setAdopted(null);
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
