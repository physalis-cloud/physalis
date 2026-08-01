// Chiffrement de la charge utile des VaultEntry de type LIST / NOTE.
//
// Séparé de lib/vault-entry-types.ts DÉLIBÉRÉMENT : ce module importe
// lib/crypto (node:crypto), alors que vault-entry-types est aussi importé
// par le composant client du coffre (règles de conversion). Mélanger les
// deux embarquerait node:crypto dans le bundle navigateur.

import { decrypt, encrypt } from "./crypto";
import {
  decodePayload,
  encodePayload,
  itemCountFor,
  type VaultEntryType,
  type VaultPayload,
} from "./vault-entry-types";

/** Les 4 colonnes que porte la charge utile sur VaultEntry. */
export type PayloadColumns = {
  encryptedData: string | null;
  dataIv: string | null;
  dataTag: string | null;
  itemCount: number | null;
};

/** Colonnes vides — utilisé quand une entrée change pour un type qui ne
 *  porte pas de charge utile (LOGIN / SECRET), pour ne pas laisser un blob
 *  chiffré orphelin sur la ligne. */
export const EMPTY_PAYLOAD_COLUMNS: PayloadColumns = {
  encryptedData: null,
  dataIv: null,
  dataTag: null,
  itemCount: null,
};

export function encryptPayload(
  type: VaultEntryType,
  payload: VaultPayload,
): PayloadColumns {
  const itemCount = itemCountFor(type, payload);
  const plaintext = encodePayload(type, payload);
  if (!plaintext) {
    return { ...EMPTY_PAYLOAD_COLUMNS, itemCount };
  }
  const enc = encrypt(plaintext);
  return {
    encryptedData: enc.encryptedValue,
    dataIv: enc.iv,
    dataTag: enc.tag,
    itemCount,
  };
}

export function decryptPayload(row: {
  encryptedData: string | null;
  dataIv: string | null;
  dataTag: string | null;
}): VaultPayload {
  if (!row.encryptedData || !row.dataIv || !row.dataTag) return {};
  return decodePayload(
    decrypt({
      encryptedValue: row.encryptedData,
      iv: row.dataIv,
      tag: row.dataTag,
    }),
  );
}
