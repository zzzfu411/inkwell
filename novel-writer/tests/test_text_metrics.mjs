/**
 * words() 零分配改写必须与旧正则逐字符等价。
 * 旧实现内联为 oracle：扩展区、代理对、随机串都不能和历史显示对不上。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "text-metrics.js"), "utf8");
assert.match(source, /charCodeAt/, "countWords must walk UTF-16 units");
assert.match(source, /for \(let i = 0; i < s\.length; i\+\+\)/);
assert.doesNotMatch(source, /\.match\(/, "zero-alloc rewrite must not allocate match arrays");
assert.doesNotMatch(source, /document\.|getElementById|innerHTML/, "text-metrics.js must stay DOM-free");

const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { filename: path.join(root, "text-metrics.js") });
const countWords = sandbox.window.NOVEL_TEXT_METRICS.countWords;
assert.equal(typeof countWords, "function");

function oracle(text) {
  const s = text || "";
  return (s.match(/[\u4e00-\u9fff]/g) || []).length + (s.match(/[A-Za-z0-9]+/g) || []).length;
}

function eq(label, text) {
  assert.equal(countWords(text), oracle(text), label);
}

eq("empty", "");
eq("nullish", null);
eq("undefined", undefined);
eq("pure cjk", "林玄在午夜前抵达旧站");
eq("pure latin", "Hello world 123");
eq("mixed", "林玄Hello旧站42");
eq("punctuation", "你好，世界！……——「钟声」。");
eq("emoji surrogate", "林玄😀👍旧站");
eq("cjk ext-a excluded", "\u3400林玄");
eq("cjk ext-b surrogate excluded", "林玄\u{20000}旧站");
eq("bmp bounds", "\u4dff\u4e00\u9fff\ua000");
eq("alnum interrupted by cjk", "ab中cd");
eq("cjk interrupted by alnum", "中a中");
eq("long cjk", "字".repeat(3000));
eq("long latin", `${"word".repeat(400)} 99`);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(0x4e00);
const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
for (let round = 0; round < 64; round++) {
  const n = 80 + Math.floor(rnd() * 240);
  let s = "";
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.28) s += String.fromCharCode(0x4e00 + Math.floor(rnd() * 0x51ff));
    else if (r < 0.48) s += alphabet[Math.floor(rnd() * alphabet.length)];
    else if (r < 0.58) s += String.fromCharCode(0xd800 + Math.floor(rnd() * 0x400)) + String.fromCharCode(0xdc00 + Math.floor(rnd() * 0x400));
    else if (r < 0.66) s += String.fromCodePoint(0x20000 + Math.floor(rnd() * 0x100));
    else s += String.fromCharCode(Math.floor(rnd() * 0x10000));
  }
  eq(`fuzz ${round}`, s);
}

console.log("test_text_metrics: OK");
