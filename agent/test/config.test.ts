import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDotEnv } from "../src/config.js";

function load(content: string, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gt-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, content);
  for (const k of Object.keys(extraEnv)) process.env[k] = extraEnv[k];
  loadDotEnv(file);
}
const keys = ["GT_TEST_A", "GT_TEST_B", "GT_TEST_C", "GT_TEST_D", "GT_TEST_E", "GT_TEST_F", "GT_TEST_G"];
const clean = () => keys.forEach((k) => delete process.env[k]);

test("loadDotEnv: trailing spaces, CRLF and inline comments no longer corrupt values", () => {
  clean();
  load(
    [
      "GT_TEST_A=0  ",                                          // the NEMOTRON_THINKING case: trailing spaces
      "GT_TEST_B=playbook              # playbook (default): code runs the steps",
      "GT_TEST_C=https://host.example/v1 ",                      // the BREV_BASE_URL case
      "GT_TEST_D=\"quoted # not a comment\"",
      "GT_TEST_E=http://host/page#frag",                         // '#' without a space before it is part of the value
      "# a full-line comment",
      "GT_TEST_F=crlf\r",
    ].join("\r\n"),
  );
  assert.equal(process.env.GT_TEST_A, "0");
  assert.equal(process.env.GT_TEST_B, "playbook");
  assert.equal(process.env.GT_TEST_C, "https://host.example/v1");
  assert.equal(process.env.GT_TEST_D, "quoted # not a comment");
  assert.equal(process.env.GT_TEST_E, "http://host/page#frag");
  assert.equal(process.env.GT_TEST_F, "crlf");
  clean();
});

test("loadDotEnv: an existing environment variable still wins, and empty values stay empty", () => {
  clean();
  load("GT_TEST_G=from-file\nGT_TEST_A=\n", { GT_TEST_G: "from-shell" });
  assert.equal(process.env.GT_TEST_G, "from-shell");
  assert.equal(process.env.GT_TEST_A, "");
  clean();
});
