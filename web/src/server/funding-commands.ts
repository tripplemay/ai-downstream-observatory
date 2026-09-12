import type Database from "better-sqlite3";
import { z } from "zod";
import { deferFundingTranche, linkFundingExecution, linkFundingReceipt, publishFundingPlanVersion, unlinkFundingExecution, unlinkFundingReceipt, type FundingActor, type FundingOptions } from "./funding/service";

const schema = z.object({ operation: z.enum(["publish_plan", "defer_tranche", "link_receipt", "unlink_receipt", "link_execution", "unlink_execution"]), command: z.unknown() }).strict();
const commands = { publish_plan: publishFundingPlanVersion, defer_tranche: deferFundingTranche, link_receipt: linkFundingReceipt, unlink_receipt: unlinkFundingReceipt, link_execution: linkFundingExecution, unlink_execution: unlinkFundingExecution };
export function executeFundingCommand(db: Database.Database, actor: FundingActor, raw: unknown, options: FundingOptions = {}) {
  const input = schema.parse(raw);
  return commands[input.operation](db, actor, input.command, options);
}
