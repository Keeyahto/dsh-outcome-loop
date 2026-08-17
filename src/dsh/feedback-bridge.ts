/**
 * Feedback bridge (spec §8.5): task outcome and message ratings are different
 * concepts. We only ever reference feedback — digest, seq, message id, rating
 * counts — never the note text. The optional message-feedback service is
 * probed at runtime; its absence never degrades core verification.
 */

import type { SessionFactLog } from '../domain/types.ts'
import { contentHash } from '../domain/ids.ts'

export interface FeedbackSummary {
  /** feedback/record events observed (count + last digest). */
  recordCount: number
  lastTextDigest?: string
  lastSeq?: number
  /** Optional message-feedback service signal (counts only). */
  messageFeedbackCount: number
  positiveRatings: number
  negativeRatings: number
}

export function feedbackFromFacts(log: SessionFactLog | undefined): FeedbackSummary {
  const summary: FeedbackSummary = { recordCount: 0, messageFeedbackCount: 0, positiveRatings: 0, negativeRatings: 0 }
  if (log === undefined) return summary
  for (const fact of log.facts) {
    if (fact.kind !== 'feedback') continue
    summary.recordCount += 1
    summary.lastTextDigest = fact.textDigest
    summary.lastSeq = fact.seq
  }
  return summary
}

export function digestOf(text: string): string {
  return contentHash(text)
}

export interface MessageFeedbackBridge {
  /** Optional: count ratings for one session via ctx.messageFeedback.list. */
  listRatings(sessionId: string): Promise<{ count: number; positive: number; negative: number }>
}

export function createMessageFeedbackBridge(
  service: { list(request: { sessionId: string }): Promise<unknown> } | undefined,
): MessageFeedbackBridge {
  return {
    async listRatings(sessionId) {
      if (service === undefined) return { count: 0, positive: 0, negative: 0 }
      try {
        const result = await service.list({ sessionId })
        const value = result as { ok?: boolean; value?: { items?: readonly { rating?: string }[] } }
        if (value?.ok !== true || value.value?.items === undefined) return { count: 0, positive: 0, negative: 0 }
        const items = value.value.items
        return {
          count: items.length,
          positive: items.filter((i) => i.rating === 'positive').length,
          negative: items.filter((i) => i.rating === 'negative').length,
        }
      } catch {
        return { count: 0, positive: 0, negative: 0 }
      }
    },
  }
}
