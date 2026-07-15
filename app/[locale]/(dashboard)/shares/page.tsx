import { Link } from "@/i18n/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import SharesView from "./shares-view";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export default async function SharesPage() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const userId = session.user.id;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);

  // Orgs où l'user est DEV+ : périmètre des demandes externes (mêmes règles
  // que GET /api/secret-requests).
  const memberships = await prisma.orgMember.findMany({
    where: { userId, role: { in: ["OWNER", "ADMIN", "DEV"] } },
    select: { organizationId: true },
  });
  const orgIds = memberships.map((m) => m.organizationId);

  // Compteurs d'accueil de la page (server-rendered), passés à SharesView.
  const [activeShares, expiredShares, externalRequests] = await Promise.all([
    // Partages actifs : ni consommés, ni révoqués, pas encore expirés.
    prisma.oneTimeShare.count({
      where: {
        createdById: userId,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    }),
    // Expirés (30j) : expirés sans avoir été consommés/révoqués, dans la
    // fenêtre de rétention de 30 jours.
    prisma.oneTimeShare.count({
      where: {
        createdById: userId,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { lt: now, gte: thirtyDaysAgo },
      },
    }),
    // Demandes externes en cours : ni révoquées, ni importées, pas expirées.
    orgIds.length
      ? prisma.secretRequest.count({
          where: {
            organizationId: { in: orgIds },
            revokedAt: null,
            importedAt: null,
            expiresAt: { gt: now },
          },
        })
      : Promise.resolve(0),
  ]);

  return (
    <div className="page">
      <div className="page-content">
        <div className="breadcrumb">
          <Link href="/dashboard">← Tableau de bord</Link>
        </div>

        <SharesView
          stats={{
            active: activeShares,
            expired: expiredShares,
            external: externalRequests,
          }}
        />
      </div>
    </div>
  );
}
