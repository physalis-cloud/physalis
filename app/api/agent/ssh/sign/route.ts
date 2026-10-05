// POST /api/agent/ssh/sign — signature SSH côté serveur pour `physalis
// ssh-agent` (C-0050, phase 3). La clé privée ne quitte jamais Physalis.
// Bearer sv_cli_. Traitement : lib/cli-ssh.ts.

import { handleSshSign } from "@/lib/cli-ssh";

export async function POST(req: Request) {
  return handleSshSign(req);
}
