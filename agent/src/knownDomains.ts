import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export type DomainKind = "demo-scam" | "benign";
export interface KnownDomain {
  domain: string;
  kind: DomainKind;
  brand: string;
  canned_age_days?: number;
  url_hash: string;
}

/**
 * Normalization shared with classifier/features.py and the simulator:
 * lowercase, strip scheme/path/port, strip leading "www.", strip trailing dot.
 */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");
  d = d.split(/[/?#]/)[0];
  d = d.replace(/:\d+$/, "");
  d = d.replace(/^www\./, "");
  d = d.replace(/\.$/, "");
  return d;
}

export function urlHash(domain: string): string {
  return createHash("sha256").update(normalizeDomain(domain)).digest("hex");
}

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(resolve(here, "../config/known_domains.json"), "utf8")) as {
  domains: Omit<KnownDomain, "url_hash">[];
};

export const KNOWN_DOMAINS: KnownDomain[] = raw.domains.map((d) => ({
  ...d,
  domain: normalizeDomain(d.domain),
  url_hash: urlHash(d.domain),
}));

export function domainByHash(hash: string): KnownDomain | undefined {
  return KNOWN_DOMAINS.find((d) => d.url_hash === hash);
}

export function domainByName(name: string): KnownDomain | undefined {
  const n = normalizeDomain(name);
  return KNOWN_DOMAINS.find((d) => d.domain === n);
}

/** Reserved test TLDs (RFC 2606 / 6761). Never resolvable, always canned. */
export function isReservedTestDomain(name: string): boolean {
  return /\.(example|test|invalid|localhost)$/.test(normalizeDomain(name));
}
