import { domainByName, isReservedTestDomain, normalizeDomain } from "../src/knownDomains.js";
import type { ToolDef } from "./types.js";

export interface RdapOutput {
  domain: string;
  created: string | null;
  age_days: number;
}

const DAY = 86_400_000;

export interface RdapDeps {
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * INTERFACES.md §7 rdap_domain_age.
 *
 * Safety policy (TESTING.md §2d): we NEVER query or visit a real live phishing domain.
 *   - Reserved test TLDs (*.example etc.) → canned answer (demo scam domains: "created N days ago").
 *   - Domains on the benign allowlist (config/known_domains.json) → live public RDAP lookup.
 *   - Anything else → not looked up; returns created=null, age_days=-1.
 * Every decision is logged so the safety check can be audited.
 */
export async function rdapDomainAge(input: { domain: string }, deps: RdapDeps = {}): Promise<RdapOutput> {
  const now = deps.now ?? Date.now;
  const domain = normalizeDomain(input.domain ?? "");
  const known = domainByName(domain);

  if (isReservedTestDomain(domain)) {
    const age = known?.canned_age_days ?? 2;
    deps.log?.({ tool: "rdap_domain_age", domain, mode: "canned" });
    return { domain, created: new Date(now() - age * DAY).toISOString(), age_days: age };
  }

  if (known?.kind !== "benign") {
    deps.log?.({ tool: "rdap_domain_age", domain, mode: "refused-not-allowlisted" });
    return { domain, created: null, age_days: -1 };
  }

  deps.log?.({ tool: "rdap_domain_age", domain, mode: "live-rdap" });
  try {
    const f = deps.fetchImpl ?? fetch;
    const res = await f(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: "application/rdap+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { domain, created: null, age_days: -1 };
    const body = (await res.json()) as { events?: { eventAction: string; eventDate: string }[] };
    const reg = body.events?.find((e) => e.eventAction === "registration");
    if (!reg) return { domain, created: null, age_days: -1 };
    const created = new Date(reg.eventDate);
    return { domain, created: created.toISOString(), age_days: Math.floor((now() - created.getTime()) / DAY) };
  } catch {
    return { domain, created: null, age_days: -1 };
  }
}

export const rdapDomainAgeTool: ToolDef<{ domain: string }, RdapOutput> = {
  name: "rdap_domain_age",
  description:
    "Look up when a link domain was registered (public RDAP). Fictional demo domains return canned data; unknown domains are not looked up.",
  parameters: {
    type: "object",
    properties: { domain: { type: "string", description: "Link domain, e.g. txtag-pay-demo.example" } },
    required: ["domain"],
  },
  run: (input, ctx) => rdapDomainAge(input, { now: ctx.now, log: ctx.log }),
  summarize(out) {
    if (out.age_days < 0) return `Domain ${out.domain}: registration date unknown.`;
    if (out.age_days <= 30) return `Domain ${out.domain} was registered ${out.age_days} day${out.age_days === 1 ? "" : "s"} ago, a typical throwaway lure.`;
    return `Domain ${out.domain} was registered ${out.age_days} days ago.`;
  },
};
