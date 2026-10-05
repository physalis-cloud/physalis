// Helpers communs pour la validation et le shape des TeamVaultEntry.
// Reutilises par les routes org/* et project/* (logique identique sauf
// le check d'acces, gere par lib/vault-access.ts).
//
// Le coffre personnel (VaultEntry) reste autonome dans /api/vault/entries : les
// deux modeles sont distincts et leurs ROUTES ne se partagent pas.
//
// ⚠️ Une exception, et elle est deliberee (C-0047) : le FORMAT des types
// d'entree (`lib/vault-entry-types.ts`) est partage. Ce module est pur — il
// decrit la forme du blob chiffre, ses limites et ses conversions, rien qui
// soit propre au coffre personnel. Deux validateurs du meme format finiraient
// par diverger sur ce qu'on sait relire APRES chiffrement, et un blob qu'on ne
// sait plus relire n'a pas de correctif.

import { NextResponse } from "next/server";
import { parseTotpInput } from "./otpauth-parse";
import {
  CARRIES,
  VAULT_ENTRY_TYPES,
  VAULT_TYPE_LIMITS,
  encodePayload,
  isVaultEntryType,
  validateListItems,
  validateNoteText,
  type VaultEntryType,
} from "./vault-entry-types";

export const VAULT_LIMITS = {
  nameMax: 200,
  urlMax: 2048,
  usernameMax: 200,
  passwordMax: 4096,
  totpSecretMax: 512,
  tagMax: 50,
  tagsMax: 20,
} as const;

