import { useSyncExternalStore } from "react";
import type { MutationCacheConfig, QueryClient } from "@tanstack/react-query";
import { MoghAuth } from "komodo_client";

// Redeem lifecycle (spec §7.1). "idle" means OPEN everywhere: only a document
// that itself arms the redeem mutation can leave idle, so every gate keyed on
// `!== "pending"` behaves exactly like today on normal page loads.
// Delivery fact (spec §4): cache listeners run synchronously inside the
// dispatch's task — a render-phase dispatch notifies zero effect-scoped
// subscribers, deterministically. Arming uses the config hooks, which run
// inside execute regardless.
export type RedeemState = "idle" | "pending" | "settled-ok" | "settled-failed";

const REDEEM_KEY = "ExchangeForJwt";
const WATCHDOG_MS = 12_000;
const FLAG_TTL_MS = 15_000;
const FLAG_KEY = "komodo-redeem";
const TOKENS_KEY = "mogh-auth-tokens-v1"; // mogh_auth_client 1.7.1 tokens.js:5

let state: RedeemState = "idle";
let watchdog: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

// mutationKey is `readonly unknown[]` (query-core MutationKey) — readonly is
// load-bearing: a mutable `unknown[]` here fails structural assignability.
const isExchange = (m: { options?: { mutationKey?: readonly unknown[] } } | undefined) =>
  m?.options?.mutationKey?.[0] === REDEEM_KEY;

function setState(next: RedeemState) {
  if (state === next) return;
  if (next === "settled-failed") {
    // Hygiene runs HERE — synchronously, before the flip can trigger any
    // React render. Doing this in Router's effect would run after the parent
    // provider's flip render, whose hasJwt would still read stale-true, and
    // one stale-token request would escape after settlement.
    safe(() => MoghAuth.LOGIN_TOKENS.remove_all(), "remove_all");
  }
  state = next;
  if (state !== "pending" && watchdog !== undefined) {
    clearTimeout(watchdog);
    watchdog = undefined;
  }
  listeners.forEach((l) => l());
}

// Exception-free helper: mutation.cjs awaits config onSuccess BEFORE mogh_ui's
// token write with no per-hook guard (only the error-path hooks are wrapped) —
// a throw here converts a 200 exchange into the failure path (manufactured M2).
function safe<T>(fn: () => T, label: string): T | undefined {
  try {
    return fn();
  } catch (e) {
    console.error(`redeem-gate: ${label} failed (ignored)`, e);
    return undefined;
  }
}

const sessionStorageOk =
  typeof window !== "undefined" &&
  safe(() => {
    const k = `${FLAG_KEY}-probe`;
    window.sessionStorage.setItem(k, "1");
    window.sessionStorage.removeItem(k);
    return true;
  }, "sessionStorage probe") === true;

// Single evidence flag (spec §7.3): never carries the raw jwt.
type RedeemFlag = { t: number; phase: "ok" | "drop" };

function writeFlag(phase: RedeemFlag["phase"]) {
  if (!sessionStorageOk) return;
  safe(
    () => window.sessionStorage.setItem(FLAG_KEY, JSON.stringify({ t: Date.now(), phase })),
    "flag write",
  );
}

export function readRedeemFlag(): RedeemFlag | undefined {
  if (!sessionStorageOk) return undefined;
  return safe(() => {
    const raw = window.sessionStorage.getItem(FLAG_KEY);
    return raw ? (JSON.parse(raw) as RedeemFlag) : undefined;
  }, "flag read");
}

export function consumeRedeemFlag() {
  if (!sessionStorageOk) return;
  safe(() => window.sessionStorage.removeItem(FLAG_KEY), "flag clear");
}

export function flagFresh(flag: RedeemFlag | undefined): boolean {
  return !!flag && flag.phase === "ok" && Date.now() - flag.t < FLAG_TTL_MS;
}

/** True unless a redeem mutation is in flight. The one gate predicate. */
export function useRedeemGateOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state !== "pending",
    () => true,
  );
}

export function useRedeemState(): RedeemState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => "idle" as RedeemState,
  );
}

/** Cache-config hooks: synchronous inside execute, before mogh_ui's handlers. */
export function createRedeemGateHooks(): MutationCacheConfig {
  return {
    onMutate: (_variables, mutation) => {
      if (!isExchange(mutation)) return;
      setState("pending");
      safe(() => {
        if (watchdog === undefined) {
          watchdog = setTimeout(() => {
            watchdog = undefined;
            // Fail-safe convergence; a late success still recovers via
            // mogh_ui's own handler + the login-page redirect (§7.7).
            setState("settled-failed");
          }, WATCHDOG_MS);
        }
      }, "watchdog arm");
    },
    onSuccess: (_data, _variables, _context, mutation) => {
      if (!isExchange(mutation)) return;
      // Pre-navigation evidence: exchange 200'd; mogh_ui's write+reload next.
      writeFlag("ok");
    },
  };
}

/** Settlement subscription; lives for the page's lifetime. */
export function initRedeemGate(client: QueryClient) {
  client.getMutationCache().subscribe((event) => {
    if (event.type !== "updated" || !isExchange(event.mutation)) return;
    const action = (event.action as { type?: string } | undefined)?.type;
    if (action === "success") {
      // Fires AFTER mogh_ui's onSuccess. M2 check: did storage gain the jwt?
      const jwt = (event.mutation.state.data as { jwt?: string } | undefined)?.jwt;
      let stored = false;
      if (jwt) {
        stored =
          safe(() => {
            const raw = localStorage.getItem(TOKENS_KEY);
            const parsed = raw ? (JSON.parse(raw) as { tokens?: Array<{ jwt: string }> }) : undefined;
            return parsed?.tokens?.some((t) => t.jwt === jwt) === true;
          }, "M2 storage read") === true;
      }
      writeFlag(jwt && !stored ? "drop" : "ok"); // refresh t: late-success TTL runs from here
      setState("settled-ok");
    } else if (action === "error") {
      setState("settled-failed");
    }
  });
}
