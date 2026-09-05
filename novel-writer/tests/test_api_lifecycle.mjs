import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

let now = 0;
let serial = 0;
const timers = new Map();
let fetchImpl;
const sandbox = {
  window: {}, console, AbortController, DOMException, TextDecoder,
  fetch: (...args) => fetchImpl(...args),
  setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
  clearTimeout: (id) => timers.delete(id),
};
vm.runInNewContext(fs.readFileSync(new URL("../api.js", import.meta.url), "utf8"), sandbox);
const API = sandbox.window.NOVEL_API;
const opts = { baseUrl: "http://model.test", messages: [], timeoutMs: 1000, firstByteTimeoutMs: 100, idleTimeoutMs: 50 };
async function drain() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
async function tick(ms) {
  const end = now + ms;
  while (true) {
    const next = [...timers].filter(([, row]) => row.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    now = next[1].at;
    timers.delete(next[0]);
    next[1].fn();
    await drain();
  }
  now = end;
  await drain();
}
const enc = new TextEncoder();
function stream(data, close = true, onCancel = () => {}) {
  return { ok: true, body: new ReadableStream({
    start(c) { if (data) c.enqueue(enc.encode(data)); if (close) c.close(); },
    cancel: onCancel,
  }) };
}

// Neither text alone nor a filtered answer is a completed generation.
fetchImpl = async () => stream('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
await assert.rejects(API.chat({ ...opts, stream: true }), (e) => e.code === "OUTPUT_INCOMPLETE" && e.partialContent === "partial");
fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: "filtered" }, finish_reason: "content_filter" }] }));
await assert.rejects(API.chat(opts), (e) => e.code === "OUTPUT_FILTERED" && e.partialContent === "filtered");
fetchImpl = async () => stream('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n', false);
assert.equal((await API.chat({ ...opts, stream: true })).content, "done");
assert.equal(timers.size, 0, "successful requests release every watchdog");

// Fetch implementations that fail to settle on abort must still release the caller.
let signal;
fetchImpl = (_url, init) => { signal = init.signal; return new Promise(() => {}); };
const firstByte = API.chat(opts);
const firstCheck = assert.rejects(firstByte, (e) => e.code === "MODEL_FIRST_BYTE_TIMEOUT");
await tick(100);
await firstCheck;
assert.equal(signal.aborted, true);
assert.equal(timers.size, 0);

let cancelled = 0;
fetchImpl = async () => stream('data: {"choices":[{"delta":{"content":"kept"}}]}\n\n', false, () => cancelled++);
const idle = API.chat({ ...opts, stream: true });
const idleCheck = assert.rejects(idle, (e) => e.code === "MODEL_IDLE_TIMEOUT" && e.partialContent === "kept");
await drain();
await tick(50);
await idleCheck;
assert.equal(cancelled, 1);
assert.equal(timers.size, 0);

// An active stream is still bounded by the total deadline.
const total = API.chat({ ...opts, stream: true, timeoutMs: 20 });
const totalCheck = assert.rejects(total, (e) => e.code === "MODEL_TOTAL_TIMEOUT" && e.partialContent === "kept");
await drain();
await tick(20);
await totalCheck;
assert.equal(timers.size, 0);

const cancel = new AbortController();
const aborted = API.chat({ ...opts, stream: true, signal: cancel.signal });
const abortCheck = assert.rejects(aborted, (e) => e.name === "AbortError" && e.partialContent === "kept");
await drain();
cancel.abort();
await abortCheck;
assert.equal(timers.size, 0);

let attempts = 0;
fetchImpl = async () => {
  attempts++;
  return attempts === 1 ? new Response("busy", { status: 429 }) : new Response(JSON.stringify({ choices: [{ message: { content: "retried" }, finish_reason: "stop" }] }));
};
const retry = API.chat({ ...opts, firstByteTimeoutMs: 900 });
await drain();
assert.equal(attempts, 1);
await tick(399);
assert.equal(attempts, 1, "missing Retry-After does not spin");
await tick(1);
assert.equal((await retry).content, "retried");
assert.equal(attempts, 2);
assert.equal(timers.size, 0);
assert.equal(API.retryDelayMs(new Response("", { headers: { "retry-after": "2" } }), 0), 2000);
assert.equal(API.retryDelayMs(new Response("", { headers: { "retry-after": "garbage" } }), 1), 800);
const dateDelay = API.retryDelayMs(new Response("", { headers: { "retry-after": new Date(Date.now() + 5000).toUTCString() } }), 0);
assert.ok(dateDelay > 3500 && dateDelay <= 5000);
console.log("test_api_lifecycle: OK");
