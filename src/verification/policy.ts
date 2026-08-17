/**
 * Verification policy (spec §11, §12.3): the ONLY place that decides whether
 * an active command may run. Defaults are locked to the safe side:
 * - `autoRun` is false everywhere until a trusted deployment flips it;
 * - project/workspace config can never authorize commands (repo content is
 *   untrusted — spec §11);
 * - cwd must resolve inside the contract scope root;
 * - env is an allowlist; network is never requested by built-in providers.
 */

import { isAbsolute } from 'node:path'

import type { OutcomeResult } from '../domain/errors.ts'
import { err, ok } from '../domain/errors.ts'
import type { TaskContract } from '../domain/types.ts'
import type { ActiveOptions } from './adapters/active.ts'

export interface PolicyContext {
  deploymentAutoRun: boolean
  trustedEnv: Readonly<Record<string, string>>
  verifierVersion: string
}

export type ActiveDecision =
  | { allowed: true; options: ActiveOptions }
  | { allowed: false; code: 'policy-denied' | 'permission-denied'; reason: string }

export function decideActiveRun(
  contract: TaskContract,
  criterionKind: string,
  context: PolicyContext,
): ActiveDecision {
  // All three gates must be open: deployment config, contract policy, scope.
  if (!context.deploymentAutoRun) {
    return { allowed: false, code: 'policy-denied', reason: 'active verification is disabled (verification.autoRun=false)' }
  }
  if (!contract.verificationPolicy.autoRun) {
    return { allowed: false, code: 'policy-denied', reason: 'this contract does not allow active verification' }
  }
  if (!contract.scope.allowActiveVerification) {
    return { allowed: false, code: 'policy-denied', reason: 'the contract scope does not allow active verification' }
  }
  if (contract.verificationPolicy.allowedVerifierIds.length > 0
    && !contract.verificationPolicy.allowedVerifierIds.includes(criterionKind)) {
    return { allowed: false, code: 'policy-denied', reason: `verifier '${criterionKind}' is not on the contract allowlist` }
  }
  if (contract.scope.workspaceRoot === '' || !isAbsolute(contract.scope.workspaceRoot)) {
    return { allowed: false, code: 'permission-denied', reason: 'contract has no usable workspace root' }
  }
  return {
    allowed: true,
    options: {
      cwd: contract.scope.workspaceRoot,
      scopeRoot: contract.scope.workspaceRoot,
      timeoutMs: contract.verificationPolicy.commandTimeoutMs,
      maxOutputBytes: contract.verificationPolicy.maxCommandOutputBytes,
      env: context.trustedEnv,
    },
  }
}

/** Validate scope/path inputs before any fs or exec work (path safety, §14.3). */
export function validateContractInput(contract: TaskContract): OutcomeResult<void> {
  if (contract.scope.workspaceRoot !== '' && !isAbsolute(contract.scope.workspaceRoot)) {
    return err('invalid-input', 'workspaceRoot must be an absolute path')
  }
  return ok(undefined)
}
