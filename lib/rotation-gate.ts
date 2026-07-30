// §2.24c — gate d'org de la rotation, au CHOKEPOINT (rotators), pas dans chaque route.
//
// Le gate — feature rotation activée au niveau ORG (`organization.rotationFeatureEnabled`)
// ET projet non mis en pause (`project.rotationPaused=false`) — n'existait que dans le
// chemin cron (`projectGate`) et le PATCH settings. Les routes « Forcer » appelaient
// `triggerRotation` / les rotators app-account directement → un EDITOR projet pouvait
// écraser la décision d'un admin org (y compris un `ALTER ROLE` synchrone sur une base
// de prod). On pose le gate dans les rotators ; les routes force mappent l'erreur en 403.

/** Levée par les rotators quand la rotation est désactivée au niveau org/projet. */
export class RotationDisabledError extends Error {
  constructor() {
    super(
      "Rotation désactivée pour cette organisation (feature org désactivée ou projet en pause).",
    );
    this.name = "RotationDisabledError";
  }
}

/** Gate ouvert = feature rotation activée pour l'org ET projet non en pause. */
export function rotationGateOpen(gate: {
  rotationPaused: boolean;
  organization: { rotationFeatureEnabled: boolean } | null;
}): boolean {
  return !gate.rotationPaused && Boolean(gate.organization?.rotationFeatureEnabled);
}
