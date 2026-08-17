/**
 * Pack/import smoke (spec §19.5): plain Node must import the BUILT entry
 * (`lib/index.js`) without a bundler and the plugin object must expose the
 * contract the loader expects (name, inject, Config, apply).
 * Run after `pnpm build`: `node test/smoke/import-smoke.mjs`.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json')

async function main() {
  assert.equal(pkg.type, 'module', 'package must be ESM')

  const entry = await import(`../../lib/index.js`)
  assert.ok(entry.default, 'default export (plugin object) is missing')
  const plugin = entry.default
  assert.equal(plugin.name, 'outcome-loop', 'plugin name mismatch')
  assert.ok(Array.isArray(plugin.inject), 'plugin.inject must be an array')
  assert.ok(plugin.inject.includes('storageDomain'), 'storageDomain must be injected')
  assert.equal(typeof plugin.apply, 'function', 'plugin.apply must be a function')
  assert.ok(plugin.Config !== undefined, 'plugin.Config (schemastery) must be present')

  // All patch rows must resolve to real built modules.
  const rows = ['lib/index.js', 'lib/consumers/commands.js', 'lib/consumers/projection.js']
  for (const row of rows) {
    const mod = await import(`../../${row}`)
    assert.ok(mod.default || mod.apply, `${row} must export a plugin`)
    console.log(`smoke ok: ${row}`)
  }

  // Service class surface.
  const { OutcomeLoopService } = entry
  assert.equal(typeof OutcomeLoopService, 'function', 'OutcomeLoopService must be exported')
  assert.ok(Array.isArray(OutcomeLoopService.inject), 'service inject must be an array')

  console.log('smoke ok: plain Node import of the built bundle')
}

main().catch((error) => {
  console.error('smoke failed:', error)
  process.exitCode = 1
})
