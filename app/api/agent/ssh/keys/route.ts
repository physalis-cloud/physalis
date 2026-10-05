// GET /api/agent/ssh/keys — clés publiques pour `physalis ssh-agent`
// (C-0050, phase 3). Bearer sv_cli_. Traitement : lib/cli-ssh.ts.

import { handleListSshKeys } from "@/lib/cli-ssh";

export async function GET(req: Request) {
  return handleListSshKeys(req);
}
