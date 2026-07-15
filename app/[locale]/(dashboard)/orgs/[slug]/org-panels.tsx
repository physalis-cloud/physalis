"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { OrgRole } from "@prisma/client";
import { RiSafe2Line } from "@remixicon/react";
import OrgMembersPanel from "./members-panel";
import OrgSecretsPanel from "./org-secrets-panel";
import CiConnectionsPanel from "./ci-connections-panel";
import ServersPanel from "./servers-panel";
import OrgSettingsPanel from "./org-settings-panel";
import OrgTokensPanel from "./org-tokens-panel";
import TeamVaultPanel from "../../team-vault-panel";

// OVERLAY self-host : version mono-tenant privée de l'onglet Rotation
// (org-rotation-panel + rotation-cron sont exclus du build self-host, cf.
// EXCLUDE dans build-public.mjs). `rotationFeatureEnabled` reste threadé
// (toujours false ici) car OrgSettingsPanel/TeamVaultPanel l'exigent.

const ORG_ROLE_RANK: Record<OrgRole, number> = {
  MEMBER: 1,
  DEV: 2,
  ADMIN_DEV: 3,
  ADMIN: 4,
  OWNER: 5,
};

type Tab = "infos" | "members" | "secrets" | "cicd" | "servers" | "vault" | "tokens";

export default function OrgPanels({
  slug,
  orgName,
  role,
  isPrimary,
  rotationFeatureEnabled,
  rotationPaidPlan,
}: {
  slug: string;
  orgName: string;
  role: OrgRole;
  isPrimary: boolean;
  rotationFeatureEnabled: boolean;
  rotationPaidPlan: boolean;
}) {
  const t = useTranslations("orgs");

  // DEV+ peut voir les onglets Secrets globaux et Serveurs (lecture seule
  // pour DEV, R/W pour ADMIN+).
  const canRead = ORG_ROLE_RANK[role] >= ORG_ROLE_RANK.DEV;
  const canManage = ORG_ROLE_RANK[role] >= ORG_ROLE_RANK.ADMIN;

  // Les ADMIN+ atterrissent sur « Infos » (réglages org) — l'onglet visé par
  // « Paramètres » du header. Les autres sur le coffre d'équipe.
  const [tab, setTab] = useState<Tab>(canManage ? "infos" : "vault");

  return (
    <div className="flex flex-col gap-6">
      <div
        className="tab-bar"
        style={{ display: "flex", justifyContent: "space-between" }}
      >
        <div style={{ display: "flex" }}>
          {canManage && (
            <button
              type="button"
              className={`tab ${tab === "infos" ? "active" : ""}`}
              onClick={() => setTab("infos")}
            >
              {t("tabs.infos")}
            </button>
          )}
          <button
            type="button"
            className={`tab ${tab === "vault" ? "active" : ""}`}
            onClick={() => setTab("vault")}
          >
            <RiSafe2Line size={14} aria-hidden /> {t("tabs.vault")}
          </button>
          {canRead && (
            <button
              type="button"
              className={`tab ${tab === "secrets" ? "active" : ""}`}
              onClick={() => setTab("secrets")}
            >
              {t("tabs.secrets")}
            </button>
          )}
          {canRead && (
            <button
              type="button"
              className={`tab ${tab === "cicd" ? "active" : ""}`}
              onClick={() => setTab("cicd")}
            >
              {t("tabs.cicd")}
            </button>
          )}
          {canRead && (
            <button
              type="button"
              className={`tab ${tab === "servers" ? "active" : ""}`}
              onClick={() => setTab("servers")}
            >
              {t("tabs.servers")}
            </button>
          )}
          <button
            type="button"
            className={`tab ${tab === "members" ? "active" : ""}`}
            onClick={() => setTab("members")}
          >
            {t("tabs.members")}
          </button>
          {canRead && (
            <button
              type="button"
              className={`tab ${tab === "tokens" ? "active" : ""}`}
              onClick={() => setTab("tokens")}
            >
              {t("tabs.tokens")}
            </button>
          )}
        </div>
      </div>

      {tab === "infos" && canManage ? (
        <OrgSettingsPanel
          slug={slug}
          initialName={orgName}
          role={role}
          isPrimary={isPrimary}
          rotationFeatureEnabled={rotationFeatureEnabled}
          rotationPaidPlan={rotationPaidPlan}
        />
      ) : tab === "members" ? (
        <OrgMembersPanel slug={slug} role={role} />
      ) : tab === "secrets" ? (
        <OrgSecretsPanel slug={slug} role={role} />
      ) : tab === "cicd" ? (
        <CiConnectionsPanel slug={slug} role={role} />
      ) : tab === "servers" ? (
        <ServersPanel slug={slug} role={role} />
      ) : tab === "tokens" && canRead ? (
        <OrgTokensPanel slug={slug} />
      ) : (
        <TeamVaultPanel
          scope={{ kind: "org", orgSlug: slug }}
          canCreate={canRead}
          rotationFeatureEnabled={rotationFeatureEnabled}
        />
      )}
    </div>
  );
}