export function normalizeTags(input: unknown): string[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  if (input.length > VAULT_LIMITS.tagsMax) return null;
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") return null;
    const t = raw.trim();
    if (!t) continue;
    if (t.length > VAULT_LIMITS.tagMax) return null;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export type EntryCreateBody = {
  name?: string;
  url?: string | null;
  username?: string | null;
  password?: string | null;
  totpSecret?: string | null;
  tags?: unknown;
  favorite?: boolean;
  /** LOGIN | SECRET | LIST | NOTE (C-0047). Absent = LOGIN, la forme
   *  historique : tout appelant écrit avant ce chantier continue de marcher. */
  type?: unknown;
  /** Items d'une LIST. Ignoré pour les autres formes. */
  items?: unknown;
  /** Texte d'une NOTE. Ignoré pour les autres formes. */
  text?: unknown;
};

export type EntryPatchBody = {
  name?: string;
  url?: string | null;
  username?: string | null;
  password?: string | null;
  totpSecret?: string | null;
  tags?: unknown;
  favorite?: boolean;
  /** Cf. EntryCreateBody. Absent dans un PATCH = « ne change pas le type ». */
  type?: unknown;
  items?: unknown;
  text?: unknown;
  /** Deplace l'entry vers une autre TeamVaultCollection du MEME scope
   *  (org→org dans la meme org, project→project dans le meme projet).
   *  RBAC : EDITOR+ requis sur la collection cible. */
  targetCollectionId?: string;
};

/**
 * Valide un body de creation. Retourne les valeurs normalisees ou une
 * NextResponse 400.
 */
export function validateEntryCreate(body: EntryCreateBody | null):
  | {
      ok: true;
      name: string;
      url: string | null;
      username: string | null;
      password: string | null;
      totpSecret: string | null;
      tags: string[];
      favorite: boolean;
      /** C-0047. Décide de ce que les colonnes portent réellement. */
      type: VaultEntryType;
      /** Charge utile SÉRIALISÉE (LIST/NOTE), ou null. Le chiffrement est le
       *  travail du handler, pas du validateur. */
      payload: string | null;
      /** Nombre d'items d'une LIST, EN CLAIR. null hors LIST. */
      itemCount: number | null;
    }
  | { ok: false; error: NextResponse } {
  if (!body || typeof body.name !== "string") {
    return {
      ok: false,
      error: NextResponse.json({ error: "name is required" }, { status: 400 }),
    };
  }
  const name = body.name.trim();
  if (!name || name.length > VAULT_LIMITS.nameMax) {
    return {
      ok: false,
      error: NextResponse.json(
        { error: `name must be 1-${VAULT_LIMITS.nameMax} chars` },
        { status: 400 },
      ),
    };
  }
  const url =
    typeof body.url === "string" && body.url.trim()
      ? body.url.trim().slice(0, VAULT_LIMITS.urlMax)
      : null;
  const username =
    typeof body.username === "string" && body.username.trim()
      ? body.username.trim().slice(0, VAULT_LIMITS.usernameMax)
      : null;
  const tags = normalizeTags(body.tags);
  if (tags === null) {
    return {
      ok: false,
      error: NextResponse.json(
        {
          error: `tags must be a string array of <= ${VAULT_LIMITS.tagsMax} entries, each <= ${VAULT_LIMITS.tagMax} chars`,
        },
        { status: 400 },
      ),
    };
  }

  let password: string | null = null;
  if (typeof body.password === "string" && body.password.length > 0) {
    if (body.password.length > VAULT_LIMITS.passwordMax) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: `password must be <= ${VAULT_LIMITS.passwordMax} chars` },
          { status: 400 },
        ),
      };
    }
    password = body.password;
  }

  let totpSecret: string | null = null;
  if (typeof body.totpSecret === "string" && body.totpSecret.length > 0) {
    if (body.totpSecret.length > VAULT_LIMITS.totpSecretMax) {
      return {
        ok: false,
        error: NextResponse.json(
          {
            error: `totpSecret must be <= ${VAULT_LIMITS.totpSecretMax} chars`,
          },
          { status: 400 },
        ),
      };
    }
    const parsed = parseTotpInput(body.totpSecret);
    if (!parsed) {
      return {
        ok: false,
        error: NextResponse.json(
          {
            error:
              "totpSecret must be a base32 secret or an otpauth:// URL",
          },
          { status: 400 },
        ),
      };
    }
    totpSecret = parsed;
  }

  // ⚠️ La charge utile est validée par `lib/vault-entry-types.ts`, le module du
  // coffre PERSONNEL — délibérément réutilisé et non recopié (C-0047). Rien
  // dedans n'est personnel : c'est le format du blob chiffré, et deux
  // validateurs du même format finiraient par diverger sur ce qu'on sait
  // relire après chiffrement.
  const charge = validerCharge(body);
  if (!charge.ok) return charge;

  // ⚠️ **La forme décide de ce qui est STOCKÉ, et c'est le serveur qui tranche.**
  // L'écran n'affiche déjà que les champs portés par la forme choisie, mais
  // l'API accepte n'importe quel appelant : sans cette coupe, un
  // `{ type: "LIST", url: "https://…", items: [...] }` créerait une LIST AVEC
  // une URL. Conséquence concrète et pas théorique — l'endpoint de l'extension
  // (`/api/plugin/match`) sélectionne les entrées par `url: { not: null }` :
  // cette LIST serait proposée en remplissage automatique, avec un mot de passe
  // vide, sur un site réel.
  //
  // C'est le pendant à la CRÉATION de ce que la conversion fait déjà à la
  // modification (`CARRIES`, cf. patchEntry). Un seul des deux ne suffit pas.
  const porte = CARRIES[charge.type];

  return {
    ok: true,
    name,
    url: porte.url ? url : null,
    username: porte.username ? username : null,
    password: porte.password ? password : null,
    totpSecret: porte.totp ? totpSecret : null,
    tags,
    favorite: body.favorite === true,
    type: charge.type,
    payload: charge.payload,
    itemCount: charge.itemCount,
  };
}

/**
 * Le type demandé et sa charge utile sérialisée.
 *
 * ⚠️ Un `type` ABSENT vaut `LOGIN` — la forme historique. C'est ce qui rend le
 * changement rétro-compatible : l'extension, le CLI, le SDK et l'import créent
 * des entrées sans jamais parler de type, et doivent continuer.
 *
 * ⚠️ Un `type` PRÉSENT mais inconnu se REFUSE, il ne retombe pas sur LOGIN.
 * `normalizeEntryType` existe pour LIRE une valeur déjà en base (une donnée
 * antérieure, ou écrite hors app) ; l'appliquer à une écriture transformerait
 * une faute de frappe en entrée silencieusement mal typée.
 */
