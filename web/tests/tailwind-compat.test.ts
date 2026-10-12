import assert from "node:assert/strict";
import test from "node:test";
import { compatibilityColors, compatibilityShadows } from "../tailwind-compat";

test("CSS engine upgrade retains warning, loss and success colors and existing shadow scales", () => {
  assert.equal(compatibilityColors.amber[500], "#f59e0b");
  assert.equal(compatibilityColors.red[600], "#dc2626");
  assert.equal(compatibilityColors.emerald[600], "#059669");
  assert.equal(compatibilityColors.zinc[950], "#09090b");
  assert.equal(compatibilityShadows.sm, "0 1px 2px 0 rgb(0 0 0 / 0.05)");
});
