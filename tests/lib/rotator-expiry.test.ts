// §2.23 — la rotation d'une clé Gateway perdait `expiresAt` (clé neuve née « jamais
// expirée »). deriveRotatedExpiry re-dérive `now + TTL` (TTL = durée de vie initiale)
// au lieu de recopier la date d'origine (qui pourrait être dépassée → clé née expirée).

import { describe, it, expect } from "vitest";
import { deriveRotatedExpiry } from "@/lib/rotators/expiry";

const DAY = 86_400_000;

describe("deriveRotatedExpiry (§2.23)", () => {
  it("une clé sans expiration reste sans expiration", () => {
    const now = new Date("2026-07-21T12:00:00Z");
    expect(deriveRotatedExpiry(null, new Date("2026-01-01"), now)).toBeNull();
  });

  it("re-dérive now + TTL (TTL = expiresAt - createdAt), pas la date d'origine", () => {
    const created = new Date("2026-01-01T00:00:00Z");
    const oldExpiry = new Date(created.getTime() + 30 * DAY); // TTL = 30 j
    const now = new Date("2026-06-01T00:00:00Z"); // bien après l'expiry d'origine
    const result = deriveRotatedExpiry(oldExpiry, created, now)!;
    // La date d'origine (fin janvier) est dépassée : on ne la recopie pas.
    expect(result.getTime()).toBe(now.getTime() + 30 * DAY);
    expect(result.getTime()).toBeGreaterThan(now.getTime());
  });

  it("l'expiration re-dérivée est TOUJOURS dans le futur, même si l'ancienne clé était déjà expirée", () => {
    const created = new Date("2020-01-01T00:00:00Z");
    const oldExpiry = new Date(created.getTime() + 7 * DAY); // expirée depuis des années
    const now = new Date("2026-07-21T00:00:00Z");
    const result = deriveRotatedExpiry(oldExpiry, created, now)!;
    expect(result.getTime()).toBeGreaterThan(now.getTime());
    expect(result.getTime()).toBe(now.getTime() + 7 * DAY);
  });

  it("préserve la durée de vie exacte (au jour près) sur un TTL long", () => {
    const created = new Date("2026-03-15T09:30:00Z");
    const oldExpiry = new Date(created.getTime() + 365 * DAY);
    const now = new Date("2026-09-01T00:00:00Z");
    const result = deriveRotatedExpiry(oldExpiry, created, now)!;
    expect(result.getTime() - now.getTime()).toBe(365 * DAY);
  });
});
