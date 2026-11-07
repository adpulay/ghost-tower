import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPolice, checkRegistrar, draftReport, warningTemplate } from "../tools/draft_report/index.js";
import { renderPrompt } from "../tools/draft_report/prompts.js";
import { validateWarning } from "../tools/send_warning.js";
import { urlHash } from "../src/knownDomains.js";
import type { ChatModel, ChatResponse } from "../src/llm/types.js";
import { MemoryWorld } from "../src/world/memory.js";
import type { Track } from "../src/types.js";

const NOW = Date.UTC(2026, 10, 8, 16, 0, 0);
const DOMAIN = "txtag-pay-demo.example"; // in config/known_domains.json
const TRACK: Track = {
  id: 7, lat: 32.9858, lon: -96.77, heading_deg: 90, speed_mps: 11, confidence: 0.9,
  event_count: 12, status: "active", campaign_id: 0, updated_ms: NOW,
};

async function world() {
  const w = new MemoryWorld(() => NOW);
  w.driverUpsertTrack(TRACK);
  await w.agentLinkCampaign(7, urlHash(DOMAIN), "TxTag", 2);
  await w.agentSetPrediction({
    track_id: 7, path_json: "[]", intercept_lat: 32.9858, intercept_lon: -96.76, eta_s: 75, updated_ms: NOW,
  });
  return w;
}

/** A model that returns fixed text, recording the prompt it was given. */
function model(text: string | (() => never), seen: string[] = []): ChatModel {
  return {
    name: "fake",
    async chat(messages): Promise<ChatResponse> {
      seen.push(String(messages[0].content));
      if (typeof text === "function") text();
      return { content: text as string, tool_calls: [] };
    },
  };
}
const down = model(() => {
  throw new Error("model down");
});

test("warning: valid model output passes through", async () => {
  const msg = "Fake cell tower near Campbell Rd. Texts claiming to be TxTag are scams. Don't tap links.";
  const out = await draftReport({ track_id: 7, kind: "warning" }, { world: await world(), llm: model(msg) });
  assert.equal(out.text, msg);
});

test("warning: surrounding quotes from the model are stripped", async () => {
  const out = await draftReport({ track_id: 7, kind: "warning" }, { world: await world(), llm: model('"Fake tower near Campbell Rd. TxTag texts are scams."') });
  assert.equal(out.text, "Fake tower near Campbell Rd. TxTag texts are scams.");
});

test("warning: >160 chars falls back to the template", async () => {
  const out = await draftReport({ track_id: 7, kind: "warning" }, { world: await world(), llm: model("x".repeat(200)) });
  assert.equal(validateWarning(out.text), null);
  assert.match(out.text, /TxTag/);
});

test("warning: URL or bare domain falls back to the template", async () => {
  for (const bad of ["Scam TxTag texts nearby, see https://txtag.org/real", "Do not visit txtag-pay-now.com, it is a scam."]) {
    const out = await draftReport({ track_id: 7, kind: "warning" }, { world: await world(), llm: model(bad) });
    assert.equal(validateWarning(out.text), null, out.text);
    assert.doesNotMatch(out.text, /http|\.com/);
  }
});

test("warning: always ≤160 chars and link-free across 20 runs of mixed failures", async () => {
  const w = await world();
  const outputs = ["y".repeat(300), "see www.evil.top now", "", "ok. TxTag texts nearby are scams. Do not tap links."];
  for (let i = 0; i < 20; i++) {
    const llm = i % 5 === 4 ? down : model(outputs[i % outputs.length]);
    const out = await draftReport({ track_id: 7, kind: "warning" }, { world: w, llm });
    assert.equal(validateWarning(out.text), null, out.text);
  }
});

test("no model: fixed templates, warning still valid", async () => {
  const out = await draftReport({ track_id: 7, kind: "warning" }, { world: await world() });
  assert.equal(out.text, warningTemplate("TxTag", "Campbell Rd, Richardson"));
});

test("police: model output with >5 lines falls back; fallback has the key facts", async () => {
  const out = await draftReport({ track_id: 7, kind: "police" }, { world: await world(), llm: model("a\nb\nc\nd\ne\nf\ng") });
  assert.ok(out.text.split("\n").length <= 5);
  for (const needle of ["32.9858", "east", "32.9858, -96.7600", "TxTag"]) assert.ok(out.text.includes(needle), `missing ${needle}`);
});

test("police: valid 5-line model output passes through", async () => {
  const brief = "Track 7 east at 25 mph\n32.9858, -96.77\nIntercept 32.9858, -96.76 in 75 s\nTxTag lure\nDomain 2 days old";
  const out = await draftReport({ track_id: 7, kind: "police" }, { world: await world(), llm: model(brief) });
  assert.equal(out.text, brief);
  assert.equal(checkPolice(brief), null);
});

test("registrar: fallback names domain and brand; model output missing the domain is rejected", async () => {
  const bad = await draftReport({ track_id: 7, kind: "registrar" }, { world: await world(), llm: model("Please act on this TxTag scam.") });
  assert.match(bad.text, new RegExp(DOMAIN.replace(/\./g, "\\.")));
  assert.match(bad.text, /suspension/);
  const good = `We report ${DOMAIN}, impersonating TxTag, first seen 2026-11-08. We request suspension.`;
  const ok = await draftReport({ track_id: 7, kind: "registrar" }, { world: await world(), llm: model(good) });
  assert.equal(ok.text, good);
  assert.equal(checkRegistrar(good, { domain: DOMAIN, brand: "TxTag", domainKnown: true }), null);
});

test("model failure falls back and is logged", async () => {
  const logs: Record<string, unknown>[] = [];
  const out = await draftReport({ track_id: 7, kind: "police" }, { world: await world(), llm: down, log: (e) => logs.push(e) });
  assert.match(out.text, /32\.9858/);
  assert.equal(logs[0].fallback, true);
});

test("slow model hits the timeout and falls back", async () => {
  const slow: ChatModel = { name: "slow", chat: () => new Promise(() => {}) };
  const out = await draftReport({ track_id: 7, kind: "warning" }, { world: await world(), llm: slow, timeoutMs: 30 });
  assert.equal(validateWarning(out.text), null);
});

test("prompts: every kind renders with real facts and no placeholders left", async () => {
  const seen: string[] = [];
  for (const kind of ["warning", "police", "registrar"] as const) {
    await draftReport({ track_id: 7, kind }, { world: await world(), llm: model("x", seen) });
  }
  assert.equal(seen.length, 3);
  for (const p of seen) assert.doesNotMatch(p, /\{\w+\}/);
  assert.match(seen[1], /32\.9858/);
  assert.match(seen[2], new RegExp(DOMAIN.replace(/\./g, "\\.")));
});

test("prompts: missing value throws instead of shipping a hole", () => {
  assert.throws(() => renderPrompt("warning", {} as never), /no value for/);
});

test("unknown kind is rejected", async () => {
  const w = await world();
  await assert.rejects(() => draftReport({ track_id: 7, kind: "tweet" as never }, { world: w }), /kind must be/);
});
