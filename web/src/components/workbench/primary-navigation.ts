export const INVESTOR_NAVIGATION = [
  { href: "/workbench", label: "总览" },
  { href: "/workbench/plan", label: "组合方案" },
  { href: "/workbench/observations", label: "观察记录" },
  { href: "/workbench/accounts", label: "账户资料" },
] as const;

export const ADVANCED_NAVIGATION = [
  { href: "/workbench/ledger", label: "高级账本与对账" },
  { href: "/workbench/funding", label: "资金计划与投入批次" },
  { href: "/workbench/catalog", label: "ETF 标的与持仓比较" },
  { href: "/workbench/market", label: "市场资料与价格采集" },
  { href: "/workbench/price-schedules", label: "每日价格采集计划" },
  { href: "/workbench/research", label: "策略研究与 AI 运营" },
  { href: "/workbench/governance", label: "政策与执行审批" },
  { href: "/workbench/evaluations", label: "账户级策略评估" },
  { href: "/workbench/verifications", label: "受控工程子检查" },
  { href: "/legacy", label: "历史研究档案" },
] as const;
