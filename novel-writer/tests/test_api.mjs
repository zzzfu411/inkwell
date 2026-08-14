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
  TextDecoder,
  setTimeout,
  clearTimeout,
  fetch: async (...args) => {
    requests.push(args);
    return fetchImpl(...args);
  },
};
vm.runInNewContext(fs.readFileSync(path.join(root, "api.js"), "utf8"), sandbox);
const API = sandbox.window.NOVEL_API;

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
  outputTokens: 4096.9,
  messages: [{ role: "user", content: "test" }],
});
assert.equal(nonStream.content, "甲乙", "content-part arrays are normalized");
assert.equal(JSON.parse(requests.at(-1)[1].body).max_tokens, 4096, "output budget reaches the API body");

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

console.log("test_api: OK");
