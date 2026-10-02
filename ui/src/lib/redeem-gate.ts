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
// Browser fetch has no default timeout — without this bound a black-holing
// proxy would leave the gate "pending" forever.
const WATCHDOG_MS = 12_000;
// "Just over the watchdog": §7.7's redirect accepts only a fresh flag, and the
// settlement-time rewrite restarts the TTL (§7.3), so freshness measures from
// the last confirmed settlement, not the original arm.
const FLAG_TTL_MS = 15_000;
const FLAG_KEY = "komodo-redeem";
// Exported so login.tsx's §7.7 jwt-presence check reads the same key the M2
// check here writes/reads — one source of truth for the mogh storage key.
export const MOGH_TOKENS_KEY = "mogh-auth-tokens-v1"; // mogh_auth_client 1.7.1 tokens.js:5

let state: RedeemState = "idle";
let watchdog: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

// One stable subscribe for both hooks: hoisted to module scope so re-renders
// reuse it instead of re-creating an identical closure on every call.
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

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

// PRE-ARM (spec §7.1 addendum): mogh_ui fires the redeem during ROUTER's
// render — a CHILD of WebsocketProvider, whose gated reads commit
// enabled=true before any child-render flip can exist (React renders
// parent-first). Initializing pending at module scope closes that gap:
// the provider's FIRST render already sees the gate closed. The watchdog
// arms here too, so the window stays bounded even if the real mutation
// never fires (defensive: mogh_ui version drift). Runs at import —
// main.tsx's import guarantees this is before any React render — and the
// later real onMutate flip is idempotent (equality guard; its watchdog
// arm is a no-op because watchdog is already set). Normal loads (no
// redeem_ready param) stay idle, byte-identical to pre-fix behavior.
if (
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("redeem_ready") === "true"
) {
  state = "pending";
  watchdog = setTimeout(() => {
    watchdog = undefined;
    setState("settled-failed");
  }, WATCHDOG_MS);
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
  if (!sessionStorageOk) {
    // Degraded mode (§7.3 + §8's M2 row): this module IS the drop detector, so
    // the drop verdict must still surface — console-only signal, then skip.
    if (phase === "drop") {
      console.error(
        "redeem-gate: exchange 200'd but jwt not stored (M2); sessionStorage unavailable — console-only signal",
      );
    }
    return;
  }
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
    subscribe,
    () => state !== "pending",
    () => true,
  );
}

export function useRedeemState(): RedeemState {
  return useSyncExternalStore(
    subscribe,
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
    // action is a REQUIRED discriminated union (ContinueAction | ErrorAction |
    // … | SuccessAction) — narrow it; the previous `{ type?: string } |
    // undefined` cast claimed action could be absent, which the .d.ts rules out.
    if (event.action.type === "success") {
      // Fires AFTER mogh_ui's onSuccess. M2 check: did storage gain the jwt?
      // action.data is the exact success-dispatch payload (identical to
      // mutation.state.data per mutation.cjs's success reducer).
      const jwt = (event.action.data as { jwt?: string } | undefined)?.jwt;
      let stored = false;
      if (jwt) {
        // §7.3: on parse failure log the RAW stored value, not just the
        // SyntaxError. safe()'s label interpolates it, and a label only prints
        // on failure — the happy path builds a short string it never logs.
        const raw = safe(() => localStorage.getItem(MOGH_TOKENS_KEY), "M2 storage read");
        stored =
          safe(() => {
            const parsed = raw ? (JSON.parse(raw) as { tokens?: Array<{ jwt: string }> }) : undefined;
            return parsed?.tokens?.some((t) => t.jwt === jwt) === true;
          }, `M2 parse (raw: ${raw})`) === true;
      }
      writeFlag(jwt && !stored ? "drop" : "ok"); // refresh t: late-success TTL runs from here
      setState("settled-ok");
    } else if (event.action.type === "error") {
      setState("settled-failed");
    }
  });
}
