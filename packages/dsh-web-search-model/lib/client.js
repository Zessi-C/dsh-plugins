/**
 * dsh-web-search-model — browser half.
 *
 * The stock settings page shipped as @deepseek-ai/dsh-client-ui-settings-web-search
 * edits only three fields of the `web-search-deepseek` namespace: `apiKeyEnv`,
 * `baseURL` and `maxUses`. The provider's own config schema accepts seven fields.
 * The remaining three — `model`, `apiVersion` and `maxTokens` — are deliberately
 * left as composition values with no entry point in the UI. The upstream package
 * documents this as a known limitation:
 *
 *   "Only the namespace's three fields are edited — the provider's model, API
 *    version and token budget keep their composition values; this page edits the
 *    key, the endpoint and the search count only."
 *
 * `model` is the field most likely to break. The provider defaults to
 * `deepseek-v4-flash`, an id that self-hosted and third-party Anthropic-compatible
 * gateways commonly do not serve, so every search is rejected with HTTP 400 on
 * the gateway side while the settings page offers no way to see or change it.
 *
 * This package therefore takes over the whole card and adds a model field to it.
 *
 * ── How the card is taken over ───────────────────────────────────────────────
 *
 * Fields cannot be injected into the official React component: its children are
 * hard-coded and its component instance is unreachable, because the client
 * module exports only the plugin body while the card component is captured in a
 * factory closure.
 *
 * ── Where the page lives ─────────────────────────────────────────────────────
 *
 * The four-field card replaces the shipped one inside the built-in settings group.
 *
 * `plugins.item` is a list slot partitioned by cell id, and `SlotCore.entriesOfSlot`
 * keeps the first entry of each cell after sorting by `(priority, order)` — so
 * within one id the lowest priority renders. This package registers into the
 * shipped `web-search` cell at `priority: -1`; the shipped card stays mounted at
 * `priority: 0` and does not render. The group therefore shows ONE web search
 * card, with the `model` field added to the shipped three.
 *
 *   // dsh-client-ui-slots / SlotCore.entriesOfSlot
 *   for (const entry of rec.entries) {          // already sorted by priority
 *     const cell = kind === "list" ? entry.options.id : void 0;
 *     if (seenCells.has(cell)) continue;        // first entry of the cell wins
 *     seenCells.add(cell);
 *     heads.push(entry);
 *   }
 *
 * This package is also a bundle, so the Plugins list shows it and asks for the
 * bundle's own page through `plugins.bundle.config`. That registration answers
 * with nothing, because the settings belong on the card above and not in a second
 * place.
 *
 * ── Cost ─────────────────────────────────────────────────────────────────────
 *
 * Taking over the card means the whole card belongs to this package. The four
 * fields below are a faithful port of the official client component
 * (`apiKeyEnv` through the credential domain, `baseURL`, `maxUses`) plus a new
 * `model` field. Fields added or changed upstream will not be inherited
 * automatically; see README.md, "Maintenance".
 *
 * ── The model field ──────────────────────────────────────────────────────────
 *
 * The field is free text (`settingsTextField`); the dropdown lists known model
 * ids as suggestions only. A model id is a property of the gateway, not of this
 * plugin, and a hard-coded allow-list would reproduce the very bug this package
 * exists to fix: the gateway gains a model and the plugin silently goes stale.
 * Any id the gateway accepts is therefore valid input.
 */
