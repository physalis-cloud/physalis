-- §4 — Qui perdrait de l'accès si `User.role = ADMIN` (god-mode tenant, attribué
-- au PROPRIÉTAIRE du compte par lib/provisioning.ts) cessait de primer sur une
-- ligne `OrgMember` de rôle inférieur ?
--
-- Balaie TOUS les schémas tenant. Deux sorties :
--   TÉMOIN   — comptes god-mode scannés par tenant (prouve que la requête voit
--              bien quelque chose ; sans lui, un résultat vide est ambigu).
--   IMPACTÉ  — les comptes qui perdraient réellement de l'accès.
--
-- Aucun « IMPACTÉ » ⇒ l'alignement est neutre, on le garde.
-- Au moins un ⇒ ne pas retirer l'accès : corriger dans l'autre sens (rendre le
--               god-mode prioritaire), cf. docs/failles.md §4.
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
      'SELECT count(*) FROM %I."User" WHERE role = ''ADMIN''', s
    ) INTO n_scanned;
    RAISE NOTICE 'TÉMOIN   % : % compte(s) god-mode (User.role=ADMIN)', s, n_scanned;
    n_total := n_total + n_scanned;

    FOR r IN EXECUTE format(
      'SELECT u.email, o.slug AS org, m.role::text AS org_role
         FROM %I."User" u
         JOIN %I."OrgMember" m ON m."userId" = u.id
         JOIN %I."Organization" o ON o.id = m."organizationId"
        WHERE u.role = ''ADMIN'' AND m.role NOT IN (''ADMIN'', ''OWNER'')
        ORDER BY u.email', s, s, s)
    LOOP
      n_impacted := n_impacted + 1;
      RAISE NOTICE 'IMPACTÉ  % : % — org=% (OrgMember.role=%)', s, r.email, r.org, r.org_role;
    END LOOP;
  END LOOP;

  RAISE NOTICE '─────────────────────────────────────────────';
  RAISE NOTICE 'RÉSULTAT : % compte(s) god-mode scanné(s), % impacté(s)', n_total, n_impacted;
  IF n_impacted = 0 THEN
    RAISE NOTICE 'VERDICT  : alignement NEUTRE — rien à changer.';
  ELSE
    RAISE NOTICE 'VERDICT  : NE PAS retirer l''accès — corriger dans l''autre sens.';
  END IF;
END $$;
