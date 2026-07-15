// Registre des connecteurs de sync sortante, indexé par provider.
//
// B1 : Vercel (lib/sync/vercel.ts). B2 : Render (lib/sync/render.ts). Railway à
// venir. Un provider absent du registre → triggerSync marque la cible "error".

import type { SyncConnector } from "./types";
import { vercelConnector } from "./vercel";
import { renderConnector } from "./render";
import { railwayConnector } from "./railway";

const CONNECTORS: Partial<Record<string, SyncConnector>> = {
  vercel: vercelConnector,
  render: renderConnector,
  railway: railwayConnector,
};

export function getConnector(provider: string): SyncConnector | null {
  return CONNECTORS[provider] ?? null;
}
