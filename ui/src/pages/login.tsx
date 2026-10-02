import { useEffect } from "react";
import { notifications } from "@mantine/notifications";
import { LoginPage } from "mogh_ui";
import { useUserInvalidate } from "@/lib/hooks";
import {
  consumeRedeemFlag,
  flagFresh,
  MOGH_TOKENS_KEY,
  readRedeemFlag,
} from "@/lib/redeem-gate";

export default function Login(props: {
  passkeyIsPending?: boolean;
  totpIsPending?: boolean;
}) {
  const userInvalidate = useUserInvalidate();

  // One-shot late-success redirect + silent-drop surfacing (spec §7.7 / M2).
  // With no flag this effect is a single sessionStorage read, so every
  // unflagged visit behaves exactly as before.
  //
  // Window APIs only, deliberately — NO useNavigate/useSearchParams:
  // router.tsx renders <Login> for the passkey/totp branch BEFORE
  // <BrowserRouter> mounts, where router-context hooks throw. Reading
  // location.search and redirecting via location.replace mirrors mogh_ui's
  // own maybeNavigate, keeping this path identical to the in-form one.
  useEffect(() => {
    const flag = readRedeemFlag();
    if (!flag) return;
    if (flag.phase === "drop") {
      // Clear-on-read: the M2 message must not replay on later visits.
      consumeRedeemFlag();
      notifications.show({
        title: "Login succeeded but the session could not be stored",
        message: "Please log in again.",
        color: "red",
      });
      return;
    }
    if (!flagFresh(flag)) return; // stale: ignored (§7.3 TTL); lingers harmlessly until tab close
    // jwt presence, decode-free: any entry in the mogh-auth store (§7.3
    // schema). The exchanged jwt itself is not available post-reload —
    // presence plus the fresh flag is the late-success signal; safety rests
    // on the watchdog path having cleared the store before the late success
    // re-stored the token. A corrupt store throws -> caught -> treated as
    // absent -> no redirect.
    let hasJwt = false;
    try {
      const raw = localStorage.getItem(MOGH_TOKENS_KEY);
      const parsed = raw ? JSON.parse(raw) : undefined;
      hasJwt = Array.isArray(parsed?.tokens) && parsed.tokens.length > 0;
    } catch {
      hasJwt = false;
    }
    if (hasJwt) {
      // Consume BEFORE navigating: the next document finds no flag, so the
      // redirect cannot loop — including across StrictMode's double effect.
      consumeRedeemFlag();
      const backto = new URLSearchParams(window.location.search).get("backto");
      window.location.replace(backto ?? "/");
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
