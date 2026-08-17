/**
 * Deployment configuration (spec §11). All tunables live in this Schemastery
 * schema and are validated at plugin load. Defaults are locked to the safe
 * side: no model calls, no network, no active commands, no raw content.
 *
 * Field names may evolve before 1.0, but the default semantics must never
 * weaken — tests in test/privacy enforce the hard gates.
 */

import s from '@deepseek-ai/schemastery'

export const Config: ReturnType<typeof s.object> = s.object({
  mode: s.string().default('personal'),
  capture: s
    .object({
      enabled: s.boolean().default(true),
      rawToolArguments: s.boolean().default(false),
      rawToolResults: s.boolean().default(false),
      rawMessages: s.boolean().default(false),
      pathMode: s.string().default('relative'),
      maxExcerptBytes: s.number().default(4096),
    }),
  verification: s
    .object({
      observeExisting: s.boolean().default(true),
      autoRun: s.boolean().default(false),
      llmJudge: s.string().default('disabled'),
      commandTimeoutMs: s.number().default(120000),
      maxCommandOutputBytes: s.number().default(65536),
    }),
  privacy: s
    .object({
      network: s.string().default('disabled'),
      export: s.string().default('manual'),
      redactSecrets: s.boolean().default(true),
      redactPersonalData: s.boolean().default(true),
    }),
  retention: s
    .object({
      /** 0 (default) = keep evidence forever; otherwise prune older rows at startup. */
      evidenceMaxAgeMs: s.number().default(0),
    }),
  cost: s
    .object({
      /**
       * Optional user-owned price table (spec §8.6): monetary cost is ONLY
       * computed when a matching entry exists; otherwise tokens only.
       * Every entry must record provider, model, currency, effective period
       * and source. Prices are never hardcoded by the plugin.
       */
      priceTable: s
        .array(
          s.object({
            provider: s.string(),
            model: s.string(),
            currency: s.string(),
            pricePerMillionInput: s.number(),
            pricePerMillionOutput: s.number(),
            effectiveFrom: s.number(),
            source: s.string(),
          }),
        )
        .default([]),
    }),
  feedback: s
    .object({
      messageFeedback: s.string().default('optional'),
    }),
  projection: s
    .object({
      enabled: s.boolean().default(true),
    }),
  logging: s
    .object({
      level: s.string().default('info'),
      includeContent: s.boolean().default(false),
    }),
})

export type ConfigType = Schemastery.TypeT<typeof Config>

/** Deterministic config digest — binds evidence freshness and exports. */
export function configDigest(config: ConfigType): string {
  const canonical = JSON.stringify({
    mode: config.mode,
    capture: {
      rawToolArguments: config.capture.rawToolArguments,
      rawToolResults: config.capture.rawToolResults,
      rawMessages: config.capture.rawMessages,
      pathMode: config.capture.pathMode,
      maxExcerptBytes: config.capture.maxExcerptBytes,
    },
    verification: {
      observeExisting: config.verification.observeExisting,
      autoRun: config.verification.autoRun,
      llmJudge: config.verification.llmJudge,
    },
    retention: {
      evidenceMaxAgeMs: config.retention.evidenceMaxAgeMs,
    },
    privacy: {
      network: config.privacy.network,
      export: config.privacy.export,
      redactSecrets: config.privacy.redactSecrets,
      redactPersonalData: config.privacy.redactPersonalData,
    },
  })
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= BigInt(canonical.charCodeAt(i))
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}
