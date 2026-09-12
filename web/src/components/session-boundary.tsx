"use client";

import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { clearCsvRecoveryPointers, initialSessionBoundaryState, isSessionLogoutSignal, reduceSessionBoundary, sessionBoundaryVerified,
  SESSION_CHANNEL, SESSION_INVALIDATED_EVENT, SESSION_SIGNAL_KEY, type SessionBoundaryAction, type SessionInvalidationReason } from "./session-boundary-state";

type SessionBoundaryContextValue = { sessionBinding: string; verified: boolean };
const SessionBoundaryContext = createContext<SessionBoundaryContextValue | null>(null);
export const useSessionBoundary = () => useContext(SessionBoundaryContext);
const SessionPortalContext = createContext<{ container: HTMLElement | null; verified: boolean } | null>(null);

export function SessionBoundaryPortal({ children }: { children: (container: HTMLElement | undefined) => ReactNode }) {
  const boundary = useContext(SessionPortalContext);
  if (!boundary) return children(undefined);
  // Passing null to Radix would fall back to document.body outside the concealed subtree.
  if (!boundary.verified || !boundary.container) return null;
  return children(boundary.container);
}

export function SessionBoundary({ initialBinding, children }: { initialBinding: string; children: ReactNode }) {
  const [state, setState] = useState(() => initialSessionBoundaryState(initialBinding));
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(() => null);
  const current = useRef(state), protectedDom = useRef<HTMLDivElement>(null), retry = useRef<() => void>(() => {});
  const verified = sessionBoundaryVerified(state, initialBinding);

  useLayoutEffect(() => {
    const element = protectedDom.current;
    if (!element) return;
    if (portalContainer !== element) setPortalContainer(element);
    const show = verified && current.current.sequence === state.sequence && sessionBoundaryVerified(current.current, initialBinding) && document.visibilityState !== "hidden";
    element.style.visibility = show ? "visible" : "hidden"; element.style.display = show ? "" : "none";
    element.inert = !show; element.setAttribute("aria-hidden", String(!show));
  });

  useEffect(() => {
    let active = true, emittingInvalidation = false, request: AbortController | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    let channel: BroadcastChannel | null = null;
    const seenSignals = new Set<string>();
    const pageHidden = () => document.visibilityState === "hidden";
    const change = (action: SessionBoundaryAction) => { current.current = reduceSessionBoundary(current.current, action); setState(current.current); };
    const conceal = () => {
      const element = protectedDom.current;
      if (element) {
        // React state alone may commit after pagehide/BFCache captures the document.
        element.style.visibility = "hidden"; element.style.display = "none"; element.inert = true; element.setAttribute("aria-hidden", "true");
      }
    };
    const cancel = () => { request?.abort(); request = null; if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const invalidate = (reason: SessionInvalidationReason) => {
      conceal(); cancel(); change({ type: "invalidate", reason });
      for (const name of ["localStorage", "sessionStorage"] as const) {
        try { clearCsvRecoveryPointers(window[name]); } catch { /* Storage access can be denied before reading any key. */ }
      }
      emittingInvalidation = true;
      try { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT, { detail: { reason } })); }
      finally { emittingInvalidation = false; }
    };
    const probe = async (releaseHold = false) => {
      if (!active || current.current.phase === "invalidated") return;
      conceal(); cancel();
      if (pageHidden()) { change({ type: "hide" }); return; }
      change({ type: "check", releaseHold });
      const sequence = current.current.sequence, controller = new AbortController(); request = controller;
      timer = setTimeout(() => controller.abort(), 10000);
      let status = 0, payload: unknown = null;
      try {
        const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", redirect: "error", headers: { Accept: "application/json" }, signal: controller.signal });
        status = response.status;
        if (status === 200) payload = await response.json();
      } catch { status = 0; }
      if (!active || current.current.sequence !== sequence) return;
      if (timer !== undefined) clearTimeout(timer); timer = undefined; request = null;
      if (pageHidden()) { conceal(); change({ type: "hide" }); return; }
      change({ type: "response", sequence, status, payload });
      const reason = current.current.invalidatedReason;
      if (reason) {
        invalidate(reason);
        if (reason === "unauthenticated") window.location.replace("/login");
        else if (reason === "changed") window.location.reload();
      }
    };
    const hide = () => { conceal(); cancel(); change({ type: "hide" }); };
    const onVisibility = () => { if (document.visibilityState === "hidden") hide(); else void probe(); };
    const onPageShow = () => { void probe(); };
    const receiveSignal = (signal: unknown) => {
      if (!isSessionLogoutSignal(signal) || seenSignals.has(signal.nonce)) return;
      if (seenSignals.size >= 100) seenSignals.clear(); seenSignals.add(signal.nonce);
      conceal(); cancel(); change({ type: "signal" }); void probe();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_SIGNAL_KEY || !event.newValue) return;
      try { receiveSignal(JSON.parse(event.newValue)); } catch { /* A malformed signal cannot authorize the page. */ }
    };
    const onSubmit = (event: Event) => {
      if (!(event.target instanceof HTMLFormElement)) return;
      const action = new URL(event.target.action, window.location.href);
      if (action.origin !== window.location.origin || action.pathname !== "/api/auth/logout") return;
      invalidate("logout");
      const signal = { type: "logout", nonce: window.crypto.randomUUID() };
      try { channel?.postMessage(signal); } catch { /* Storage remains a fallback signal channel. */ }
      try { window.localStorage.setItem(SESSION_SIGNAL_KEY, JSON.stringify(signal)); window.localStorage.removeItem(SESSION_SIGNAL_KEY); } catch { /* No payload or credential is persisted. */ }
    };
    const onInvalidated = () => {
      if (emittingInvalidation) return;
      conceal(); cancel();
      change({ type: "signal" }); void probe();
    };
    try { channel = new BroadcastChannel(SESSION_CHANNEL); channel.onmessage = event => receiveSignal(event.data); } catch { /* The storage event fallback is still installed. */ }
    change({ type: "reset", binding: initialBinding });
    window.addEventListener("pagehide", hide); window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("submit", onSubmit, true);
    window.addEventListener("storage", onStorage); window.addEventListener(SESSION_INVALIDATED_EVENT, onInvalidated);
    retry.current = () => { void probe(true); }; void probe();
    return () => {
      active = false; conceal(); cancel(); retry.current = () => {};
      window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility); document.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("storage", onStorage); window.removeEventListener(SESSION_INVALIDATED_EVENT, onInvalidated);
      channel?.close();
    };
  }, [initialBinding]);

  return <SessionBoundaryContext.Provider value={{ sessionBinding: initialBinding, verified }}>
    {!verified && <div role="status" className="p-4 text-sm" data-session-boundary-status={state.phase}>
      {state.phase === "failed" ? "暂时无法复核会话。页面保持隐藏，这不表示您已退出。" : state.phase === "held" ? "已收到其他窗口的退出提醒。页面保持隐藏，请手动重新核对会话。" : state.phase === "invalidated" ? "会话已变化，当前页面已隐藏。" : "正在复核会话，受保护内容暂不显示。"}
      {(state.phase === "failed" || state.phase === "held") && <button type="button" className="ml-3 underline" onClick={() => retry.current()}>重新核对会话</button>}
    </div>}
    <SessionPortalContext.Provider value={{ container: portalContainer, verified }}>
      <div ref={protectedDom} data-session-boundary-content="" inert={!verified} aria-hidden={!verified}
        style={{ visibility: verified ? "visible" : "hidden", display: verified ? undefined : "none" }}>{children}</div>
    </SessionPortalContext.Provider>
  </SessionBoundaryContext.Provider>;
}
