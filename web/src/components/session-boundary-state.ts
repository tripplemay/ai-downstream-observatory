export const SESSION_INVALIDATED_EVENT = "workbench:session-invalidated";
export const SESSION_SIGNAL_KEY = "workbench:session-signal";
export const SESSION_CHANNEL = "workbench-session";
export const CSV_RECOVERY_POINTER_PREFIX = "workbench:csv-recovery:";

export type SessionInvalidationReason = "unauthenticated" | "changed" | "logout";
export type SessionBoundaryState = {
  binding: string;
  sequence: number;
  phase: "hidden" | "checking" | "verified" | "failed" | "held" | "invalidated";
  hold: boolean;
  invalidatedReason: SessionInvalidationReason | null;
};
export type SessionBoundaryAction =
  | { type: "reset"; binding: string }
  | { type: "hide" | "signal" }
  | { type: "check"; releaseHold?: boolean }
  | { type: "invalidate"; reason: SessionInvalidationReason }
  | { type: "response"; sequence: number; status: number; payload: unknown };

export function initialSessionBoundaryState(binding: string): SessionBoundaryState {
  return { binding, sequence: 0, phase: "hidden", hold: false, invalidatedReason: null };
}

function responseBinding(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  return Object.keys(value).length === 2 && value.authenticated === true && typeof value.session_binding === "string"
    && /^[a-f0-9]{64}$/.test(value.session_binding) ? value.session_binding : null;
}

export function reduceSessionBoundary(state: SessionBoundaryState, action: SessionBoundaryAction): SessionBoundaryState {
  if (action.type === "reset") return { ...initialSessionBoundaryState(action.binding), sequence: state.sequence + 1 };
  if (action.type === "invalidate") return { ...state, sequence: state.sequence + 1, phase: "invalidated", invalidatedReason: action.reason };
  if (state.phase === "invalidated") return state;
  if (action.type === "hide" || action.type === "signal") return { ...state, sequence: state.sequence + 1, phase: "hidden", hold: state.hold || action.type === "signal" };
  if (action.type === "check") return { ...state, sequence: state.sequence + 1, phase: "checking", hold: action.releaseHold ? false : state.hold };
  if (action.type !== "response" || action.sequence !== state.sequence || state.phase !== "checking") return state;
  if (action.status === 401) return { ...state, phase: "invalidated", invalidatedReason: "unauthenticated" };
  const binding = action.status === 200 ? responseBinding(action.payload) : null;
  if (binding === null) return { ...state, phase: "failed" };
  if (binding !== state.binding) return { ...state, phase: "invalidated", invalidatedReason: "changed" };
  return { ...state, phase: state.hold ? "held" : "verified" };
}

export function sessionBoundaryVerified(state: SessionBoundaryState, initialBinding: string): boolean {
  return state.phase === "verified" && state.binding === initialBinding;
}

type PointerStorage = Pick<Storage, "length" | "key" | "removeItem">;
export function clearCsvRecoveryPointers(storage: PointerStorage): number {
  let removed = 0;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(CSV_RECOVERY_POINTER_PREFIX)) keys.push(key);
    }
    for (const key of keys) { storage.removeItem(key); removed++; }
  } catch { /* Browser storage may be disabled. This never makes the session valid. */ }
  return removed;
}

export function isSessionLogoutSignal(value: unknown): value is { type: "logout"; nonce: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && record.type === "logout" && typeof record.nonce === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(record.nonce);
}
