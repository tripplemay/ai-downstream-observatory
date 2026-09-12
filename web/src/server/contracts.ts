import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import common from "../../../contracts/v1/common.schema.json";
import fact from "../../../contracts/v1/ledger-fact.schema.json";
import command from "../../../contracts/v1/ledger-command.schema.json";
import securityValue from "../../../contracts/v1/security-transfer-value.schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
ajv.addSchema(common);
ajv.addSchema(securityValue);
ajv.addSchema(fact);
const validateLedgerCommand = ajv.compile(command);

export function assertLedgerCommand(value: unknown): void {
  if (!validateLedgerCommand(value)) {
    const fields = validateLedgerCommand.errors?.map(e => `${e.instancePath || "/"}: ${e.message}`).join("; ");
    throw new Error(`VALIDATION_FAILED: ${fields}`);
  }
}
