import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const requests = [];
let fetchImpl = async () => {
  throw new Error("fetch mock was not configured");
};
const sandbox = {
  window: {},
  console,
  DOMException,
  AbortController,
  TextDecoder,
  setTimeout,
  clearTimeout,
  TextEncoder,
  fetch: async (...args) => {
    requests.push(args);
    return fetchImpl(...args);
  },
};
vm.runInNewContext(fs.readFileSync(path.join(root, "runtime-observability.js"), "utf8"), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(root, "api.js"), "utf8"), sandbox);
const API = sandbox.window.NOVEL_API;
const auditEvents = [];
sandbox.window.NOVEL_MODEL_AUDIT = {
  onRequest(event) {
    auditEvents.push({ type: "request", event });
    return `audit-${auditEvents.length}`;
  },
  onResponse(event) {
    auditEvents.push({ type: "response", event });
  },
  onError(event) {
    auditEvents.push({ type: "error", event });
  },
};

fetchImpl = async () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: { content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
const nonStream = await API.chat({
  baseUrl: "https://example.test/v1",
  apiKey: "secret",
  model: "gemini-3.6-flash",
  temperature: 0.35,
  seed: 260904,
  outputTokens: 4096.9,
  messages: [{ role: "user", content: "test" }],
});
assert.equal(nonStream.content, "甲乙", "content-part arrays are normalized");
const nonStreamBody = JSON.parse(requests.at(-1)[1].body);
assert.equal(nonStreamBody.max_tokens, 4096, "output budget reaches the API body");
assert.equal(nonStreamBody.temperature, 0.35, "temperature reaches the API body");
assert.equal(nonStreamBody.seed, 260904, "seed reaches the API body");
assert.equal(auditEvents[0].event.apiKey, undefined, "audit records never expose credentials");
assert.equal(auditEvents[0].event.messages[0].content, "test", "audit captures the reproducible prompt");
assert.match(auditEvents[1].event.contentHash, /^fnv1a_/);

const encoder = new TextEncoder();
function streamResponse(chunks) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

const deltas = [];
fetchImpl = async () =>
  streamResponse([
    'data: {"choices":[{"delta":{"content":"第一"}}]}\r',
    '\n\r\ndata: {"choices":[{"delta":{"content":[{"text":"段"}]},"finish_reason":"stop"}]}',
  ]);
const streamed = await API.chat({
  baseUrl: "https://example.test",
  apiKey: "secret",
  stream: true,
  messages: [],
  onDelta: (delta) => deltas.push(delta),
});
assert.equal(streamed.content, "第一段", "split CRLF chunks and an unterminated final event are consumed");
assert.deepEqual(deltas, ["第一", "段"]);

fetchImpl = async () =>
  streamResponse([
    'data: {"choices":[{"delta":{"content":"未完成正文"},"finish_reason":"length"}]}',
  ]);
await assert.rejects(
  API.chat({
    baseUrl: "https://example.test/v1",
    apiKey: "secret",
    stream: true,
    messages: [],
  }),
  (error) => error.code === "OUTPUT_TRUNCATED" && error.partialContent === "未完成正文"
);
assert.equal(auditEvents.at(-1).type, "error", "failed model calls reach the audit port");
assert.equal(auditEvents.at(-1).event.code, "OUTPUT_TRUNCATED");

let attempts = 0;
fetchImpl = async () => {
  attempts += 1;
  if (attempts === 1) {
    return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
  }
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "重试成功" } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};
const retried = await API.chat({
  baseUrl: "https://example.test/v1",
  apiKey: "secret",
  retries: 1,
  messages: [],
});
assert.equal(retried.content, "重试成功");
assert.equal(attempts, 2, "transient upstream status is retried");

const diagnostics = sandbox.window.NOVEL_OBSERVABILITY.exportReport();
const modelEvents = diagnostics.events.filter((event) => event.type === "model");
assert.equal(modelEvents.length, 4, "every model attempt records one safe runtime metric");
assert.equal(modelEvents[0].inputChars, 4);
assert.equal(modelEvents[0].outputChars, 2);
assert.equal(modelEvents[0].finishReason, "stop");
assert.equal(modelEvents[2].ok, false);
assert.equal(modelEvents[2].code, "OUTPUT_TRUNCATED");
const diagnosticJson = JSON.stringify(diagnostics);
assert.ok(!diagnosticJson.includes("secret"));
assert.ok(!diagnosticJson.includes('"messages"'));
assert.ok(!diagnosticJson.includes("test"), "model prompt content is excluded from runtime diagnostics");

console.log("test_api: OK");
