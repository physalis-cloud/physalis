// Pont web → extension navigateur, côté client.
//
// Le content script de l'extension (autofill.ts) n'écoute ces messages QUE sur
// une origine Physalis de confiance, et répond via `window.postMessage` sur la
// même origine. Aucun accès direct à `chrome.runtime` depuis la page.
//
// Sens ALLER (connexion) : cf. app/(dashboard)/sso-extension-handoff.tsx, qui
// pousse une session fraîche. Ce module porte le sens RETOUR (déconnexion).
//
// Tout est best-effort et non bloquant : extension absente, pont muet, réseau
// coupé → la fonction résout quand même. Une déconnexion web qui échouerait
// parce que l'extension ne répond pas serait un remède pire que le mal.

/** Délai au-delà duquel on considère le pont muet. Le content script répond en
 *  quelques ms quand il est là ; ce budget ne sert qu'à ne pas rester pendu
 *  quand il ne l'est pas. */
const BRIDGE_TIMEOUT_MS = 600;

/** Vrai si le content script a posé son marqueur de présence. Absent =
 *  extension pas installée : inutile de payer le timeout. */
function extensionPresent(): boolean {
  return (
    typeof document !== "undefined" &&
    Boolean(document.documentElement.dataset["secretvaultExt"])
  );
}

/** Demande au content script le token plugin de CE navigateur. Résout à null si
 *  l'extension est absente, muette, ou sans session — le cas courant. */
export function readExtensionToken(): Promise<string | null> {
  if (!extensionPresent()) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(value);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const d = event.data as { type?: string; session?: unknown } | null;
      if (!d || d.type !== "PHYSALIS_SESSION") return;
      const s = d.session as { sessionToken?: unknown } | null;
      finish(typeof s?.sessionToken === "string" ? s.sessionToken : null);
    };

    window.addEventListener("message", onMessage);
    window.postMessage({ type: "PHYSALIS_GET_SESSION" }, window.location.origin);
    timer = window.setTimeout(() => finish(null), BRIDGE_TIMEOUT_MS);
  });
}

/** Dit à l'extension d'oublier sa copie locale de la session. Purement
 *  cosmétique — c'est la révocation serveur qui porte la sécurité —, mais sans
 *  ça le popup affiche « connecté » jusqu'au prochain 401. */
export function clearExtensionSession(): void {
  if (!extensionPresent()) return;
  window.postMessage(
    { type: "PHYSALIS_SESSION_CLEAR" },
    window.location.origin,
  );
}

/**
 * Ferme la session extension de ce navigateur : révocation serveur PUIS oubli
 * local. À appeler avant une déconnexion web.
 *
 * L'ordre compte. La révocation est la seule moitié qui vaille pour les
 * versions d'extension déjà installées : elles n'ont pas le listener
 * PHYSALIS_SESSION_CLEAR et se contentent de tomber sur un 401 au prochain
 * appel. L'oubli local n'est qu'un raccourci d'affichage — et le faire d'abord
 * nous priverait du token qu'on doit justement envoyer à révoquer.
 */
export async function closeExtensionSession(): Promise<void> {
  const sessionToken = await readExtensionToken();
  if (!sessionToken) return;

  await fetch("/api/plugin/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionToken }),
  });

  clearExtensionSession();
}
