// buildMobileBundle — agencement et décodage du matériel de signature.
//
// Le module ne résout ni tenant ni droits (l'endpoint le fait) : on lui passe
// un lecteur de credentials mocké et on vérifie le CONTRAT du bundle, en
// particulier le point qui casse silencieusement si on l'oublie — un fichier
// ressort en base64, un texte ressort décodé.

import { describe, it, expect, vi } from "vitest";
import { buildMobileBundle, consumeBuildNumber } from "@/lib/mobile-bundle";
import { encrypt } from "@/lib/crypto";

const APP = {
  id: "app1",
  platform: "ios",
  bundleId: "com.exemple.app",
  displayName: "Exemple",
  vendorTeamId: "ABCDE12345",
};

/** Fabrique un lecteur mocké qui rend ces lignes déjà chiffrées, comme la DB. */
function reader(
  rows: Array<{
    kind: string;
    plaintextBase64: string;
    filename?: string | null;
    expiresAt?: Date | null;
  }>,
) {
  const findMany = vi.fn(async () =>
    rows.map((r) => ({
      kind: r.kind,
      filename: r.filename ?? null,
      sha256: "deadbeef",
      expiresAt: r.expiresAt ?? null,
      ...encrypt(r.plaintextBase64),
    })),
  );
  return { mobileCredential: { findMany } } as never;
}

describe("buildMobileBundle", () => {
  it("rend un fichier en base64 et un texte décodé", async () => {
    // La valeur STOCKÉE est toujours du base64 (chiffré). Un keystore : le
    // base64 des octets binaires. Un mot de passe : le base64 de son UTF-8.
    const keystoreB64 = Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64");
    const passwordB64 = Buffer.from("s3crét!", "utf8").toString("base64");

    const bundle = await buildMobileBundle(
      reader([
        { kind: "android_keystore", plaintextBase64: keystoreB64, filename: "r.jks" },
        { kind: "android_keystore_password", plaintextBase64: passwordB64 },
      ]),
      { ...APP, platform: "android" },
    );

    expect(bundle).not.toBeNull();
    const byKind = Object.fromEntries(
      bundle!.credentials.map((c) => [c.kind, c]),
    );

    // fichier → base64 tel quel, le CI l'écrira en binaire
    expect(byKind.android_keystore.encoding).toBe("base64");
    expect(byKind.android_keystore.value).toBe(keystoreB64);
    expect(byKind.android_keystore.filename).toBe("r.jks");

    // texte → décodé, accents compris (le bug btoa d'origine aurait cassé ici)
    expect(byKind.android_keystore_password.encoding).toBe("utf8");
    expect(byKind.android_keystore_password.value).toBe("s3crét!");
  });

  it("propage l'expiration en ISO et les métadonnées d'app", async () => {
    const when = new Date("2027-03-04T10:20:30.000Z");
    const bundle = await buildMobileBundle(
      reader([
        {
          kind: "ios_p12",
          plaintextBase64: Buffer.from("x").toString("base64"),
          expiresAt: when,
        },
      ]),
      APP,
    );
    expect(bundle!.app).toEqual(APP);
    expect(bundle!.credentials[0].expiresAt).toBe("2027-03-04T10:20:30.000Z");
  });

  it("rend null quand l'app n'a aucun credential", async () => {
    // Un pipeline qui ne peut rien signer doit recevoir un échec clair, pas un
    // bundle vide qui casserait plus tard au moment du build.
    expect(await buildMobileBundle(reader([]), APP)).toBeNull();
  });
});

describe("consumeBuildNumber", () => {
  it("incrémente atomiquement et renvoie le nouveau numéro + la version", async () => {
    // Mock : simule l'update Prisma { increment: 1 } en renvoyant 11 pour un
    // point de départ à 10.
    const update = vi.fn(async () => ({ buildNumber: 11, versionName: "1.9" }));
    const db = { mobileApp: { update } } as never;
    const got = await consumeBuildNumber(db, "app1");
    expect(got).toEqual({ buildNumber: 11, versionName: "1.9" });
    // L'écriture doit demander l'incrément atomique, pas une valeur en dur.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "app1" },
        data: { buildNumber: { increment: 1 } },
      }),
    );
  });
});
