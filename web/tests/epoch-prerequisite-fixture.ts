import { after } from "node:test";
import { investorFixture } from "./investor-fixture";
import { actionPython } from "./action-maintenance-fixture";
import { FictionalPrerequisite } from "./fictional-prerequisite-fixture";

let prerequisite: FictionalPrerequisite | null = null;
after(() => { prerequisite?.close(); prerequisite = null; });

export function epochPrerequisiteFixture() {
  const seedDeadline = performance.now() + 120000;
  if (prerequisite) {
    const f = prerequisite.instantiate();
    return { ...f, saved: f.value, seedDeadline };
  }
  const f = investorFixture();
  try {
    const saved = actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.epoch_continuation_source_fixture import create
from worker.market import contracts
with offline_protocol_fixture():
 saved=create(db,Path(sys.argv[1]))
assert contracts._VALIDATION_SCOPE.get() is None
print(json.dumps(saved))
`, "core_readmission", seedDeadline);
    prerequisite = FictionalPrerequisite.capture(f, saved);
    return { ...f, saved, seedDeadline };
  } catch (error) { f.close(); throw error; }
}

// The first construction and its caller's original preparation share 120 seconds.
export function epochPrerequisitePython(f: ReturnType<typeof epochPrerequisiteFixture>, code: string, budget: "core_readmission") {
  return actionPython(f.filename, code, budget, f.seedDeadline);
}

export function epochPrerequisiteValue(f: ReturnType<typeof epochPrerequisiteFixture>) {
  return `json.loads(${JSON.stringify(JSON.stringify(f.saved))})`;
}
