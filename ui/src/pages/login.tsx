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
  // own maybeNavigate, keeping this path identical to the in-form one.
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
    // The exchanged jwt itself is not available post-reload —
    // presence plus the fresh flag is the late-success signal; safety rests
    // on the watchdog path having cleared the store before the late success
    // re-stored the token. Absent/corrupt store -> false -> no redirect.
    if (hasStoredJwt()) {
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
