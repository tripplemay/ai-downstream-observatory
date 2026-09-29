import { createWorkbenchMixedFixture } from "./workbench-mixed-fixture";

if (process.argv.length !== 3) throw new Error("MIXED_FIXTURE_INPUT_REQUIRED");
const input = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify(createWorkbenchMixedFixture(input)) + "\n");
