import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Display strings substituted into prompts/<kind>.txt as {name}. */
export interface PromptFacts {
  track_id: number;
  brand: string;
  area: string;
  lat: string;
  lon: string;
  heading_deg: string;
  heading_name: string;
  speed_mph: string;
  intercept: string;
  eta_s: string | number;
  domain: string;
  domain_age: string;
  first_seen: string;
  evidence: string;
}

const cache = new Map<string, string>();

/** Fill prompts/<kind>.txt. Throws if a {placeholder} has no value, so a typo can't ship. */
export function renderPrompt(kind: string, facts: PromptFacts): string {
  let tpl = cache.get(kind);
  if (tpl === undefined) {
    tpl = readFileSync(resolve(here, "prompts", `${kind}.txt`), "utf8");
    cache.set(kind, tpl);
  }
  const values = facts as unknown as Record<string, string | number>;
  return tpl.replace(/\{(\w+)\}/g, (_m, key: string) => {
    if (!(key in values)) throw new Error(`prompt ${kind}: no value for {${key}}`);
    return String(values[key]);
  });
}
