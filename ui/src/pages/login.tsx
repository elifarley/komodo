import { useEffect } from "react";
import { notifications } from "@mantine/notifications";
import { LoginPage } from "mogh_ui";
import { useUserInvalidate } from "@/lib/hooks";
import {
  consumeRedeemFlag,
  flagFresh,
  hasStoredJwt,
  readRedeemFlag,
} from "@/lib/redeem-gate";

// Origin guard for the late-success redirect target (round-8 C-001). backto
// survives mogh_ui's post-exchange sanitize (utils.js strips only
// redeem_ready|totp|passkey), so a crafted link —
// /login?backto=//evil.example&redeem_ready=true — would otherwise navigate
// off-origin immediately after the victim logs in. Accept ONLY a local path:
// "/" exactly, or "/" followed by a character that is neither "/"
// (protocol-relative //host) nor "\" (WHATWG URL parsing folds "\" to "/" for
// special schemes, so /\evil.example is protocol-relative too; the parser is
// the spec, not a browser quirk), and NO control character anywhere — the
// parser strips tabs/newlines BEFORE parsing, so "/\t/evil.example" would
// weld into "//evil.example" (protocol-relative) only AFTER this guard has
// approved it; control chars never belong in a local path. Anything else —
// absolute URLs, empty, null — falls back to "/". Query strings on an
// accepted path are fine: they stay on this origin, and a percent-encoded
// "%2F%2F" stays a literal on-origin path segment (URLSearchParams already
// decoded the one layer that mattered).
function safeLocalPath(raw: string | null): string {
  // typeof guard FIRST: `raw === "/"` being false does not exclude null, so
  // without it null flows into the regex call (tsc caught exactly that).
  return (
    typeof raw === "string" &&
    !/[\x00-\x1f\x7f]/.test(raw) &&
    (raw === "/" || /^\/[^/\\]/.test(raw))
  )
    ? raw
    : "/";
}

export default function Login(props: {
  passkeyIsPending?: boolean;
  totpIsPending?: boolean;
}) {
  const userInvalidate = useUserInvalidate();

  // One-shot late-success redirect + silent-drop surfacing.
  // With no flag this effect is a single sessionStorage read, so every
  // unflagged visit behaves exactly as before.
  //
  // Window APIs only, deliberately — NO useNavigate/useSearchParams:
  // router.tsx renders <Login> for the passkey/totp branch BEFORE
  // <BrowserRouter> mounts, where router-context hooks throw. Reading
  // location.search and redirecting via location.replace mirrors mogh_ui's
  // own maybeNavigate — but the target guard below deliberately DIVERGES:
  // mogh_ui's maybeNavigate replaces whatever backto carries (upstream draft
  // (f) in compose/oidc-dev/BASELINE.md), and this PR must not add another
  // unguarded call site of a flaw it documents.
  useEffect(() => {
    const flag = readRedeemFlag();
    if (!flag) return;
    if (flag.phase === "drop") {
      // Clear-on-read: the silent-drop message must not replay on later visits.
      consumeRedeemFlag();
      notifications.show({
        title: "Login succeeded but the session could not be stored",
        message: "Please log in again.",
        color: "red",
        // Mantine defaults to autoClose: 4000 — a silent-failure notice that
        // vanishes by ~T+5s would defeat the silent-drop goal (non-silence) and
        // race verify.mjs's fix-dependent probe (~T+8s). Must-act toasts stay.
        autoClose: false,
      });
      return;
    }
    if (!flagFresh(flag)) return; // stale: ignored (TTL expiry); lingers harmlessly until tab close
    // jwt presence, decode-free, via THE parser for the mogh store
    // (redeem-gate.readMoghStore — one parse, shared with the silent-drop
    // check; a second independent parser here is how two copies drift).
    // The exchanged jwt itself is not available post-reload — presence plus
    // the fresh flag is the late-success signal. The fresh "ok" flag is only
    // ever written when the exchange 200'd (cache onSuccess), and a silent
    // drop overwrites it to "drop" in the same dispatch task — so a fresh ok
    // flag certifies the exchanged token itself landed, and the redirect
    // never depended on failure-path store clearing (round-8 C-003 removed
    // it). Absent/corrupt store -> false -> no redirect.
    if (hasStoredJwt()) {
      // Consume BEFORE navigating: the next document finds no flag, so the
      // redirect cannot loop — including across StrictMode's double effect.
      consumeRedeemFlag();
      const backto = new URLSearchParams(window.location.search).get("backto");
      window.location.replace(safeLocalPath(backto));
    }
  }, []);

  return (
    <LoginPage
      {...props}
      appName="KOMODO"
      iconLink="/mogh-512x512.png"
      iconLinkAlt="moghtech"
      exampleConfigLink="https://github.com/moghtech/komodo/blob/main/config/core.config.toml"
      onLogin={userInvalidate}
    />
  );
}
