/**
 * Contribution mode consumer (spec §5.3, ADR-0005) — DEFAULT-UNINSTALLED.
 *
 * This row is NOT in the default cordis.patch.yml. Users add it manually and
 * must set `contribute.enabled: true`; without that the plugin registers
 * nothing. The dataset it prepares is LOCAL and user-delivered — there is no
 * upload channel, no hidden telemetry, and revoking is deleting the
 * directory. Consent, scope, retention and withdrawal are recorded in a
 * versioned manifest next to the data.
 *
 * Dataset = export-v1 records (already minimal: no message/code/credentials)
 * + deterministic redaction gate (any secret/personal hit blocks the batch)
 * + consent manifest. --summary-only writes aggregates only.
 */

import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import s from '@deepseek-ai/schemastery'

import type { OutcomeResult } from '../domain/errors.ts'
import { err, ok } from '../domain/errors.ts'
import { redactText } from '../export/redact.ts'
import { EXPORT_FIELD_MANIFEST } from '../export/schema.ts'

export const name = 'outcome-loop-contribute'
export const inject = ['outcomeLoop', 'commands']

export const Config: ReturnType<typeof s.object> = s.object({
  /** The plugin is a no-op unless the deployment explicitly enables it. */
  enabled: s.boolean().default(false),
})
export type ContributeConfig = Schemastery.TypeT<typeof Config>

export const CONTRIBUTION_SCHEMA_VERSION = 'outcome-loop.contribution.v1'
export const CONSENT_VERSION = 'outcome-loop.consent.v1'

export interface ContributionManifest {
  schema_version: typeof CONTRIBUTION_SCHEMA_VERSION
  consent_version: typeof CONSENT_VERSION
  created_at: number
  contract_id: string
  record_count: number
  summary_only: boolean
  fields: readonly string[]
  license: string
  recipient: string
  purpose: string
  retention: string
  compensation: string
  withdrawal: string
  preview_digest: string
  plugin_version: string
  dsh_version: string | undefined
  sensitivity_counts: Readonly<Record<string, number>>
  redaction_changes: number
}

export interface DatasetFiles {
  'manifest.json': string
  'records.jsonl'?: string
  'summary.json'?: string
}

/**
 * Deterministic gate: redact every record line; ANY change means the batch
 * carries something the plugin must never put in a contribution dataset —
 * the batch is blocked (ADR-0005 rule: secret 阻断).
 */
