import "server-only";
import { requireSession } from "@/server/auth/session";
import * as legacy from "./legacy-queries";

export type * from "./legacy-queries";

function authorized<A extends unknown[], T>(query: (...args: A) => T) {
  return async (...args: A): Promise<T> => {
    await requireSession();
    return query(...args);
  };
}

export const getThemes = authorized(legacy.getThemes);
export const getTheme = authorized(legacy.getTheme);
export const getSignals = authorized(legacy.getSignals);
export const getSignalGroups = authorized(legacy.getSignalGroups);
export const getOverview = authorized(legacy.getOverview);
export const getObservations = authorized(legacy.getObservations);
export const getLastObservation = authorized(legacy.getLastObservation);
export const getStatusCounts = authorized(legacy.getStatusCounts);
export const getPool = authorized(legacy.getPool);
export const getPages = authorized(legacy.getPages);
export const getReports = authorized(legacy.getReports);
export const getReport = authorized(legacy.getReport);
export const getLastReport = authorized(legacy.getLastReport);
export const getMetricGroups = authorized(legacy.getMetricGroups);
export const getSeries = authorized(legacy.getSeries);
export const getScissorData = authorized(legacy.getScissorData);
export const getStrengthData = authorized(legacy.getStrengthData);
export const lastJobStatus = authorized(legacy.lastJobStatus);
export const getAdviceCurrent = authorized(legacy.getAdviceCurrent);
export const getAdviceHistory = authorized(legacy.getAdviceHistory);
export const getUniverseMonitor = authorized(legacy.getUniverseMonitor);
export const getAdviceNavSeries = authorized(legacy.getAdviceNavSeries);
export const getStrategyParams = authorized(legacy.getStrategyParams);
export const getStrategyParamsHistory = authorized(legacy.getStrategyParamsHistory);
export const getNavCompareFull = authorized(legacy.getNavCompareFull);
export const getMarketWidth = authorized(legacy.getMarketWidth);
export const getPaperAccount = authorized(legacy.getPaperAccount);
export const getPaperPositions = authorized(legacy.getPaperPositions);
export const getPaperTrades = authorized(legacy.getPaperTrades);
export const getPaperNavSeries = authorized(legacy.getPaperNavSeries);
