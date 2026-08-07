"use client";

import { useState } from "react";
import { closeExtensionSession } from "@/lib/extension-bridge";

// Bouton de déconnexion — miroir du hand-off web → extension.
//
// `SsoExtensionHandoff` propage la CONNEXION : charger le dashboard émet un
// PluginToken et le pousse dans l'extension, sans que l'utilisateur ait rien
// demandé. La déconnexion doit donc propager dans l'autre sens, sinon le
// contrat est asymétrique : on n'a jamais connecté l'extension consciemment,
// mais il faudrait penser à l'en déconnecter à la main.
//
// On ferme donc la session extension (cf. lib/extension-bridge.ts) AVANT de
// laisser partir le `signOut` serveur — la page se décharge à la soumission,
// il n'y aurait plus personne pour émettre le postMessage après.
export default function LogoutButton({
  action,
  label,
  className = "btn btn-ghost btn-sm",
}: {
  /** Server action de déconnexion, passée par le layout appelant. On la garde
   *  côté serveur plutôt que d'appeler `signOut` de next-auth/react : c'est
   *  elle qui déclenche l'événement d'audit LOGOUT (cf. lib/auth.ts). */
  action: () => Promise<void>;
  label: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);

  // On intercepte la soumission pour glisser le nettoyage AVANT la
  // déconnexion, puis on invoque le server action DIRECTEMENT.
  //
  // Volontairement pas de `form.requestSubmit()` pour relancer la soumission :
  // il faudrait alors que React laisse filer ce second événement après un
  // premier `preventDefault`, et si l'hypothèse tombe un jour, le bouton ne
  // déconnecte plus — en silence. Un appel direct ne dépend d'aucune subtilité
  // de dispatch.
  //
  // Le `<form action>` reste en place et garde tout son sens : sans JS,
  // `onSubmit` ne s'exécute pas et le POST natif déconnecte quand même (sans
  // fermer la session extension). La dégradation va dans le bon sens.
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);

    void (async () => {
      try {
        await closeExtensionSession();
      } catch {
        // best-effort : la déconnexion web prime sur le sort de l'extension.
      }
      await action();
    })();
  }

  return (
    <form action={action} onSubmit={onSubmit}>
      <button type="submit" className={className} disabled={busy}>
        {label}
      </button>
    </form>
  );
}
