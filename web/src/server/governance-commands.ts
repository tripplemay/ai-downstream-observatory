import type Database from "better-sqlite3";
import { z } from "zod";
import { hash } from "./ledger/service";
import { executionFactSchema } from "./governance/schemas";
import {
  activatePolicy, approveAccountCapability, approveProposal, cancelRemainder,
  createPolicyVersion, createProposal, createStrategyVersion, expireProposal,
  prepareExecution, recordExecutionFact, recordExecutionReport, runRiskCheck,
  type GovernanceActor, type GovernanceOptions,
} from "./governance/service";

export const governanceCommandSchema = z.object({
  operation: z.enum([
    "create_policy", "create_strategy", "approve_capability", "activate_policy",
    "create_proposal", "risk_check", "approve_proposal", "prepare_execution",
    "cancel_remainder", "expire_proposal", "record_execution_report", "record_execution_fact",
  ]),
  command: z.unknown(),
}).strict();

const handlers = {
  create_policy: createPolicyVersion, create_strategy: createStrategyVersion,
  approve_capability: approveAccountCapability, activate_policy: activatePolicy,
  create_proposal: createProposal, risk_check: runRiskCheck, approve_proposal: approveProposal,
  prepare_execution: prepareExecution, cancel_remainder: cancelRemainder,
  expire_proposal: expireProposal, record_execution_report: recordExecutionReport,
  record_execution_fact: recordExecutionFact,
};

export function executeGovernanceCommand(db: Database.Database, actor: GovernanceActor, raw: unknown, options: GovernanceOptions = {}) {
  const input = governanceCommandSchema.parse(raw);
  if (input.operation === "record_execution_fact") {
    const command = executionFactSchema.parse(input.command);
    const nested = z.record(z.unknown()).parse(command.command);
    for (const key of ["portfolio_id", "expected_revision"] as const) {
      if (key in nested && nested[key] !== command[key]) throw new Error("EXECUTION_FACT_OUT_OF_SCOPE");
    }
    const ledgerCommand = {
      ...nested, portfolio_id: command.portfolio_id, expected_revision: command.expected_revision,
      idempotency_key: nested.idempotency_key ?? `execution:${hash({ portfolio_id: command.portfolio_id, key: command.idempotency_key })}`,
      reason: nested.reason ?? command.reason,
    };
    return recordExecutionFact(db, actor, { ...command, command: ledgerCommand }, options);
  }
  return handlers[input.operation](db, actor, input.command, options);
}