window.__ModuleLoader__.load({
	id: "dsh-web-search-model",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region 常量
		/**
		 * Settings namespace of the web search provider.
		 *
		 * Written as a string literal rather than imported: a client package must
		 * not depend on a host package. The official settings page does the same.
		 */
		const WEB_SEARCH_NS = "web-search-deepseek";

		/** Credential reference the provider resolves when this section names none. */
		const DEFAULT_API_KEY_REF = "DEEPSEEK_API_KEY";

		/** Form field name used to stage the credential control. */
		const API_KEY_FIELD = "apiKey";

		/**
		 * Cell id and order of the shipped "Web search" card in `plugins.item`.
		 * Reusing the id puts this package in that cell, where a lower `priority`
		 * wins the cell and the shipped card does not render.
		 */
		const SHADOWED_CARD_ID = "web-search";
		// Keep this equal to the shipped card's own `order` (dsh 0.2.1-rc.2: 20;
		// it was 40 when this package took the cell). `order` is the position
		// among every `plugins.item` registration — settings cards share that one
		// sequence — so a stale value does not fail loudly: the card simply sorts
		// somewhere upstream never put it. `check-drift.py` flags the mismatch.
		const SHADOWED_CARD_ORDER = 20;

		/** Dictionary namespace owned by this page. */
		const NS = "settings.webSearchModel";
		//#endregion

		//#region 字典
		/** English copy. */
		const en = {
			title: "Web search",
			description: "Set up the DeepSeek search provider.",
			apiKey: "API key",
			apiKeyHint: "Stored outside the settings file. Leave blank to keep the current key.",
			apiKeySet: "A key is configured.",
			apiKeyUnset: "No key is configured; search is unavailable until one is.",
			baseUrl: "Endpoint",
			baseUrlHint: "Leave blank to use the provider default.",
			model: "Search model",
			modelHint: "Sent as the model name on the search request. Blank uses the provider default.",
			pick: "Known models",
			pickHint: "Pick a known model, or type any id the endpoint accepts.",
			maxUses: "Max searches per request",
			maxUsesHint: "How many times one request may search before it must answer.",
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			invalidNumber: "Enter a number, or leave blank to use the default.",
			invalidModel: "Enter a model id, or leave blank to use the provider default."
		};

		/** Simplified Chinese copy. */
		const zh = {
			title: "网页搜索",
			description: "设置 DeepSeek 的搜索提供方。",
			apiKey: "API Key",
			apiKeyHint: "不写入设置文件。留空表示保持当前密钥。",
			apiKeySet: "已配置密钥。",
			apiKeyUnset: "未配置密钥；配置之前搜索不可用。",
			baseUrl: "接口地址",
			baseUrlHint: "留空则使用提供方默认地址。",
			model: "搜索模型",
			modelHint: "作为搜索请求的 model 名发出。留空表示使用提供方默认值。",
			pick: "已知模型",
			pickHint: "从已知模型里挑一个，或直接手打网关接受的任意 id。",
			maxUses: "单次请求最多搜索次数",
			maxUsesHint: "一次请求在必须作答前最多可以搜索多少次。",
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			invalidNumber: "请填数字；留空表示使用默认值。",
			invalidModel: "请填模型 id；留空表示使用提供方默认值。"
		};

		/**
		 * Form-framework copy, taken from this page's dictionary.
		 * @param t - Dictionary reader for this page.
		 * @returns Labels required by the shared settings form renderer.
		 */
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		//#endregion

		//#region 已知模型
		/**
		 * Suggestions offered by the dropdown — suggestions, not an allow-list.
		 *
		 * The list is a snapshot of the model ids advertised by one
		 * Anthropic-compatible gateway. Refresh it whenever the gateway changes:
		 *
		 *   curl -s -H "Authorization: Bearer $API_KEY" \
		 *     "$GATEWAY_BASE_URL/models" \
		 *     | python3 -c "import sys,json;print('\n'.join(m['id'] for m in json.load(sys.stdin)['data']))"
		 *
		 * Stale entries are harmless: the field is free text, so a new id can be
		 * typed in directly.
		 */
		const KNOWN_MODELS = [
			"gemini-3.8-flash-high",
			"gemini-3.7-flash-high",
			"gemini-3.6-flash-high",
			"gemini-3.5-flash-lite",
			"gemini-3.1-flash-lite",
			"gemini-3-flash",
			"gemini-3.1-flash-image",
			"gemini-3.1-pro-low",
			"gemini-pro-agent",
			"deepseek-v4.1-flash"
		];
		//#endregion

		//#region 模型选择器
		/**
		 * A controlled dropdown: opening it lists the known models, and selecting
		 * one stages that id in the model field.
		 *
		 * It holds no value of its own — the single owner of the value is the form
		 * model's staged text, and this control only writes a candidate into it.
		 *
		 * @param props.disabled - Disabled for a read-only document or namespace.
		 * @param props.current - Currently staged text, used to mark the selected row.
		 * @param props.labels - Localized copy.
		 * @param props.onPick - Called with a chosen model id.
		 * @returns The trigger button and its dropdown list.
		 */
		function ModelPicker(props) {
			const [open, setOpen] = React.useState(false);
			const items = KNOWN_MODELS.map((id) => ({ id, label: id }));
			const trigger = jsxRuntime.jsx(primitives.Button, {
				type: "button",
				variant: "outline",
				size: "sm",
				disabled: props.disabled,
				icon: jsxRuntime.jsx(primitives.IconChevronDownOutlineRegular, {}),
				onClick: () => setOpen((was) => !was),
				children: props.labels.pick
			});
			return jsxRuntime.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" },
				children: [
					jsxRuntime.jsx(primitives.Menu, {
						open,
						anchor: trigger,
						items,
						selectedId: props.current,
						portal: true,
						selection: "check",
						onSelect: (id) => {
							props.onPick(id);
							setOpen(false);
						},
						onClose: () => setOpen(false)
					}),
					jsxRuntime.jsx("span", {
						style: { fontSize: 12, opacity: 0.65 },
						children: props.labels.pickHint
					})
				]
			});
		}
		//#endregion

		//#region 卡片
		/**
		 * Renders the search provider settings card: a summary line, or its form.
		 *
		 * Field order: key, endpoint, search model, search count. The first two and
		 * the last two form two groups — where the request goes and which model it
		 * names, versus how often one request may search.
		 *
		 * @param props - Requested view, dictionary copy, form snapshot and actions.
		 * @returns The summary line, or the form.
		 */
		function WebSearchCard(props) {
			const { t } = props;
			// Hooks must run before any early return.
			const state = props.useWebSearchCard((snapshot) => snapshot);
			if (props.view === "summary") return t("description");
			const disabled = !state.writable;
			return jsxRuntime.jsxs(primitives.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [
					jsxRuntime.jsx(primitives.SettingsSecretField, {
						id: "plugin-config-web-search-key",
						label: t("apiKey"),
						hint: t("apiKeyHint"),
						disabled: !state.apiKeyWritable,
						text: state.apiKey.text,
						configured: state.apiKeyConfigured,
						stateLabel: state.apiKeyConfigured ? t("apiKeySet") : t("apiKeyUnset"),
						onEdit: (text) => {
							props.edit(API_KEY_FIELD, text);
						}
					}),
					jsxRuntime.jsx(primitives.SettingsValueField, {
						id: "plugin-config-web-search-endpoint",
						label: t("baseUrl"),
						hint: t("baseUrlHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidNumber"),
						disabled,
						...state.baseURL,
						onEdit: (text) => {
							props.edit("baseURL", text);
						},
						onReset: () => {
							props.resetField("baseURL");
						}
					}),
					jsxRuntime.jsx(primitives.SettingsValueField, {
						id: "plugin-config-web-search-model",
						label: t("model"),
						hint: t("modelHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidModel"),
						disabled,
						...state.model,
						onEdit: (text) => {
							props.edit("model", text);
						},
						onReset: () => {
							props.resetField("model");
						}
					}),
					jsxRuntime.jsx(ModelPicker, {
						disabled,
						current: state.model.text,
						labels: { pick: t("pick"), pickHint: t("pickHint") },
						onPick: (id) => {
							props.edit("model", id);
						}
					}),
					jsxRuntime.jsx(primitives.SettingsValueField, {
						id: "plugin-config-web-search-max-uses",
						label: t("maxUses"),
						hint: t("maxUsesHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidNumber"),
						numeric: true,
						disabled,
						...state.maxUses,
						onEdit: (text) => {
							props.edit("maxUses", text);
						},
						onReset: () => {
							props.resetField("maxUses");
						}
					})
				]
			});
		}
		//#endregion

		/**
		 * Renders nothing: this bundle's settings live on the shipped web-search card,
		 * not on the bundle's own page.
		 * @returns null.
		 */
		function BundleConfigPlaceholder() {
			return null;
		}

		//#region 控制器
		/**
		 * Bridges the web-search-deepseek settings scope and the credential domain
		 * to this card.
		 *
		 * The key is the only control that does not live in the settings section:
		 * its plaintext never appears in any response, so the page only knows
		 * whether one is configured, and writes go through the credential domain
		 * addressed by the reference named in the settings section. It is still
		 * staged with the remaining fields, so a single save covers everything the
		 * page displays.
		 *
		 * This controller is a port of the official package's controller of the
		 * same name, with one additional model field.
		 */
		var WebSearchCardController = class {
			/**
			 * @param scope - Settings scope bound to the web-search-deepseek namespace.
			 * @param ctx - Context of this page plugin; its remote.credentials
			 *   namespace answers for the reference this section names.
			 */
			constructor(scope, ctx) {
				this.scope = scope;
				this.ctx = ctx;
				this.credential = { ref: "", configured: false, writable: true };
				this.form = new primitives.SettingsFormModel(scope, [
					primitives.settingsTextField("baseURL"),
					// The model is free text: a gateway property must not be hard-coded.
					primitives.settingsTextField("model"),
					primitives.settingsNumberField("maxUses")
				], [{
					field: API_KEY_FIELD,
					write: (text) => this.writeKey(text)
				}]);
				this.store = this.form.bind(() => this.projection());
				this.unsubscribe = scope.subscribe(() => {
					this.readCredential();
				});
				this.readCredential();
			}

			/**
			 * Form-framework state plus this card's three section fields and the
			 * credential state.
			 * @returns Every state value the card needs to render.
			 */
			projection() {
				return {
					...this.form.shell(),
					baseURL: this.form.field("baseURL"),
					model: this.form.field("model"),
					maxUses: this.form.field("maxUses"),
					apiKey: this.form.field(API_KEY_FIELD),
					apiKeyConfigured: this.credential.configured,
					apiKeyWritable: this.credential.writable
				};
			}

			/**
			 * Asks the credential domain for the reference this section currently
			 * names.
			 *
			 * The answer is stored together with the reference it describes:
			 * `apiKeyEnv` may change between request and response, and two reads may
			 * settle out of order, so only a response that still answers the current
			 * reference is published.
			 */
			async readCredential() {
				const ref = refOf(this.scope.getSnapshot());
				if (ref !== this.credential.ref) {
					this.credential = { ref, configured: false, writable: true };
					this.store.set(this.projection());
				}
				const response = await this.ctx.remote.credentials.describe([ref]);
				if (!response.ok || ref !== refOf(this.scope.getSnapshot())) return;
				const view = response.value[ref];
				const next = {
					ref,
					configured: view?.configured ?? false,
					writable: view?.writable ?? true
				};
				if (next.configured === this.credential.configured && next.writable === this.credential.writable) return;
				this.credential = next;
				this.store.set(this.projection());
			}

			/**
			 * Re-reads after the host reports a change to a reference this page
			 * watches.
			 *
			 * A key may be written elsewhere — the models page addresses the same
			 * reference — without the settings section changing, so without this
			 * step the badge would keep reporting a state the host already replaced.
			 * @param ref - Reference the host reports as changed.
			 */
			refreshCredential(ref) {
				if (ref !== this.credential.ref) return;
				this.readCredential();
			}

			/**
			 * Builds the surface injected into the slot registration.
			 * @returns This card's snapshot and its form actions.
			 */
			inject() {
				return {
					hooks: { webSearchCard: this.store },
					...this.form.actions()
				};
			}

			/**
			 * Writes the staged key, then re-reads whether the host now holds one.
			 * @param value - Staged credential plaintext.
			 * @returns Whether the host afterwards reports a configured credential.
			 */
			async writeKey(value) {
				await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot()), value);
				await this.readCredential();
				return this.credential.configured;
			}

			/** Releases the settings subscription. */
			dispose() {
				this.unsubscribe();
				this.form.dispose();
			}
		};

		/**
		 * Credential reference named by this section, or the provider default when
		 * none is named.
		 * @param snapshot - Current scope snapshot.
		 * @returns The reference to address.
		 */
		function refOf(snapshot) {
			const declared = snapshot.value?.apiKeyEnv;
			return declared !== void 0 && declared.length > 0 ? declared : DEFAULT_API_KEY_REF;
		}
		//#endregion

		//#region 插件体
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.credentials",
			"configForms"
		];

		/**
		 * Mounts the taken-over web search settings card while the host serves this
		 * namespace.
		 * @param ctx - Browser plugin context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-web-search-model: dictionaries");

			const card = new WebSearchCardController(ctx.configForms.get(WEB_SEARCH_NS), ctx);
			ctx.effect(() => () => {
				card.dispose();
			}, "dsh-web-search-model: form subscription");

			ctx.effect(() => ctx.remote.$on("credentials/reference-updated", (ref) => {
				card.refreshCredential(ref);
			}), "dsh-web-search-model: credential invalidations");

			// Two registrations, one visible surface.
			//
			// `plugins.item` is the shipped plugin-settings group. This package takes
			// over its "web-search" cell at `priority: -1` so the group shows one card
			// with four fields rather than the shipped three plus a second card beside
			// them. The official registration stays mounted at `priority: 0` and simply
			// does not render.
			ctx.effect(() => ctx.configForms.whileServed([WEB_SEARCH_NS], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
				name: "plugins.item",
				id: SHADOWED_CARD_ID,
				order: SHADOWED_CARD_ORDER,
				priority: -1,
				label: () => t("title"),
				locale: NS,
				inject: () => card.inject()
			}, WebSearchCard))), "dsh-web-search-model: card");

			// This package is also a bundle, so the Plugins list shows it and asks for
			// this key while rendering the bundle's own page. Answering with nothing
			// keeps the settings out of that page instead of showing them twice.
			ctx.effect(() => ctx.configForms.whileServed([WEB_SEARCH_NS], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: "dsh-web-search-model",
				locale: NS
			}, BundleConfigPlaceholder))), "dsh-web-search-model: bundle page");
		}
		//#endregion

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
