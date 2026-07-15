// Bench de l'overhead de chiffrement (Perf #3).
//
// Mesure le débit d'encrypt()/decrypt() (AES-256-GCM, lib/crypto) sur des
// tailles de valeur réalistes pour un secret (token court, .env moyen, blob).
// Sert de garde-fou : si une régression alourdit le chiffrement (ex. dérivation
// de clé par appel), le débit chute visiblement.
//
// Lancement : npx vitest bench --run perf/crypto.bench.ts
// (ENCRYPTION_KEY est posé par tests/setup.ts, comme pour les tests unitaires.)

import { bench, describe } from "vitest";
import { encrypt, decrypt } from "@/lib/crypto";

const SIZES: Record<string, string> = {
  "token court (40o)": "sk-prod-".padEnd(40, "x"),
  ".env moyen (1Ko)": "KEY=value\n".repeat(100).slice(0, 1024),
  "blob (16Ko)": "X".repeat(16 * 1024),
};

describe("encrypt", () => {
  for (const [label, plain] of Object.entries(SIZES)) {
    bench(label, () => {
      encrypt(plain);
    });
  }
});

describe("decrypt", () => {
  for (const [label, plain] of Object.entries(SIZES)) {
    const payload = encrypt(plain);
    bench(label, () => {
      decrypt(payload);
    });
  }
});

describe("round-trip encrypt+decrypt", () => {
  for (const [label, plain] of Object.entries(SIZES)) {
    bench(label, () => {
      decrypt(encrypt(plain));
    });
  }
});
