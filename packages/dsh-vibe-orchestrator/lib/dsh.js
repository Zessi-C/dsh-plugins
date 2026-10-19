/**
 * Import this plugin's Host dependencies from the Host's own installation.
 *
 * A profile-installed bundle may be linked (`link:`) from a directory outside the
 * profile, so a bare `import '@deepseek-ai/…'` inside this module cannot rely on
 * the profile's `node_modules`. Resolving through the running Host's entry point
 * instead shares the exact library instances the Host already loaded, so the
 * plugin needs no bundled copy and no `node_modules` of its own. That is what
 * makes the bundle installable unchanged on another device.
 *
 * @module dsh-vibe-orchestrator/dsh
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Candidate resolution bases, most specific first. */
function bases() {
  const found = []
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry.length > 0) found.push(entry)
  if (typeof __filename === 'string') found.push(__filename)
  return found
}

/**
 * Import one package from the Host's dsh installation.
 * @param {string} specifier - Bare package specifier, such as `@deepseek-ai/schemastery`.
 * @returns {Promise<any>} The imported module namespace.
 */
export async function importHostPackage(specifier) {
  for (const base of bases()) {
    try {
      const require = createRequire(base)
      return await import(pathToFileURL(require.resolve(specifier)).href)
    } catch {
      // Try the next base; the caller's own directory is the last resort.
    }
  }
  return await import(specifier)
}
