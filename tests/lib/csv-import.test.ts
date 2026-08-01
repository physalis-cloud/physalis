import { describe, it, expect } from "vitest";
import { parseCsv, parseImport } from "@/lib/csv-import";

describe("lib/csv-import — parseCsv (RFC 4180)", () => {
  it("parse une ligne simple", () => {
    expect(parseCsv("a,b,c")).toEqual([["a", "b", "c"]]);
  });

  it("parse plusieurs lignes (LF + CRLF)", () => {
    expect(parseCsv("a,b\nc,d\r\ne,f")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("préserve les virgules dans les champs quotés", () => {
    expect(parseCsv('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
  });

  it("préserve les newlines dans les champs quotés", () => {
    expect(parseCsv('a,"b\nc",d')).toEqual([["a", "b\nc", "d"]]);
  });

  it("gère les escapes \"\" -> \"", () => {
    expect(parseCsv('a,"b""c",d')).toEqual([["a", 'b"c', "d"]]);
  });

  it("ignore les lignes vides finales", () => {
    expect(parseCsv("a,b\n\n\n")).toEqual([["a", "b"]]);
  });

  it("strip BOM utf-8", () => {
    const r = parseImport("﻿name,url\nGmail,gmail.com");
    expect(r.ok).toBe(true);
  });
});

describe("lib/csv-import — parseImport (Bitwarden)", () => {
  const BW = `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
"Travail",1,login,"GitHub Pro",,,,https://github.com,user@example.com,p@ssw0rd,JBSWY3DPEHPK3PXP
,,login,"Gmail perso",,,,https://gmail.com,perso@gmail.com,supersecret,
"Travail",,login,"Slack",,,,https://slack.com,user@ex,slacksecret,`;

  it("détecte le format Bitwarden", () => {
    const r = parseImport(BW);
    if (!r.ok) throw new Error(r.error);
    expect(r.format).toBe("bitwarden");
    expect(r.entries).toHaveLength(3);
  });

  it("mappe correctement nom/url/login/password/totp/folder/favorite", () => {
    const r = parseImport(BW);
    if (!r.ok) throw new Error(r.error);
    const gh = r.entries[0];
    expect(gh.name).toBe("GitHub Pro");
    expect(gh.url).toBe("https://github.com");
    expect(gh.username).toBe("user@example.com");
    expect(gh.password).toBe("p@ssw0rd");
    expect(gh.totpSecret).toBe("JBSWY3DPEHPK3PXP");
    expect(gh.collectionName).toBe("Travail");
    expect(gh.favorite).toBe(true);
  });

  it("ignore les types sans équivalent dans le coffre (cards, identities)", () => {
    const csv = `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
,,card,"Visa",,,,,,
,,identity,"Moi",,,,,,
,,login,"Gmail",,,,gmail.com,me,pwd,`;
    const r = parseImport(csv);
    if (!r.ok) throw new Error(r.error);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].name).toBe("Gmail");
  });

  it("marque les logins comme type LOGIN", () => {
    const r = parseImport(BW);
    if (!r.ok) throw new Error(r.error);
    expect(r.entries.every((e) => e.type === "LOGIN")).toBe(true);
    expect(r.entries.every((e) => e.text === null)).toBe(true);
  });

  it("importe les notes sécurisées comme entrées NOTE", () => {
    const csv = `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
"Perso",1,note,"Codes de récupération","AAAA-BBBB
CCCC-DDDD",,,,,,
,,login,"Gmail",,,,gmail.com,me,pwd,`;
    const r = parseImport(csv);
    if (!r.ok) throw new Error(r.error);
    expect(r.entries).toHaveLength(2);
    const note = r.entries[0];
    expect(note.type).toBe("NOTE");
    expect(note.name).toBe("Codes de récupération");
    // Le contenu multi-ligne du champ quoté est préservé tel quel.
    expect(note.text).toBe("AAAA-BBBB\nCCCC-DDDD");
    expect(note.collectionName).toBe("Perso");
    expect(note.favorite).toBe(true);
    // Une NOTE ne porte ni URL, ni login, ni mot de passe.
    expect(note.url).toBeNull();
    expect(note.username).toBeNull();
    expect(note.password).toBeNull();
  });

  it("saute les notes vides (rien à protéger)", () => {
    const csv = `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
,,note,"Note vide",,,,,,
,,note,"Note blanche","   ",,,,,,`;
    const r = parseImport(csv);
    expect(r.ok).toBe(false);
  });
});

describe("lib/csv-import — parseImport (Chrome)", () => {
  const CHROME = `name,url,username,password,note
GitHub,https://github.com,me@gmail.com,pass1,
Gmail,https://gmail.com,me@gmail.com,pass2,`;

  it("détecte le format Chrome", () => {
    const r = parseImport(CHROME);
    if (!r.ok) throw new Error(r.error);
    expect(r.format).toBe("chrome");
    expect(r.entries).toHaveLength(2);
  });

  it("ne crée pas de collection (pas de folder)", () => {
    const r = parseImport(CHROME);
    if (!r.ok) throw new Error(r.error);
    expect(r.entries.every((e) => e.collectionName === null)).toBe(true);
  });
});

describe("lib/csv-import — parseImport (générique)", () => {
  it("détecte le format générique avec colonnes diverses", () => {
    const csv = `title,website,login,pwd,group
"Mon site",example.com,me,sec,Outils`;
    const r = parseImport(csv);
    if (!r.ok) throw new Error(r.error);
    expect(r.format).toBe("generic");
    expect(r.entries[0].name).toBe("Mon site");
    expect(r.entries[0].url).toBe("example.com");
    expect(r.entries[0].username).toBe("me");
    expect(r.entries[0].password).toBe("sec");
    expect(r.entries[0].collectionName).toBe("Outils");
  });
});

describe("lib/csv-import — erreurs", () => {
  it("rejette un CSV vide", () => {
    const r = parseImport("");
    expect(r.ok).toBe(false);
  });

  it("rejette un CSV avec uniquement un header", () => {
    const r = parseImport("name,url,password");
    expect(r.ok).toBe(false);
  });

  it("clamp à 200 chars sur le nom", () => {
    const longName = "x".repeat(500);
    const csv = `name,url,username,password\n${longName},,,`;
    const r = parseImport(csv);
    if (!r.ok) throw new Error(r.error);
    expect(r.entries[0].name.length).toBe(200);
  });
});
