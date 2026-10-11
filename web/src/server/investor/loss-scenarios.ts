export const LOSS_LEVELS = [10, 20, 30, 40, 50] as const;

function cents(value: string | null): bigint | null {
  if (value === null || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
function money(value: bigint) {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

export function illustrateLossScenarios(budget: string | null) {
  const amount = cents(budget);
  return LOSS_LEVELS.map(loss_percent => {
    const loss = amount === null ? null : (amount * BigInt(loss_percent) + 50n) / 100n;
    return { loss_percent, recovery_gain_percent: (loss_percent / (100 - loss_percent) * 100).toFixed(1),
      loss_cny: loss === null ? null : money(loss),
      remaining_cny: amount === null || loss === null ? null : money(amount - loss) };
  });
}