function validerCharge(body: { type?: unknown; items?: unknown; text?: unknown }):
  | { ok: true; type: VaultEntryType; payload: string | null; itemCount: number | null }
  | { ok: false; error: NextResponse } {
  if (body.type !== undefined && !isVaultEntryType(body.type)) {
    return {
      ok: false,
      error: NextResponse.json(
        { error: `type must be one of ${VAULT_ENTRY_TYPES.join(", ")}` },
        { status: 400 },
      ),
    };
  }
  const type: VaultEntryType = body.type === undefined ? "LOGIN" : body.type;

  if (type === "LIST") {
    const items = validateListItems(body.items ?? []);
    if (items === null) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: `items must be <= ${VAULT_TYPE_LIMITS.itemsMax} {label,value} pairs` },
          { status: 400 },
        ),
      };
    }
    return { ok: true, type, payload: encodePayload(type, { items }), itemCount: items.length };
  }

  if (type === "NOTE") {
    const text = validateNoteText(body.text ?? "");
    if (text === null) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: `text must be <= ${VAULT_TYPE_LIMITS.noteTextMax} chars` },
          { status: 400 },
        ),
      };
    }
    return { ok: true, type, payload: encodePayload(type, { text }), itemCount: null };
  }

  // LOGIN et SECRET n'ont pas de charge utile : `payload: null` fait écrire
  // NULL dans `encryptedData` plutôt que d'y chiffrer un objet creux.
  return { ok: true, type, payload: null, itemCount: null };
}

/**
 * Valide un body PATCH partiel. Retourne les champs a modifier (uniquement
 * ceux presents dans le body) ou une NextResponse 400.
 */
