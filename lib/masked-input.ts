// Champs de saisie masqués SANS `input[type=password]`.
//
// Pourquoi : le gestionnaire de mots de passe du navigateur se déclenche sur
// la seule présence d'un `type="password"`. Dans un gestionnaire de secrets,
// ça donne deux comportements absurdes :
//   - il pré-remplit le formulaire avec les credentials Physalis de l'user ;
//   - il propose « Enregistrer ce mot de passe ? » à chaque secret créé.
// `autoComplete="new-password"` calme le premier mais PAS le second — c'est
// même le signal d'un formulaire d'inscription, donc exactement le cas où
// Chrome propose d'enregistrer.
//
// La parade est de ne pas exposer de champ mot de passe du tout : on garde
// `type="text"` et on masque en CSS (`.input-masked`, cf. globals.css). Le
// masquage repose sur `-webkit-text-security` (Chromium, Safari, Firefox
// 122+), avec un repli `color: transparent` là où il manque — jamais de
// valeur lisible à l'écran, quel que soit le navigateur.
//
// Volontairement PAS de détection JS du support : les panneaux qui utilisent
// ces champs sont parfois rendus côté serveur, et une valeur calculée
// différemment au SSR et à l'hydratation provoquerait un mismatch React (et,
// le temps d'une frame, un vrai champ password que l'autofill peut attraper).
//
// À réserver aux secrets MANIPULÉS par l'app (coffres, comptes de projet,
// tokens, secrets CI…). Les vrais identifiants Physalis — login, inscription,
// reset, ré-authentification — doivent garder `type="password"` : là, on VEUT
// que le navigateur propose de remplir et d'enregistrer.

/**
 * Props à étaler sur un `<input>` masqué.
 *
 * @param revealed  true = valeur affichée en clair (bouton « Afficher »).
 * @param className classes de base du champ (défaut : `input input-mono`).
 */
export function maskedInputProps(
  revealed: boolean,
  className = "input input-mono",
): { type: "text"; className: string } {
  return {
    type: "text",
    className: revealed ? className : `${className} input-masked`,
  };
}
