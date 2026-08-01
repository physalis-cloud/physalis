-- Types d'entrée du coffre personnel (cf. lib/vault-entry-types.ts).
--
-- Une VaultEntry n'est plus forcément un login/mot de passe sur une URL.
-- Quatre formes portées par la colonne `type` :
--   LOGIN (défaut, forme historique) | SECRET | LIST | NOTE
--
-- `type` est TEXTE et non un enum PG, délibérément : ajouter une 5ᵉ forme
-- demanderait un ALTER TYPE … ADD VALUE, non transactionnel et pénible à
-- rejouer. La validation vit dans lib/vault-entry-types.ts.
--
-- LIST et NOTE stockent leur charge utile dans un blob chiffré unique
-- (`encryptedData` + iv + tag, AES-256-GCM, même clé ENCRYPTION_KEY que le
-- reste). `itemCount` reste EN CLAIR pour afficher « N secrets » sans
-- déchiffrer.
--
-- Le DEFAULT rattache les entrées existantes à LOGIN : aucun backfill.
-- Idempotent (ADD COLUMN IF NOT EXISTS) — rejouable sans risque.

ALTER TABLE "VaultEntry"
  ADD COLUMN IF NOT EXISTS "type"          TEXT NOT NULL DEFAULT 'LOGIN',
  ADD COLUMN IF NOT EXISTS "encryptedData" TEXT,
  ADD COLUMN IF NOT EXISTS "dataIv"        TEXT,
  ADD COLUMN IF NOT EXISTS "dataTag"       TEXT,
  ADD COLUMN IF NOT EXISTS "itemCount"     INTEGER;
