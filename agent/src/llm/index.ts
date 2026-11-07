import { llmConfig } from "../config.js";
import { MockPolicy } from "./mockPolicy.js";
import { NemotronClient } from "./nemotron.js";
import type { ChatModel } from "./types.js";

/** NEMOTRON_PROVIDER=brev|hosted|mock — the single switch between Brev, hosted and offline. */
export function createModel(env = process.env): ChatModel {
  const cfg = llmConfig(env);
  return cfg.provider === "mock" ? new MockPolicy() : new NemotronClient(cfg);
}

export * from "./types.js";
