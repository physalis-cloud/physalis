-- §19.8 — Qui voit un CHANGEMENT quand `vault/destinations` passe de sa règle
-- non canonique (« l'explicite ne s'écrase jamais par l'implicite ») à
-- effectiveProjectRole (règle 1 : OrgADMIN/OWNER → OWNER, la ligne ET `hidden`
-- ignorés) ?
--
-- Population affectée = un OrgMember ADMIN/OWNER portant, sur un projet de SON
-- org, une ligne ProjectMember RESTRICTIVE au sens de l'ancien code :
--   - hidden = true    → l'ancien code SAUTAIT le projet (invisible en dest.)
--   - role  <> 'OWNER' → l'ancien code montrait ce rôle inférieur (VIEWER =
--                        collection filtrée ; EDITOR = montré EDITOR)
-- Le nouveau code montre OWNER dans les deux cas. Pour cette population, la
-- liste « Déplacer vers… » s'ÉLARGIT (des collections de projet apparaissent).
--
-- Balaie TOUS les schémas tenant. Deux sorties, sur le modèle de
-- check-godmode-impact.sql :
--   TÉMOIN   — OrgMember ADMIN/OWNER scannés par tenant (prouve que la requête
--              voit quelque chose).
--   IMPACTÉ  — ceux qui voient réellement un élargissement.
--
-- Aucun « IMPACTÉ » ⇒ l'alignement est neutre en pratique (personne n'a de ligne
--                     restrictive sur une org qu'il administre). On le garde.
-- Au moins un ⇒ l'élargissement est réel pour cette personne — vérifier que
--               c'est bien le comportement voulu (un OrgADMIN a OWNER partout
--               ailleurs, donc a priori oui).
DO $$
DECLARE
  s text;
  r record;
  n_scanned int;
  n_impacted int := 0;
  n_total int := 0;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'client\_%' ORDER BY nspname
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I."OrgMember" WHERE role IN (''ADMIN'', ''OWNER'')', s
    ) INTO n_scanned;
    RAISE NOTICE 'TÉMOIN   % : % OrgMember ADMIN/OWNER', s, n_scanned;
    n_total := n_total + n_scanned;

    FOR r IN EXECUTE format(
      'SELECT DISTINCT u.email, o.slug AS org, m.role::text AS org_role,
              pm.role::text AS proj_role, pm.hidden
         FROM %I."OrgMember" m
         JOIN %I."User" u ON u.id = m."userId"
         JOIN %I."Organization" o ON o.id = m."organizationId"
         JOIN %I."Project" p ON p."organizationId" = m."organizationId"
         JOIN %I."ProjectMember" pm
              ON pm."userId" = m."userId" AND pm."projectId" = p.id
        WHERE m.role IN (''ADMIN'', ''OWNER'')
          AND (pm.hidden = true OR pm.role <> ''OWNER'')
        ORDER BY u.email', s, s, s, s, s)
    LOOP
      n_impacted := n_impacted + 1;
      RAISE NOTICE 'IMPACTÉ  % : % — org=% (OrgMember=%, ligne projet role=% hidden=%)',
        s, r.email, r.org, r.org_role, r.proj_role, r.hidden;
    END LOOP;
  END LOOP;

  RAISE NOTICE '─────────────────────────────────────────────';
  RAISE NOTICE 'RÉSULTAT : % OrgMember ADMIN/OWNER scanné(s), % impacté(s)', n_total, n_impacted;
  IF n_impacted = 0 THEN
    RAISE NOTICE 'VERDICT  : élargissement NEUTRE en pratique — personne concerné.';
  ELSE
    RAISE NOTICE 'VERDICT  : élargissement RÉEL pour ces comptes — confirmer que c''est voulu.';
  END IF;
END $$;
