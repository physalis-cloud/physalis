import { describe, it, expect } from "vitest";
import {
  encodeEnvelope,
  decodeEnvelope,
  encodedByteLength,
  ENVELOPE_VERSION,
  type ShareItem,
} from "@/lib/share-envelope";

describe("share-envelope", () => {
  it("encode produit une enveloppe versionnee", () => {
    const items: ShareItem[] = [{ type: "text", content: "hello" }];
    const json = JSON.parse(encodeEnvelope(items));
    expect(json.v).toBe(ENVELOPE_VERSION);
    expect(json.items).toEqual(items);
  });

  it("round-trip encode → decode preserve les items (texte + fichier)", () => {
    const items: ShareItem[] = [
      { type: "text", title: "DB", content: "postgres://..." },
      { type: "text", content: "no title" },
      { type: "file", filename: "app.env", content: "KEY=value\n" },
    ];
    expect(decodeEnvelope(encodeEnvelope(items))).toEqual(items);
  });

  it("retro-compat : une string brute (ancien format) devient un item texte", () => {
    const legacy = "un vieux secret en clair";
    expect(decodeEnvelope(legacy)).toEqual([
      { type: "text", content: legacy },
    ]);
  });

  it("retro-compat : un JSON quelconque non conforme tombe en item texte", () => {
    const notEnvelope = JSON.stringify({ foo: "bar" });
    expect(decodeEnvelope(notEnvelope)).toEqual([
      { type: "text", content: notEnvelope },
    ]);
  });

  it("decode filtre les items malformes de l'enveloppe", () => {
    const raw = JSON.stringify({
      v: ENVELOPE_VERSION,
      items: [
        { type: "text", content: "ok" },
        { type: "text" }, // pas de content → rejete
        { type: "file", filename: "a.txt" }, // pas de content → rejete
        { type: "file", content: "x" }, // pas de filename → rejete
        { type: "bogus", content: "x" }, // type inconnu → rejete
      ],
    });
    expect(decodeEnvelope(raw)).toEqual([{ type: "text", content: "ok" }]);
  });

  it("decode d'une version inconnue tombe en fallback texte", () => {
    const future = JSON.stringify({ v: 999, items: [{ type: "text", content: "x" }] });
    expect(decodeEnvelope(future)).toEqual([{ type: "text", content: future }]);
  });

  it("encodedByteLength mesure le plaintext UTF-8 chiffre", () => {
    const items: ShareItem[] = [{ type: "text", content: "é" }]; // 2 octets UTF-8
    expect(encodedByteLength(items)).toBe(
      new TextEncoder().encode(encodeEnvelope(items)).length,
    );
  });
});
