import assert from "node:assert/strict";
import test from "node:test";
import * as schemas from "../src/server/investor/monitor-cost-schemas";
import { mountInvestorDisplay } from "./investor-display-fixture";

const now = "2026-01-02T12:00:00.000Z", expiry = "2027-01-01T00:00:00.000Z";
const empty: schemas.MonitorCostState = { model_id: "fictional-model", model_hash: "a".repeat(64), status: "unknown", version: 0,
  costs: null, effective_from: null, valid_until: null, model_valid_until: expiry, input_applied: false, editable: true,
  basis: "owner_research_assumptions_not_verified_broker_tariff", trading_permission: false };
const values = { commission_bps: "1", minimum_fee_cny: "2", fx_bps: "3", slippage_bps: "4", maximum_cost_fraction: "0.01" };
function mount(t: { after(fn: () => void): void }, state = empty, disabled = false, nowMs = Date.parse(now)) {
  const commands: unknown[] = [], locks: boolean[] = [];
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-monitor-cost-panel.tsx", import.meta.url), "InvestorMonitorCostPanel",
    { state, disabled, nowMs, onCommand: (value: unknown) => commands.push(value), onEditingChange: (value: boolean) => locks.push(value) },
    { "@/components/ui/input": { Input: "Input" }, "@/server/investor/monitor-cost-schemas": schemas }, nowMs,
    { FormData: class { constructor(private form: Record<string, string>) {} get(key: string) { return this.form[key] ?? null; } } });
  return { ...h, commands, locks, submit: async (form: Record<string, string>) => {
    let prevented = false;
    (h.node("form")!.props.onSubmit as (event: unknown) => void)({ currentTarget: form, preventDefault() { prevented = true; } });
    await h.flush(); assert.equal(prevented, true);
  } };
}
test("first-use fee form has no numeric/validity default and rejects incomplete or unacknowledged assumptions without a command", async t => {
  const h = mount(t); await h.flush(); assert.equal(h.requests.length, 0); assert.equal(h.commands.length, 0);
  await h.click("确认监测费用假设");
  assert.ok(h.nodes().filter(node => node.type === "Input").every(node => node.props.defaultValue === ""));
  assert.equal(h.node("select")!.props.defaultValue, "");
  for (const form of [{}, { ...values, validity_days: "30" }, { ...values, validity_days: "30", acknowledged: "on", fx_bps: "1e3" }]) {
    await h.submit(form); assert.equal(h.commands.length, 0); assert.match(h.text(), /请逐项填写/);
  }
  assert.equal(h.locks.at(-1), true);
  await h.click("取消编辑"); assert.equal(h.locks.at(-1), false); assert.equal(h.commands.length, 0);
});
test("explicit form emits exact research-only values/context; no implicit save or automatic expiry renewal", async t => {
  const h = mount(t); await h.flush(); await h.click("确认监测费用假设");
  await h.submit({ ...values, validity_days: "30", acknowledged: "on" });
  assert.deepEqual(JSON.parse(JSON.stringify(h.commands)), [{ action: "set_monitor_costs", model_id: empty.model_id, model_hash: empty.model_hash,
    expected_cost_version: 0, costs: values, validity_days: 30, acknowledged_research_only: true }]);
  assert.equal(h.locks.at(-1), false); assert.equal(h.requests.length, 0);
  const known: schemas.MonitorCostState = { ...empty, status: "known", version: 1, costs: { ...values, assumption_hash: "b".repeat(64) },
    effective_from: now, valid_until: "2026-01-03T12:00:00.000Z", input_applied: true };
  const expired = mount(t, known, false, Date.parse(known.valid_until!)); await expired.flush();
  assert.match(expired.text(), /已到期，不自动续期/); assert.equal(expired.commands.length, 0);
  await expired.click("修改监测费用假设"); assert.equal(expired.node("select")!.props.defaultValue, "");
  await expired.click("明确恢复为未知成本");
  assert.deepEqual(JSON.parse(JSON.stringify(expired.commands)), [{ action: "set_monitor_costs", model_id: known.model_id, model_hash: known.model_hash,
    expected_cost_version: 1, costs: null, validity_days: null, acknowledged_research_only: true }]);
});
test("read-only/context/model expiry prevents submission even if a crafted form handler is invoked", async t => {
  const h = mount(t); await h.flush(); await h.click("确认监测费用假设");
  for (const changes of [{ disabled: true }, { disabled: false, state: { ...empty, editable: false } },
    { state: empty, nowMs: Date.parse(expiry) }]) {
    await h.change(changes); await h.submit({ ...values, validity_days: "30", acknowledged: "on" });
    assert.equal(h.commands.length, 0); assert.equal(h.requests.length, 0);
  }
});
