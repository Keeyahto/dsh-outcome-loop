/**
 * Replay-verified skill candidates (§21 stage 7 item 5).
 *
 * Derives DISPLAY-ONLY, evidence-counted suggestions from the user's own
 * outcome ledger: which task topics repeat, which acceptance criteria kinds
 * correlate with passing, which patterns fail. Per spec §22, these are
 * candidates for HUMAN review — the plugin never auto-applies rules, never
 * modifies skills, never hardens a single success trajectory into a rule.
 */

import type { TaskContract, VerificationRun } from '../domain/types.ts'

const STOPWORDS = new Set([
  'the', 'and', 'with', 'for', 'from', 'this', 'that', 'using', 'use', 'used', 'make', 'create',
  'provide', 'based', 'via', 'into', 'your', 'our', 'can', 'will', 'does', 'would', 'should',
  'need', 'needs', 'want', 'feature', 'features', 'system', 'also', 'all', 'any', 'are', 'was',
  'were', 'been', 'has', 'have', 'had', 'its', 'their', 'there', 'where', 'which', 'when',
  'what', 'how', 'why', 'but', 'not', 'only', 'just', 'more', 'some', 'such', 'than', 'then',
  'other', 'others', 'fix', 'bug', 'issue', 'task', 'add', 'new', 'implement', 'update',
])

const CJK_RE = /[\u4e00-\u9fff]/g

/** Extract a small deterministic topic set from a goal text. */
export function topicsOf(goalText: string): string[] {
  const out = new Set<string>()
  const cjk = goalText.match(CJK_RE)
  if (cjk !== null && cjk.length >= 2) {
    for (let i = 0; i < cjk.length - 1; i += 1) {
      out.add(`${cjk[i]}${cjk[i + 1]}`)
    }
  }
  for (const word of (goalText.match(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g) ?? [])) {
    const lower = word.toLowerCase()
    if (!STOPWORDS.has(lower)) out.add(lower)
  }
  return [...out].slice(0, 8)
}

export interface ContractTopicRow {
  topic: string
  contracts: number
  passed: number
  failed: number
  inconclusive: number
  criterionKinds: readonly { kind: string; count: number; passedCount: number }[]
  commonFailureNotes: readonly string[]
  totalTokens: number
}

export interface SkillCandidate {
  topic: string
  suggestion: string
  supporting: number
}

export interface SkillsReport {
  generatedAt: number
  contractsConsidered: number
  topics: readonly ContractTopicRow[]
  candidates: readonly SkillCandidate[]
}

const KIND_LABEL: Record<string, string> = {
  'command-exit': 'command-exit 验收',
  'test-report': 'test-report 验收',
  'file-exists': 'file-exists 验收',
  'file-absent': 'file-absent 验收',
  'file-digest': 'file-digest 验收',
  'json-schema': 'json-schema 验收',
  'git-scope': 'git-scope 验收',
  'diagnostic-count': 'diagnostic-count 验收',
  manual: 'manual 验收',
  custom: 'custom 验收',
}

/** Build the report from the user's own ledger (deterministic, local-only). */
export function buildSkillsReport(
  contracts: readonly TaskContract[],
  runOf: (contract: TaskContract) => VerificationRun | undefined,
  tokensOf: (contract: TaskContract) => number,
  now = Date.now(),
): SkillsReport {
  const topicRows = new Map<string, ContractTopicRow>()

  const bump = (topic: string, fn: (row: ContractTopicRow) => void) => {
    const row = topicRows.get(topic) ?? {
      topic,
      contracts: 0,
      passed: 0,
      failed: 0,
      inconclusive: 0,
      criterionKinds: [],
      commonFailureNotes: [],
      totalTokens: 0,
    }
    fn(row)
    topicRows.set(topic, row)
  }

  for (const contract of contracts) {
    const topics = topicsOf(goalText(contract))
    if (topics.length === 0) continue
    const run = runOf(contract)
    const status = run?.status ?? 'not-run'
    const tokens = tokensOf(contract)
    const kindMap = new Map<string, { kind: string; count: number; passedCount: number }>()
    for (const criterion of contract.criteria) {
      const entry = kindMap.get(criterion.kind) ?? { kind: criterion.kind, count: 0, passedCount: 0 }
      entry.count += 1
      const result = run?.results.find((r) => r.criterionId === criterion.id)
      if (result?.status === 'pass') entry.passedCount += 1
      kindMap.set(criterion.kind, entry)
    }
    const failureNotes: string[] = []
    for (const result of run?.results ?? []) {
      if (result.status === 'fail' && result.note !== undefined) failureNotes.push(result.note)
    }
    for (const topic of topics) {
      bump(topic, (row) => {
        row.contracts += 1
        if (status === 'passed') row.passed += 1
        else if (status === 'failed') row.failed += 1
        else row.inconclusive += 1
        row.totalTokens += tokens
        const kinds = [...row.criterionKinds]
        for (const entry of kindMap.values()) {
          const existing = kinds.find((k) => k.kind === entry.kind)
          if (existing !== undefined) {
            existing.count += entry.count
            existing.passedCount += entry.passedCount
          } else {
            kinds.push({ ...entry })
          }
        }
        row.criterionKinds = kinds.sort((a, b) => b.count - a.count)
        const notes = [...row.commonFailureNotes]
        for (const note of failureNotes) {
          if (!notes.includes(note)) notes.push(note)
        }
        row.commonFailureNotes = notes.slice(0, 10)
      })
    }
  }

  const topics = [...topicRows.values()].sort((a, b) => b.contracts - a.contracts || a.topic.localeCompare(b.topic))

  // Candidates: criterion kinds present in EVERY passing contract of a topic
  // with ≥2 contracts — evidence-counted suggestions, never auto-applied.
  const candidates: SkillCandidate[] = []
  for (const topic of topics) {
    if (topic.contracts < 2) continue
    const kindSet = new Map<string, number>()
    let passingContracts = 0
    // Re-walk contracts for this topic to count per-kind usage in passing ones.
    const passingKinds = new Map<string, number>()
    for (const contract of contracts) {
      if (!topicsOf(goalText(contract)).includes(topic.topic)) continue
      const run = runOf(contract)
      if (run?.status !== 'passed') continue
      passingContracts += 1
      for (const kind of new Set(contract.criteria.map((c) => c.kind))) {
        passingKinds.set(kind, (passingKinds.get(kind) ?? 0) + 1)
      }
    }
    for (const [kind, count] of passingKinds) {
      if (passingContracts >= 2 && count === passingContracts) {
        kindSet.set(kind, count)
      }
    }
    for (const [kind, count] of kindSet) {
      candidates.push({
        topic: topic.topic,
        suggestion: `对包含主题「${topic.topic}」的任务，${count}/${passingContracts} 个通过契约都带有${KIND_LABEL[kind] ?? kind} —— 建议人工评估是否加入 skill 模板`,
        supporting: count,
      })
    }
  }

  return { generatedAt: now, contractsConsidered: contracts.length, topics, candidates }
}

function goalText(contract: TaskContract): string {
  return contract.goal.kind === 'explicit' ? contract.goal.text : ''
}
