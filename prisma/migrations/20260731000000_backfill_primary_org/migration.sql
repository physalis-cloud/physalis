-- Backfill de l'org principale (self-host).
--
-- Jusqu'ici aucun code self-host n'écrivait `Organization.isPrimary` : la
-- colonne existait mais restait à `false` sur toutes les lignes. Conséquences :
--   * /account n'avait aucun nom/slug de compte à afficher (« — ») ;
--   * le garde-fou de suppression d'org (app/api/orgs/[slug]/route.ts) ne se
--     déclenchait jamais — l'org principale était supprimable.
--
-- On marque l'org la PLUS ANCIENNE (celle du bootstrap admin / du premier
-- signup), et seulement si aucune ligne n'est déjà marquée. Idempotent :
-- rejouer la migration sur une base déjà backfillée ne change rien.

UPDATE "Organization"
SET "isPrimary" = true
WHERE id = (
  SELECT o.id
  FROM "Organization" o
  WHERE NOT EXISTS (
    SELECT 1 FROM "Organization" p WHERE p."isPrimary"
  )
  ORDER BY o."createdAt" ASC, o.id ASC
  LIMIT 1
);
