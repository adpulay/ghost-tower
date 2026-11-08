// All runtime configuration comes from environment variables (see ../.env.example).
// Switching Brev <-> hosted Nemotron is the single variable NEMOTRON_PROVIDER.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Minimal .env loader so we don't need a dependency. Existing env vars win. */
export function loadDotEnv(path = resolve(process.cwd(), ".env")): void {
  for (const p of [path, resolve(process.cwd(), "..", ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    return;
  }
}

export type Provider = "brev" | "hosted" | "mock";

export interface LlmConfig {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export function llmConfig(env = process.env): LlmConfig {
  const provider = (env.NEMOTRON_PROVIDER ?? "brev") as Provider;
  const timeoutMs = Number(env.MODEL_TIMEOUT_MS ?? 20_000);
  if (provider === "hosted") {
    return {
      provider,
      baseUrl: env.HOSTED_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
      apiKey: env.HOSTED_API_KEY ?? "",
      model: env.HOSTED_MODEL ?? "nvidia/nemotron-3-nano-30b-a3b",
      timeoutMs,
    };
  }
  if (provider === "mock") {
    return { provider, baseUrl: "", apiKey: "", model: "mock-policy", timeoutMs };
  }
  return {
    provider: "brev",
    baseUrl: env.BREV_BASE_URL ?? "http://localhost:5000/v1",
    apiKey: env.BREV_API_KEY ?? "EMPTY",
    model: env.BREV_MODEL ?? "nemotron",
    timeoutMs,
  };
}

export interface SpacetimeConfig {
  host: string;
  database: string;
  token: string;
  pollMs: number;
}

export function spacetimeConfig(env = process.env): SpacetimeConfig {
  return {
    host: env.SPACETIME_HOST ?? "https://maincloud.spacetimedb.com",
    database: env.SPACETIME_DB ?? "ghost-tower-94144",
    token: env.SPACETIME_TOKEN ?? "",
    pollMs: Number(env.SPACETIME_POLL_MS ?? 1000),
  };
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string;
  verifiedNumbers: string[];
  /** When true (default unless creds are present), log instead of sending. */
  dryRun: boolean;
}

export function twilioConfig(env = process.env): TwilioConfig {
  const accountSid = env.TWILIO_ACCOUNT_SID ?? "";
  const authToken = env.TWILIO_AUTH_TOKEN ?? "";
  const from = env.TWILIO_FROM ?? "";
  const verifiedNumbers = (env.TWILIO_VERIFIED_NUMBERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const haveCreds = Boolean(accountSid && authToken && from && verifiedNumbers.length);
  const dryRun = env.TWILIO_DRY_RUN ? env.TWILIO_DRY_RUN === "1" : !haveCreds;
  return { accountSid, authToken, from, verifiedNumbers, dryRun };
}

export interface SimPhonesConfig {
  /** Simulated phone population used to count recipients inside a warning zone. */
  count: number;
  bbox: [number, number, number, number]; // [minLat, minLon, maxLat, maxLon]
  seed: string;
}

export function simPhonesConfig(env = process.env): SimPhonesConfig {
  const bbox = (env.SIM_PHONES_BBOX ?? "32.97,-96.78,33.00,-96.73").split(",").map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return { count: Number(env.SIM_PHONES ?? 300), bbox, seed: env.SIM_SEED ?? "demo-01" };
}
