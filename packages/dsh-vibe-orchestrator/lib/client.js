/**
 * dsh-vibe-orchestrator — browser half.
 *
 * Adds a **Vibe** page to the Plugins surface. Each delegation tier gets one row
 * with the same two controls the conversation composer uses: a model menu over
 * every route the Host advertises, and a reasoning-effort menu over the levels
 * the selected model offers.
 *
 * Nothing is typed by hand. The menus read `remote.session.modelCatalog()`, which
 * returns provider groups whose models carry their own `reasoning.efforts`, so the
 * page can only offer routes and levels that actually exist.
 *
 * The chosen provider and model are staged as two entries through the settings
 * form the Host serves for the `vibe-orchestrator` entry, so Save writes them as
 * one revision-fenced mutation and every field stays `volatile`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vibe-orchestrator',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Loader entry id that owns the tier routes. */
    const SETTINGS_ENTRY_ID = 'vibe-orchestrator'

    /** Dictionary namespace owned by this page. */
    const NS = 'settings.vibeOrchestrator'

    /** One tier: its id and the three config field names it stages. */
    const TIERS = [
      { id: 'fast', provider: 'vibeFastProvider', model: 'vibeFastModel', effort: 'vibeFastEffort' },
      { id: 'good', provider: 'vibeGoodProvider', model: 'vibeGoodModel', effort: 'vibeGoodEffort' },
      { id: 'expert', provider: 'vibeExpertProvider', model: 'vibeExpertModel', effort: 'vibeExpertEffort' },
    ]

    //#region dictionary

    const en = {
      title: 'Vibe',
      description: 'Model and thinking level for each delegated subagent tier.',
      fastTitle: 'Fast',
      fastDetail: 'Clearly specified, low-risk work.',
      goodTitle: 'Good',
      goodDetail: 'Work that needs judgement and design.',
      expertTitle: 'Expert',
      expertDetail: 'Advice on difficult problems; writes plans, never changes code.',
      model: 'Model',
      effort: 'Thinking level',
      effortUnspecified: 'Unspecified',
      effortNone: 'No levels',
      chooseModel: 'Choose a model',
      catalogEmpty: 'The Host advertises no model routes.',
      catalogFailed: 'Could not read the model list from the Host.',
      unavailable: 'Settings are unavailable.',
      readOnly: 'This deployment stores settings read-only.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The Host refused the change.',
    }

    const zh = {
      title: 'Vibe',
      description: '为每一档被派发的子代理选择模型与思考强度。',
      fastTitle: 'Fast',
      fastDetail: '需求明确、低风险的工作。',
      goodTitle: 'Good',
      goodDetail: '需要判断与设计的工作。',
      expertTitle: 'Expert',
      expertDetail: '疑难问题的方案咨询；可撰写计划，不改动代码。',
      model: '模型',
      effort: '思考强度',
      effortUnspecified: '不指定',
      effortNone: '无强度档位',
      chooseModel: '选择模型',
      catalogEmpty: 'Host 没有公布任何模型路由。',
      catalogFailed: '无法从 Host 读取模型列表。',
      unavailable: '设置不可用。',
      readOnly: '该部署以只读方式保存设置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: 'Host 拒绝了这次修改。',
    }
    //#endregion

    //#region helpers

    /** Form frame copy for `SettingsForm`. */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /**
     * Flatten the Host catalog into lookup tables the rows render from.
     *
     * A remote answers with an `{ ok, value }` envelope, so the payload is
     * unwrapped before it is read; a bare payload is accepted too.
     * @param {unknown} response - Answer of `remote.session.modelCatalog()`.
     * @returns {{ groups: object[], byRoute: Map<string, object>, failed: boolean, empty: boolean }}
     */
    function readCatalog(response) {
      const envelope = response !== null && typeof response === 'object' && 'ok' in response
      const payload = envelope ? (response.ok === true ? response.value : undefined) : response
      const groups = []
      const byRoute = new Map()
      if (payload === undefined || payload === null) {
        return { groups, byRoute, failed: true, empty: true }
      }
      const raw = Array.isArray(payload.groups) ? payload.groups : []
      for (const group of raw) {
        if (!group || typeof group.id !== 'string') continue
        const models = (Array.isArray(group.models) ? group.models : []).filter(
          (model) => model && typeof model.id === 'string',
        )
        if (models.length === 0) continue
        groups.push({ id: group.id, name: group.name ?? group.id, models })
        for (const model of models) byRoute.set(`${group.id}\u0000${model.id}`, model)
      }
      return { groups, byRoute, failed: false, empty: groups.length === 0 }
    }

    /** The advertised metadata for one staged route, when the Host still lists it. */
    function modelOf(catalog, provider, model) {
      if (typeof provider !== 'string' || typeof model !== 'string') return undefined
      return catalog.byRoute.get(`${provider}\u0000${model}`)
    }

    /** A model's display name, falling back to its id. */
    function modelLabel(model, id) {
      if (model !== undefined && typeof model.name === 'string' && model.name.length > 0) return model.name
      return typeof id === 'string' && id.length > 0 ? id : ''
    }

    /** The reasoning levels one route offers. */
    function effortsOf(model) {
      const levels = model?.reasoning?.efforts
      return Array.isArray(levels) ? levels.filter((level) => level && typeof level.id === 'string') : []
    }

    /** The display name of one reasoning level. */
    function effortLabel(levels, effort) {
      if (typeof effort !== 'string' || effort.length === 0) return undefined
      return levels.find((level) => level.id === effort)?.name ?? effort
    }
    //#endregion

    //#region controller

    /**
     * Stages every tier route over the Host entry and saves them as one revision.
     */
    var VibeController = class {
      /**
       * @param ctx - This page's plugin context, for the model catalog read.
       * @param scope - Settings scope bound to the `vibe-orchestrator` entry.
       */
      constructor(ctx, scope) {
        this.ctx = ctx
        this.disposed = false
        this.generation = 0
        this.catalog = { groups: [], byRoute: new Map(), failed: false, empty: true }
        const fields = []
        for (const tier of TIERS) {
          fields.push(primitives.settingsTextField(tier.provider))
          fields.push(primitives.settingsTextField(tier.model))
          fields.push(primitives.settingsTextField(tier.effort))
        }
        this.form = new primitives.SettingsFormModel(scope, fields)
        this.store = this.form.bind(() => this.projection())
        this.loadCatalog()
      }

      /** Every state value the page renders. */
      projection() {
        const tiers = {}
        for (const tier of TIERS) {
          tiers[tier.id] = {
            provider: this.form.field(tier.provider),
            model: this.form.field(tier.model),
            effort: this.form.field(tier.effort),
          }
        }
        return {
          ...this.form.shell(),
          tiers,
          catalog: this.catalog,
        }
      }

      /**
       * Read the advertised routes; the pickers render from them.
       *
       * Called once when the page mounts and again on every invalidation the Host
       * publishes, because the routable model set changes while a page is open.
       * A read that a newer one superseded is discarded.
       */
      async loadCatalog() {
        if (this.disposed) return
        const generation = ++this.generation
        let next
        try {
          next = readCatalog(await this.ctx.remote.session.modelCatalog())
        } catch {
          next = { groups: [], byRoute: new Map(), failed: true, empty: true }
        }
        if (this.disposed || generation !== this.generation) return
        this.catalog = next
        this.store.set(this.projection())
      }

      /** Stage a route, clearing a thinking level the new model does not offer. */
      choose(tierId, provider, model) {
        const tier = TIERS.find((candidate) => candidate.id === tierId)
        if (tier === undefined || this.actions === undefined || this.disposed) return
        this.actions.edit(tier.provider, provider)
        this.actions.edit(tier.model, model)
        const staged = this.form.field(tier.effort)?.text
        if (typeof staged === 'string' && staged.length > 0) {
          const levels = effortsOf(modelOf(this.catalog, provider, model))
          if (!levels.some((level) => level.id === staged)) this.actions.edit(tier.effort, '')
        }
      }

      /** Stage one thinking level. */
      chooseEffort(tierId, effort) {
        const tier = TIERS.find((candidate) => candidate.id === tierId)
        if (tier === undefined || this.actions === undefined || this.disposed) return
        this.actions.edit(tier.effort, effort)
      }

      /** Surface injected into the slot registration. */
      inject() {
        // The staging actions belong to the form model; the pickers write the
        // same fields the individual text inputs would have written.
        this.actions = this.form.actions()
        return {
          hooks: { vibePage: this.store },
          ...this.actions,
          choose: (tierId, provider, model) => this.choose(tierId, provider, model),
          chooseEffort: (tierId, effort) => this.chooseEffort(tierId, effort),
        }
      }

      /** Releases the settings subscription. */
      dispose() {
        this.disposed = true
        this.store.dispose?.()
        this.form.dispose()
      }
    }
    //#endregion

    //#region components

    /**
     * One picker: a menu button carrying the current value, over a `Menu` that
     * owns dismissal, placement, and keyboard handling.
     *
     * `items` renders the primitive's own rows; `children` renders custom grouped
     * rows. Exactly one of them is used.
     */
    function Picker(props) {
      const { open, setOpen, label, value, disabled, onClose, items, selectedId, onSelect, children } = props
      const trigger = jsxRuntime.jsx(primitives.Button, {
        type: 'button',
        variant: 'outline',
        size: 'sm',
        disabled,
        icon: jsxRuntime.jsx(primitives.IconChevronDownOutlineRegular, {}),
        onClick: () => setOpen(!open),
        children: jsxRuntime.jsxs('span', {
          style: { display: 'inline-flex', alignItems: 'baseline', gap: 6, minWidth: 0 },
          children: [
            jsxRuntime.jsx('span', { style: { fontSize: 11, opacity: 0.6 }, children: label }),
            jsxRuntime.jsx('span', {
              style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              children: value,
            }),
          ],
        }),
      })
      return jsxRuntime.jsx(primitives.Menu, {
        open,
        anchor: trigger,
        onClose,
        portal: true,
        ...(items === undefined ? {} : { items, selectedId, onSelect }),
        children,
      })
    }

    /** The model menu: one `MenuGroup` per provider, one row per model. */
    function ModelMenu(props) {
      const { t, open, setOpen, groups, selected, onPick, disabled } = props
      const rows = []
      for (const group of groups) {
        rows.push(
          jsxRuntime.jsx(
            primitives.MenuGroup,
            {
              label: group.name,
              children: group.models.map((model) =>
                jsxRuntime.jsx(
                  primitives.MenuItemButton,
                  {
                    icon:
                      selected.provider === group.id && selected.model === model.id
                        ? jsxRuntime.jsx(primitives.IconCheckOutlineRegular, {})
                        : undefined,
                    onSelect: () => {
                      onPick(group.id, model.id)
                      setOpen(false)
                    },
                    children: modelLabel(model, model.id),
                  },
                  model.id,
                ),
              ),
            },
            group.id,
          ),
        )
      }
      return jsxRuntime.jsx(Picker, {
        open,
        setOpen,
        label: t('model'),
        value: props.value,
        disabled,
        onClose: () => setOpen(false),
        children: rows,
      })
    }

    /** The thinking-level menu: the levels the selected route advertises. */
    function EffortMenu(props) {
      const { t, open, setOpen, levels, selected, onPick, disabled } = props
      const items = [
        { id: '', label: t('effortUnspecified') },
        ...levels.map((level) => ({ id: level.id, label: level.name ?? level.id })),
      ]
      return jsxRuntime.jsx(Picker, {
        open,
        setOpen,
        label: t('effort'),
        value: props.value,
        disabled: disabled || levels.length === 0,
        items,
        selectedId: selected,
        onSelect: (id) => {
          onPick(id)
          setOpen(false)
        },
        onClose: () => setOpen(false),
      })
    }

    /** One tier: its heading and the two pickers. */
    function TierRow(props) {
      const { t, tier, state, catalog, disabled, choose, chooseEffort } = props
      const [modelOpen, setModelOpen] = React.useState(false)
      const [effortOpen, setEffortOpen] = React.useState(false)
      const provider = state?.provider?.text ?? ''
      const model = state?.model?.text ?? ''
      const effort = state?.effort?.text ?? ''
      const advertised = modelOf(catalog, provider, model)
      const levels = effortsOf(advertised)
      // An empty level sends no `reasoningEffort`, so the model applies its own.
      // Showing which level that is answers "what will actually happen".
      const fallback = advertised?.reasoning?.defaultEffort
      const unspecified =
        typeof fallback === 'string' && fallback.length > 0
          ? `${t('effortUnspecified')} · ${effortLabel(levels, fallback) ?? fallback}`
          : t('effortUnspecified')
      const effortText = effortLabel(levels, effort) ?? unspecified
      const modelText = modelLabel(advertised, model) || t('chooseModel')

      return jsxRuntime.jsxs('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '10px 0',
          borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
        },
        children: [
          jsxRuntime.jsxs('div', {
            style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
            children: [
              jsxRuntime.jsx('code', {
                style: { fontSize: 12, fontWeight: 600 },
                children: t(`${tier.id}Title`),
              }),
              jsxRuntime.jsx('span', {
                style: { fontSize: 12, opacity: 0.7 },
                children: t(`${tier.id}Detail`),
              }),
            ],
          }),
          jsxRuntime.jsxs('div', {
            style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
            children: [
              jsxRuntime.jsx(ModelMenu, {
                t,
                open: modelOpen,
                setOpen: setModelOpen,
                groups: catalog.groups,
                selected: { provider, model },
                value: modelText,
                disabled,
                onPick: (nextProvider, nextModel) => choose(tier.id, nextProvider, nextModel),
              }),
              jsxRuntime.jsx(EffortMenu, {
                t,
                open: effortOpen,
                setOpen: setEffortOpen,
                levels,
                selected: effort,
                value: levels.length === 0 ? t('effortNone') : effortText,
                disabled,
                onPick: (next) => chooseEffort(tier.id, next),
              }),
            ],
          }),
        ],
      })
    }

    /** The Vibe settings page. */
    function VibePage(props) {
      const { t } = props
      // Hooks must run before any early return.
      const state = props.useVibePage((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')

      const disabled = !state.writable
      const catalog = state.catalog ?? { groups: [], byRoute: new Map(), failed: false, empty: true }
      const children = []
      if (catalog.failed || catalog.empty) {
        children.push(
          jsxRuntime.jsx('p', {
            style: { margin: '4px 0', fontSize: 12, color: 'var(--dsw-alias-state-error-primary, inherit)' },
            children: catalog.failed ? t('catalogFailed') : t('catalogEmpty'),
          }),
        )
      }
      for (const tier of TIERS) {
        children.push(
          jsxRuntime.jsx(
            TierRow,
            {
              t,
              tier,
              state: state.tiers[tier.id],
              catalog,
              disabled,
              choose: props.choose,
              chooseEffort: props.chooseEffort,
            },
            tier.id,
          ),
        )
      }
      return jsxRuntime.jsx(primitives.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children,
      })
    }
    //#endregion

    //#region plugin

    const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

    /** Mount the page while the Host serves the settings entry. */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-vibe-orchestrator: dictionaries')

      ctx.effect(
        () =>
          ctx.configForms.whileServed([SETTINGS_ENTRY_ID], () => {
            const controller = new VibeController(ctx, ctx.configForms.get(SETTINGS_ENTRY_ID))
            ctx.effect(() => () => controller.dispose(), 'dsh-vibe-orchestrator: form subscription')
            // The routable model set changes while the page is open: a provider is
            // added or removed, a key is stored, or the document is committed.
            // Re-read the catalog on every signal the shipped subagent page uses.
            ctx.effect(
              () => ctx.remote.$on('llm/adapters-updated', () => controller.loadCatalog()),
              'dsh-vibe-orchestrator: adapter invalidations',
            )
            ctx.effect(
              () => ctx.remote.$on('settings/document-updated', () => controller.loadCatalog()),
              'dsh-vibe-orchestrator: settings invalidations',
            )
            ctx.effect(
              () => ctx.on('connection/reset', () => controller.loadCatalog()),
              'dsh-vibe-orchestrator: connection resets',
            )
            return ctx.slots.inject('plugins.item', () =>
              ctx.slots.register(
                {
                  name: 'plugins.item',
                  id: 'vibe-orchestrator',
                  order: 60,
                  label: () => t('title'),
                  locale: NS,
                  inject: () => controller.inject(),
                },
                VibePage,
              ),
            )
          }),
        'dsh-vibe-orchestrator: page',
      )
    }

    //#endregion

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