export function buildContributionDataset(
  recordLines: readonly string[],
  manifest: ContributionManifest,
  options: { redactSecrets: boolean; redactPersonalData: boolean },
): OutcomeResult<DatasetFiles> {
  const files: DatasetFiles = { 'manifest.json': `${JSON.stringify(manifest, null, 2)}\n` }
  if (manifest.summary_only) {
    files['summary.json'] = recordLines.join('\n')
    return ok(files)
  }
  const safeLines: string[] = []
  for (const line of recordLines) {
    const redacted = redactText(line, options)
    if (redacted.changes > 0) {
      return err('policy-denied', `contribution batch blocked: ${redacted.changes} redaction hit(s) in record content — remove the sensitive field or use --summary-only`)
    }
    safeLines.push(line)
  }
  files['records.jsonl'] = `${safeLines.join('\n')}${safeLines.length > 0 ? '\n' : ''}`
  manifest.redaction_changes = 0
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`
  return ok(files)
}

export function apply(ctx: Context, config: ContributeConfig): void {
  if (!config.enabled) {
    // Default-uninstalled AND default-disabled: registering nothing is the
    // guarantee that contribution is never on by accident.
    return
  }
  ctx.commands.register({
    name: 'contribute',
    description: 'contribution mode: prepare a redacted, consented dataset for user-delivered training data (opt-in only)',
    input: { hint: '<preview|approve|revoke> …' },
    recordInput: false,
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const service = ctx.outcomeLoop
      const tokens = (invocation.rawInput.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
      const command = tokens[0]
      const args = tokens.slice(1)

      try {
        switch (command) {
          case 'preview': {
            const contractId = args[0] ?? ''
            if (contractId.length === 0) return { kind: 'error', text: 'preview requires a contract id' }
            const preview = await service.previewExport({ contractId: contractId as never })
            if (!preview.ok) return { kind: 'error', text: formatError(preview.error) }
            const lines = [
              `Contribution preview for ${contractId}: ${preview.value.recordCount} record(s), digest ${preview.value.previewDigest}`,
              `fields: ${preview.value.fieldManifest.join(', ')}`,
              `sensitivity: ${JSON.stringify(preview.value.sensitivityHits)}`,
            ]
            if ((preview.value.sensitivityHits.secret ?? 0) > 0) {
              lines.push('secret-class evidence present — content is blocked from records (counts only, see manifest)')
            }
            for (const warning of preview.value.warnings) lines.push(`warning: ${warning}`)
            lines.push(`approve with: /contribute approve ${preview.value.previewDigest} ${contractId} --out <dir> [--summary-only]`)
            return { kind: 'success', text: lines.join('\n') }
          }
          case 'approve': {
            const digest = args[0] ?? ''
            const contractId = args[1] ?? ''
            const outDir = args[2] ?? ''
            if (digest.length !== 64 || contractId.length === 0) {
              return { kind: 'error', text: 'approve requires <digest> <contract-id> [--out <dir>] [--summary-only]' }
            }
            const dirIndex = args.indexOf('--out')
            const resolvedDir = dirIndex >= 0 ? args[dirIndex + 1] : outDir
            if (resolvedDir === undefined || resolvedDir.length === 0) {
              return { kind: 'error', text: 'approve requires --out <dir>' }
            }
            const summaryOnly = args.includes('--summary-only')
            const targetResult = await resolveScopedTarget(invocation, resolvedDir)
            if (!targetResult.ok) return { kind: 'error', text: formatError(targetResult.error) }
            const target = targetResult.value
            const { access, mkdir, rm, writeFile } = await import('node:fs/promises')
            try {
              await access(target)
              return { kind: 'error', text: `'${resolvedDir}' already exists — revoke/remove it first (withdrawal is deletion)` }
            } catch {
              // absent: proceed
            }
            const exported = await service.exportJsonl({ contractId: contractId as never, previewDigest: digest })
            if (!exported.ok) return { kind: 'error', text: formatError(exported.error) }
            const manifest: ContributionManifest = {
              schema_version: CONTRIBUTION_SCHEMA_VERSION,
              consent_version: CONSENT_VERSION,
              created_at: Date.now(),
              contract_id: contractId,
              record_count: exported.value.manifest.recordCount,
              summary_only: summaryOnly,
              fields: [...EXPORT_FIELD_MANIFEST],
              license: exported.value.manifest.license,
              recipient: 'user-delivered (this plugin performs no upload)',
              purpose: 'training-data curation — the user decides recipients and terms',
              retention: 'user-controlled',
              compensation: 'none (this plugin never charges or pays)',
              withdrawal: 'delete this dataset directory; consent is recorded here for the record',
              preview_digest: digest,
              plugin_version: exported.value.manifest.outcomeLoopVersion,
              dsh_version: exported.value.manifest.dshVersion,
              sensitivity_counts: { ...exported.value.manifest.sensitivityHits },
              redaction_changes: 0,
            }
            const lines = summaryOnly
              ? [JSON.stringify({ contract_id: contractId, verification: { status: exported.value.manifest.recordCount > 0 ? 'see export' : 'not-run' }, sensitivity: manifest.sensitivity_counts })]
              : exported.value.content.trimEnd().split('\n')
            const files = buildContributionDataset(lines, manifest, { redactSecrets: true, redactPersonalData: true })
            if (!files.ok) return { kind: 'error', text: formatError(files.error) }
            try {
              await mkdir(target, { recursive: true })
              for (const [name, content] of Object.entries(files.value)) {
                await writeFile(join(target, name), content, 'utf8')
              }
            } catch (error) {
              await rm(target, { recursive: true, force: true })
              return { kind: 'error', text: `failed to write dataset: ${error instanceof Error ? error.message : String(error)}` }
            }
            return { kind: 'success', text: `Contribution dataset prepared at ${target} (${summaryOnly ? 'summary-only' : `${manifest.record_count} record(s)`})\nConsent manifest: ${manifest.consent_version}` }
          }
          case 'revoke': {
            const contractId = args[0] ?? ''
            const dirIndex = args.indexOf('--out')
            const resolvedDir = dirIndex >= 0 ? args[dirIndex + 1] : undefined
            if (contractId.length === 0 || resolvedDir === undefined) {
              return { kind: 'error', text: 'revoke requires <contract-id> --out <dir> --yes' }
            }
            if (!args.includes('--yes')) {
              return { kind: 'error', text: 'revoke requires --yes; it DELETES the dataset directory (withdrawal)' }
            }
            const targetResult = await resolveScopedTarget(invocation, resolvedDir)
            if (!targetResult.ok) return { kind: 'error', text: formatError(targetResult.error) }
            const { rm } = await import('node:fs/promises')
            await rm(targetResult.value, { recursive: true, force: true })
            return { kind: 'success', text: `Dataset revoked (deleted): ${targetResult.value}` }
          }
          default:
            return { kind: 'error', text: 'Usage: /contribute <preview|approve|revoke> …' }
        }
      } catch (error) {
        return { kind: 'error', text: `outcome-loop-contribute: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
}

/** Workspace-scoped path resolution shared with the outcome command. */
async function resolveScopedTarget(
  invocation: { agent: { session: { header: { cwd?: string } } } },
  path: string,
): Promise<OutcomeResult<string>> {
  const cwd = invocation.agent.session.header.cwd
  if (cwd === undefined) {
    return err('invalid-input', 'this session has no workspace root (cwd)')
  }
  const { isAbsolute, resolve, relative } = await import('node:path')
  if (isAbsolute(path)) return err('invalid-input', 'path must be workspace-relative')
  const target = resolve(cwd, path)
  const rel = relative(cwd, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return err('invalid-input', `path '${path}' escapes the workspace`)
  }
  return ok(target)
}

function formatError(error: { code: string; message: string }): string {
  return `outcome-loop-contribute [${error.code}]: ${error.message}`
}
