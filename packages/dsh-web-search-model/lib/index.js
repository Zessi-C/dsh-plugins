/**
 * dsh-web-search-model — host half.
 *
 * Empty apply: this package has no behaviour on the Node side. It exists to hold
 * one Loader entry, so that dsh-client-modules discovers the package while
 * scanning enabled entries and thereby hands ./client — declared under
 * `dsh.client` in package.json — to the browser. All logic lives in lib/client.js.
 *
 * This is the same pattern as the host half of
 * @deepseek-ai/dsh-client-ui-settings-web-search: the browser half is exposed
 * through exports["./client"] and discovered from the `dsh.client` declaration.
 */

/** Host plugin body — this surface plugin has no host-side behaviour. */
export function apply() {}