export function validateEntryPatch(body: EntryPatchBody | null):
  | {
      ok: true;
      data: Partial<{
        name: string;
        url: string | null;
        username: string | null;
        password: string | null; // null = effacer, string = re-encrypt
        totpSecret: string | null; // null = effacer, string = re-encrypt
        tags: string[];
        favorite: boolean;
        targetCollectionId: string;
      }>;
      changed: string[];
      /**
       * La forme demandée, si le PATCH en demande une (C-0047). `undefined` =
       * « ne change pas le type ».
       *
       * ⚠️ Rendu À PART de `data` : changer de type n'est pas écrire une
       * colonne. Il faut d'abord vérifier que la cible sait porter ce que
       * l'entrée contient déjà (`conversionBlocker`), puis EFFACER les champs
       * que la cible ne porte pas — ce qu'un simple `data.type = …` ne ferait
       * pas, et qui laisserait du chiffré fantôme derrière lui.
       */
      forme?: { type: VaultEntryType; payload: string | null; itemCount: number | null };
    }
  | { ok: false; error: NextResponse } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: NextResponse.json({ error: "Invalid body" }, { status: 400 }),
    };
  }

  const data: Partial<{
    name: string;
    url: string | null;
    username: string | null;
    password: string | null;
    totpSecret: string | null;
    tags: string[];
    favorite: boolean;
    targetCollectionId: string;
  }> = {};
  const changed: string[] = [];

  if (typeof body.name === "string") {
    const v = body.name.trim();
    if (!v || v.length > VAULT_LIMITS.nameMax) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: `name must be 1-${VAULT_LIMITS.nameMax} chars` },
          { status: 400 },
        ),
      };
    }
    data.name = v;
    changed.push("name");
  }
  if ("url" in body) {
    if (body.url === null || body.url === "") {
      data.url = null;
    } else if (typeof body.url === "string") {
      data.url = body.url.trim().slice(0, VAULT_LIMITS.urlMax) || null;
    }
    changed.push("url");
  }
  if ("username" in body) {
    if (body.username === null || body.username === "") {
      data.username = null;
    } else if (typeof body.username === "string") {
      data.username =
        body.username.trim().slice(0, VAULT_LIMITS.usernameMax) || null;
    }
    changed.push("username");
  }
  if ("password" in body) {
    if (body.password === null || body.password === "") {
      data.password = null;
    } else if (typeof body.password === "string") {
      if (body.password.length > VAULT_LIMITS.passwordMax) {
        return {
          ok: false,
          error: NextResponse.json(
            { error: `password must be <= ${VAULT_LIMITS.passwordMax} chars` },
            { status: 400 },
          ),
        };
      }
      data.password = body.password;
    }
    changed.push("password");
  }
  if ("totpSecret" in body) {
    if (body.totpSecret === null || body.totpSecret === "") {
      data.totpSecret = null;
    } else if (typeof body.totpSecret === "string") {
      if (body.totpSecret.length > VAULT_LIMITS.totpSecretMax) {
        return {
          ok: false,
          error: NextResponse.json(
            {
              error: `totpSecret must be <= ${VAULT_LIMITS.totpSecretMax} chars`,
            },
            { status: 400 },
          ),
        };
      }
      const parsed = parseTotpInput(body.totpSecret);
      if (!parsed) {
        return {
          ok: false,
          error: NextResponse.json(
            {
              error:
                "totpSecret must be a base32 secret or an otpauth:// URL",
            },
            { status: 400 },
          ),
        };
      }
      data.totpSecret = parsed;
    }
    changed.push("totpSecret");
  }
  if ("tags" in body) {
    const tags = normalizeTags(body.tags);
    if (tags === null) {
      return {
        ok: false,
        error: NextResponse.json(
          {
            error: `tags must be a string array of <= ${VAULT_LIMITS.tagsMax} entries, each <= ${VAULT_LIMITS.tagMax} chars`,
          },
          { status: 400 },
        ),
      };
    }
    data.tags = tags;
    changed.push("tags");
  }
  if (typeof body.favorite === "boolean") {
    data.favorite = body.favorite;
    changed.push("favorite");
  }
  if (typeof body.targetCollectionId === "string") {
    const v = body.targetCollectionId.trim();
    if (!v) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: "targetCollectionId must be a non-empty string" },
          { status: 400 },
        ),
      };
    }
    data.targetCollectionId = v;
    changed.push("collection");
  }

  // La forme, si elle est demandée. ⚠️ Un PATCH sans `type` ne touche PAS au
  // type : c'est ce qui laisse marcher tous les appelants existants (extension,
  // CLI, SDK) qui modifient un nom ou un mot de passe sans rien savoir des
  // formes.
  let forme: { type: VaultEntryType; payload: string | null; itemCount: number | null } | undefined;
  if (body.type !== undefined || body.items !== undefined || body.text !== undefined) {
    // ⚠️ `items` ou `text` SANS `type` se refuse. `validerCharge` fait retomber
    // un type absent sur LOGIN — ce qui est juste à la CRÉATION (forme
    // historique) et catastrophique ici : envoyer les items d'une LIST sans
    // rappeler son type la convertirait en LOGIN et effacerait la liste, en
    // rendant 200. Exiger le type coûte un champ à l'appelant ; le deviner
    // coûterait des données.
    if (body.type === undefined) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: "type is required when sending items or text" },
          { status: 400 },
        ),
      };
    }
    // ⚠️ Et la RÉCIPROQUE, qui vidait en silence. Un PATCH annonçant
    // `type: "LIST"` sans `items` faisait sérialiser une liste vide, donc
    // écrire `encryptedData = NULL` — la liste disparaissait, et l'appel
    // rendait 200. Même chose pour une NOTE sans `text`. À la CRÉATION
    // l'absence est légitime (il n'y a rien à perdre) ; ici elle est
    // ambiguë, et on ne devine pas.
    if (body.type === "LIST" && body.items === undefined) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: "items is required when patching an entry to type LIST" },
          { status: 400 },
        ),
      };
    }
    if (body.type === "NOTE" && body.text === undefined) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: "text is required when patching an entry to type NOTE" },
          { status: 400 },
        ),
      };
    }
    const charge = validerCharge(body);
    if (!charge.ok) return charge;
    forme = { type: charge.type, payload: charge.payload, itemCount: charge.itemCount };
    changed.push("type");
  }

  return { ok: true, data, changed, forme };
}
