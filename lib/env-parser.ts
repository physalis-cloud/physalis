// Parser de fichier `.env` pour l'import bulk de Secrets.
//
// Gere les formats produits par dotenv / docker-compose / shell :
//   - KEY=value                       (basique)
//   - KEY="value avec espaces"        (double quotes : echappements actifs)
//   - KEY='value single quotes'       (single quotes : literal, pas d'echappement)
//   - export KEY=value                (prefixe shell, ignore)
//   - # commentaire pleine ligne      (non importe, mais memorise comme
//                                      `section` des entrees suivantes)
//   - KEY=value # commentaire inline  (commentaire ignore APRES une valeur non-quotee)
//   - KEY="multi\nline\nvalue"        (echappements \n \t \r \\ \" dans double quotes)
//   - KEY="multi                       (valeurs multilignes physiques entre quotes
//   ligne 2                            doubles ou simples — typique pour cles RSA)
//   value"
//   - KEY=                            (valeur vide → "")
//
// Ce qui N'EST PAS gere (volontairement, pour rester strict + previsible) :
//   - Substitution ${VAR}             (laisse au caller si besoin)
//   - Heredocs <<EOF                  (non standard .env)
//   - Continuations avec \ en fin     (ambigu, on prefere les quotes)
//
// Retourne TOUJOURS un objet { entries, errors } — aucune throw, les
// erreurs sont reportees par numero de ligne pour affichage UI.

export type ParsedEntry = {
  key: string;
  value: string;
  /** Commentaire pleine ligne qui ouvre le bloc ou se trouve cette
   *  entree, sans le `#` ni les espaces de bord. Sert a l'import pour
   *  retrouver la categorie ecrite par l'export (`# infra`). Une ligne
   *  vide referme le bloc ; les commentaires INLINE (apres une valeur)
   *  ne comptent pas : ils decrivent la cle, pas une section. */
  section?: string;
};
export type ParseError = { line: number; reason: string };

/** Commentaire sans aucun caractere alphanumerique → pur decor. */
const DECORATIVE_ONLY = /^[^\p{L}\p{N}]*$/u;
export type ParseResult = { entries: ParsedEntry[]; errors: ParseError[] };

/** Parse un texte .env. Tolerant : avance ligne par ligne et reporte les
 *  lignes invalides au lieu de tout invalider. */
