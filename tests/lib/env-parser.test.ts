import { describe, it, expect } from "vitest";
import { parseEnv } from "@/lib/env-parser";

describe("env-parser", () => {
  it("parse une cle=valeur simple", () => {
    const r = parseEnv("FOO=bar");
    expect(r.entries).toEqual([
      { key: "FOO", value: "bar", section: undefined },
    ]);
    expect(r.errors).toEqual([]);
  });

  it("n'importe pas les lignes vides ni les commentaires", () => {
    const r = parseEnv("\n# commentaire\nFOO=bar\n\n# autre\nBAZ=qux\n");
    expect(r.entries.map((e) => [e.key, e.value])).toEqual([
      ["FOO", "bar"],
      ["BAZ", "qux"],
    ]);
    expect(r.errors).toEqual([]);
  });

  it("supporte le prefixe `export`", () => {
    const r = parseEnv("export DATABASE_URL=postgres://localhost");
    expect(r.entries).toEqual([
      { key: "DATABASE_URL", value: "postgres://localhost" },
    ]);
  });

  it("strip les commentaires inline sur les valeurs non-quotees", () => {
    const r = parseEnv("FOO=bar # ceci est un commentaire");
    expect(r.entries[0]?.value).toBe("bar");
  });

  it("respecte le # litteral dans une valeur non-quotee sans espace", () => {
    // dotenv : `KEY=foo#bar` → value = "foo#bar" (le # n'est commentaire
    // que precede d'un whitespace).
    const r = parseEnv("FOO=foo#bar");
    expect(r.entries[0]?.value).toBe("foo#bar");
  });

  it("preserve le contenu entre double quotes y compris les espaces", () => {
    const r = parseEnv('FOO="hello world  "');
    expect(r.entries[0]?.value).toBe("hello world  ");
  });

  it("expand les echappements dans les double quotes", () => {
    const r = parseEnv('FOO="line1\\nline2\\tcol"');
    expect(r.entries[0]?.value).toBe("line1\nline2\tcol");
  });

  it("NE PAS expand les echappements dans les single quotes (litteral)", () => {
    const r = parseEnv("FOO='line1\\nline2'");
    expect(r.entries[0]?.value).toBe("line1\\nline2");
  });

  it("supporte les valeurs multilignes physiques entre double quotes", () => {
    const r = parseEnv('PRIV="-----BEGIN-----\nline2\nline3\n-----END-----"');
    expect(r.entries[0]?.value).toBe(
      "-----BEGIN-----\nline2\nline3\n-----END-----",
    );
    expect(r.errors).toEqual([]);
  });

  it("supporte les valeurs vides", () => {
    const r = parseEnv("EMPTY=\nALSO_EMPTY=\"\"");
    expect(r.entries).toEqual([
      { key: "EMPTY", value: "" },
      { key: "ALSO_EMPTY", value: "" },
    ]);
  });

  it("normalise CRLF et CR en LF", () => {
    const r = parseEnv("FOO=bar\r\nBAZ=qux\rEND=1");
    expect(r.entries).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
      { key: "END", value: "1" },
    ]);
  });

  it("supprime un BOM UTF-8 en tete", () => {
    const r = parseEnv("﻿FOO=bar");
    expect(r.entries).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("signale une ligne sans `=` comme erreur sans planter le reste", () => {
    const r = parseEnv("FOO=bar\nBADLINE\nBAZ=qux");
    expect(r.entries).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.line).toBe(2);
  });

  it("signale une quote double non fermee", () => {
    const r = parseEnv('FOO="unclosed\nBAR=ignored');
    expect(r.entries).toEqual([]);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]?.reason).toMatch(/non fermee/i);
  });

  it("signale les doublons et retient la derniere occurrence", () => {
    const r = parseEnv("FOO=first\nFOO=second");
    expect(r.entries).toEqual([
      { key: "FOO", value: "second", section: undefined },
    ]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toMatch(/deja vue/);
  });

  it("accepte un signe = dans la valeur (split sur le premier seulement)", () => {
    const r = parseEnv("URL=postgres://u:p=secret@host/db");
    expect(r.entries[0]?.value).toBe("postgres://u:p=secret@host/db");
  });

  it("trim les espaces avant la valeur non-quotee", () => {
    const r = parseEnv("FOO=   bar");
    expect(r.entries[0]?.value).toBe("bar");
  });

  describe("sections (commentaires pleine ligne)", () => {
    it("rattache chaque entree au dernier commentaire vu", () => {
      // Format exact produit par l'export .env de l'app.
      const r = parseEnv(
        [
          "# application",
          "REPO_NAME=physalis-cloud/physalis-vitrine",
          "",
          "# ports",
          "API_PORT=58103",
          "FRONTEND_PORT=58102",
          "",
        ].join("\n"),
      );
      expect(r.entries.map((e) => [e.key, e.section])).toEqual([
        ["REPO_NAME", "application"],
        ["API_PORT", "ports"],
        ["FRONTEND_PORT", "ports"],
      ]);
    });

    it("une ligne vide referme le bloc de la section", () => {
      // Sans cette regle, un `# Database` en tete de fichier rangerait
      // tout ce qui suit, y compris des paragraphes sans rapport.
      const r = parseEnv("# infra\nA=1\n\nB=2");
      expect(r.entries.map((e) => e.section)).toEqual(["infra", undefined]);
    });

    it("mais une ligne vide juste apres l'en-tete ne referme rien", () => {
      const r = parseEnv("# infra\n\nA=1\nB=2");
      expect(r.entries.map((e) => e.section)).toEqual(["infra", "infra"]);
    });

    it("laisse la section vide avant tout commentaire", () => {
      const r = parseEnv("FOO=bar\n# infra\nBAZ=qux");
      expect(r.entries[0]?.section).toBeUndefined();
      expect(r.entries[1]?.section).toBe("infra");
    });

    it("ignore les lignes purement decoratives", () => {
      const r = parseEnv(
        ["# -----------------", "# Database", "# =================", "DB=1"].join(
          "\n",
        ),
      );
      expect(r.entries[0]?.section).toBe("Database");
    });

    it("ne prend pas un commentaire inline pour une section", () => {
      const r = parseEnv("# infra\nFOO=bar # une note sur foo\nBAZ=qux");
      expect(r.entries.map((e) => e.section)).toEqual(["infra", "infra"]);
    });

    it("strip les # multiples et les espaces de bord", () => {
      const r = parseEnv("### Infra ###\nFOO=bar");
      expect(r.entries[0]?.section).toBe("Infra ###");
    });
  });
});
