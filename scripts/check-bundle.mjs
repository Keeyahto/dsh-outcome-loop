/**
 * Bundle content check (spec §18, §19.5): verify the packed tarball contains
 * everything the patch rows and the docs promise. Run after `pnpm pack`:
 *   node scripts/check-bundle.mjs dsh-outcome-loop-<version>.tgz
 */

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)

function main() {
  const tarball = process.argv[2]
  if (!tarball) {
    console.error('usage: node scripts/check-bundle.mjs <tarball>')
    process.exitCode = 1
    return
  }
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  const files = listing.split('\n').filter(Boolean)

  const required = [
    'package/package.json',
    'package/cordis.patch.yml',
    'package/lib/index.js',
    'package/lib/consumers/commands.js',
    'package/lib/consumers/projection.js',
    'package/README.md',
    'package/ARCHITECTURE.md',
    'package/PRIVACY.md',
    'package/SECURITY.md',
    'package/DATA_FORMAT.md',
    'package/COMPATIBILITY.md',
    'package/CHANGELOG.md',
    'package/LICENSE',
  ]
  const missing = required.filter((f) => !files.includes(f))
  if (missing.length > 0) {
    console.error('missing from tarball:', missing.join(', '))
    process.exitCode = 1
    return
  }

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
    console.error('dsh.bundle.patch must point to ./cordis.patch.yml')
    process.exitCode = 1
    return
  }
  console.log(`bundle check ok: ${tarball} (${files.length} files)`)
}

main()