export function parseEnv(text: string): ParseResult {
  const entries: ParsedEntry[] = [];
  const errors: ParseError[] = [];
  const seenKeys = new Set<string>();

  // Normalise les fins de ligne pour simplifier (CRLF / CR → LF) et
  // retire un BOM eventuel en debut de fichier.
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  // Section courante = dernier commentaire pleine ligne utile.
  //
  // Portee : le bloc d'entrees qui SUIT le commentaire. Une ligne vide
  // ferme le bloc — sinon un `# Database` en tete de fichier finirait
  // par ranger tout ce qui vient apres, y compris des paragraphes qui
  // n'ont rien a voir. Exception : une ligne vide qui suit
  // immediatement le commentaire ne ferme rien (style `# infra\n\nA=1`),
  // d'ou le drapeau `sectionUsed`.
  let section: string | undefined;
  let sectionUsed = false;

  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1; // 1-based pour l'UI
    const raw = lines[i] ?? "";
    i++;

    // Trim leading whitespace pour reconnaitre commentaires / lignes vides.
    const trimmed = raw.trimStart();
    if (trimmed === "") {
      if (sectionUsed) {
        section = undefined;
        sectionUsed = false;
      }
      continue;
    }
    if (trimmed.startsWith("#")) {
      const text = trimmed.replace(/^#+/, "").trim();
      // Une ligne purement decorative (`# ----------`, `# ##########`)
      // n'est pas un titre de section : on garde celui d'avant, sinon un
      // encadrement ASCII effacerait le vrai en-tete juste au-dessus.
      if (DECORATIVE_ONLY.test(text)) continue;
      section = text;
      sectionUsed = false;
      continue;
    }

    // Strip "export " optionnel.
    const noExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed;

    // Cherche le premier `=` qui delimite key=value. Une cle valide ne
    // contient ni espace ni `=`, donc le premier `=` est forcement le
    // separateur.
    const eqIdx = noExport.indexOf("=");
    if (eqIdx <= 0) {
      errors.push({ line: lineNo, reason: "Ligne sans `=` ou cle vide" });
      continue;
    }

    const key = noExport.slice(0, eqIdx).trim();
    let rest = noExport.slice(eqIdx + 1);

    // Validation lache du nom de la cle : doit etre non vide et ne pas
    // contenir d'espaces. La validation regex stricte
    // ([A-Z][A-Z0-9_]{0,127}) sera faite par le caller (la route) qui
    // a la regle metier — ici on accepte tout ce qui ressemble a une
    // cle pour pouvoir le rapporter ensuite.
    if (!key || /\s/.test(key)) {
      errors.push({ line: lineNo, reason: `Nom de cle invalide: "${key}"` });
      continue;
    }

    // Trim leading whitespace de la valeur (mais pas la trailing tant
    // qu'on n'a pas decide si elle est quotee).
    rest = rest.replace(/^[\t ]+/, "");

    let value: string;

    if (rest.startsWith('"')) {
      // Double-quote : consomme jusqu'au prochain " non-echappe.
      // Peut s'etendre sur plusieurs lignes physiques (cles RSA, etc.).
      const consumed = consumeQuoted(rest.slice(1), '"', true, lines, i);
      if (consumed === null) {
        errors.push({ line: lineNo, reason: "Quote double non fermee" });
        // On saute jusqu'a la fin pour eviter de re-parser les lignes
        // deja consommees comme cles.
        break;
      }
      value = consumed.value;
      i = consumed.nextLineIdx;
      // Apres une valeur quotee, on ignore le reste de la ligne courante
      // (typiquement un commentaire inline ou rien).
    } else if (rest.startsWith("'")) {
      const consumed = consumeQuoted(rest.slice(1), "'", false, lines, i);
      if (consumed === null) {
        errors.push({ line: lineNo, reason: "Quote simple non fermee" });
        break;
      }
      value = consumed.value;
      i = consumed.nextLineIdx;
    } else {
      // Valeur non-quotee : commentaire inline supporte (` #` ou tabulation
      // suivi de #). On respecte la convention dotenv.
      const commentMatch = rest.match(/\s+#/);
      const valuePart =
        commentMatch && commentMatch.index !== undefined
          ? rest.slice(0, commentMatch.index)
          : rest;
      value = valuePart.trimEnd();
    }

    // Dedoublonnage intra-fichier : si la meme cle apparait deux fois,
    // on conserve la derniere (comportement dotenv : last-write-wins),
    // mais on signale comme erreur "soft" pour info user.
    if (seenKeys.has(key)) {
      // Remplace l'entree existante (section incluse : la derniere
      // occurrence gagne aussi sur le rangement).
      const existingIdx = entries.findIndex((e) => e.key === key);
      if (existingIdx >= 0) entries[existingIdx] = { key, value, section };
      sectionUsed = true;
      errors.push({
        line: lineNo,
        reason: `Cle "${key}" deja vue plus haut, derniere occurrence retenue`,
      });
      continue;
    }
    seenKeys.add(key);
    entries.push({ key, value, section });
    sectionUsed = true;
  }

  return { entries, errors };
}

/** Consomme une valeur entre quotes. Peut traverser plusieurs lignes
 *  physiques. Retourne la valeur (avec echappements traites si
 *  `expandEscapes`) et l'index de la prochaine ligne a lire. */
function consumeQuoted(
  firstChunk: string,
  quote: '"' | "'",
  expandEscapes: boolean,
  lines: string[],
  startLineIdx: number,
): { value: string; nextLineIdx: number } | null {
  // On reconstruit la valeur caractere par caractere pour traiter les
  // echappements correctement (impossible avec un simple split sur la
  // quote car `\"` ferait faux positif).
  let buf = "";
  let chunk = firstChunk;
  let lineIdx = startLineIdx;
  let firstIter = true;

  while (true) {
    if (!firstIter) {
      // Ligne suivante : ajoute un \n litteral et continue.
      if (lineIdx >= lines.length) return null; // EOF avant fermeture
      buf += "\n";
      chunk = lines[lineIdx] ?? "";
      lineIdx++;
    }
    firstIter = false;

    let j = 0;
    while (j < chunk.length) {
      const ch = chunk[j];
      if (ch === "\\" && expandEscapes && j + 1 < chunk.length) {
        const next = chunk[j + 1];
        switch (next) {
          case "n":
            buf += "\n";
            break;
          case "t":
            buf += "\t";
            break;
          case "r":
            buf += "\r";
            break;
          case "\\":
            buf += "\\";
            break;
          case '"':
            buf += '"';
            break;
          case "'":
            buf += "'";
            break;
          default:
            // Echappement inconnu : on garde litteral (backslash + char).
            buf += "\\" + (next ?? "");
        }
        j += 2;
        continue;
      }
      if (ch === quote) {
        // Quote fermante trouvee.
        return { value: buf, nextLineIdx: lineIdx };
      }
      buf += ch ?? "";
      j++;
    }
    // Fin de chunk sans quote fermante → on continue sur la ligne suivante.
  }
}
