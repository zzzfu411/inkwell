/** OpenAI 兼容调用封装（流式/非流式），适配网页反代。 */
window.NOVEL_API = (() => {
  function normalizeBaseUrl(url) {
    let u = (url || "").trim().replace(/\/+$/, "");
    if (!u) throw new Error("请先在设置中填写模型服务地址（OpenAI 兼容 Base URL）");
    if (!/\/v1$/i.test(u)) u += "/v1";
    return u;
  }

  function extractJson(text) {
    if (!text) throw new Error("空响应");
    let t = text.trim();
    // strip markdown fence if model ignores instruction
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
    return JSON.parse(t);
  }

  function normalizeContent(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .join("");
  }

  function requestBody(opts) {
    const body = {
      model: opts.model || "gemini-3.6-flash",
      stream: !!opts.stream,
      messages: opts.messages,
    };
    const outputTokens = Number(opts.outputTokens);
    if (Number.isFinite(outputTokens) && outputTokens > 0) {
      body.max_tokens = Math.floor(outputTokens);
    }
    const temperature = Number(opts.temperature);
    if (Number.isFinite(temperature)) body.temperature = temperature;
    const seed = Number(opts.seed);
    if (Number.isInteger(seed)) body.seed = seed;
    return body;
  }

  function contentHash(value) {
    let hash = 2166136261;
    const source = String(value || "");
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a_${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function auditHook(name, event) {
    try {
      return window.NOVEL_MODEL_AUDIT?.[name]?.(event);
    } catch (error) {
      console.warn?.(`模型审计钩子 ${name} 失败：${error?.message || error}`);
      return undefined;
    }
  }

  function runtimeObserver() {
    return window.NOVEL_OBSERVABILITY || null;
  }

  function outputTruncatedError(partialContent) {
    const err = new Error(
      "上游因输出 token 上限停止生成；已保留当前正文，请提高“输出 token 预算”后继续写作。"
    );
    err.code = "OUTPUT_TRUNCATED";
    err.partialContent = partialContent || "";
    return err;
  }

  function abortableDelay(ms, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
    if (!ms) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const aborted = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        reject(signal.reason || new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, ms);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  function retryDelayMs(res, attempt) {
    const raw = res.headers?.get?.("retry-after");
    if (raw != null && String(raw).trim() !== "") {
      const text = String(raw).trim();
      const delay = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - Date.now();
      if (Number.isFinite(delay) && delay >= 0) return Math.min(delay, 60000);
    }
    return Math.min(400 * 2 ** attempt, 2000);
  }

  const TIMEOUTS = Object.freeze({ timeoutMs: 180000, firstByteTimeoutMs: 45000, idleTimeoutMs: 30000 });

  function requestLifetime(opts) {
    const controller = new AbortController();
    const limit = (key) => {
      const value = Number(opts[key]);
      return Number.isFinite(value) && value > 0 ? Math.min(value, 1800000) : TIMEOUTS[key];
    };
    const cancel = (reason) => { if (!controller.signal.aborted) controller.abort(reason); };
    const onParentAbort = () => cancel(opts.signal.reason || new DOMException("Aborted", "AbortError"));
    let phaseTimer;
    const timeout = (code, label) => {
      const error = new Error(`${label}超时，已停止等待；当前输出已保留，可重试。`);
      error.code = code;
      cancel(error);
    };
    const totalTimer = setTimeout(() => timeout("MODEL_TOTAL_TIMEOUT", "模型调用总时限"), limit("timeoutMs"));
    function armPhase(code, label, ms) {
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => timeout(code, label), ms);
    }
    armPhase("MODEL_FIRST_BYTE_TIMEOUT", "模型首响应", limit("firstByteTimeoutMs"));
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {});
    opts.signal?.addEventListener("abort", onParentAbort, { once: true });
    if (opts.signal?.aborted) onParentAbort();
    return {
      signal: controller.signal,
      wait(operation) {
        return Promise.race([operation, aborted]);
      },
      activity() { armPhase("MODEL_IDLE_TIMEOUT", "模型流空闲", limit("idleTimeoutMs")); },
      dispose() {
        clearTimeout(totalTimer);
        clearTimeout(phaseTimer);
        opts.signal?.removeEventListener("abort", onParentAbort);
        controller.signal.removeEventListener("abort", onAbort);
      },
    };
  }

  function assertCompletion(reason, content, done = false) {
    if (reason === "length") throw outputTruncatedError(content);
    if (reason === "stop" || (!reason && done)) return;
    const error = new Error(reason === "content_filter"
      ? "上游因内容过滤停止生成，当前输出尚未完成。"
      : `模型响应未正常完成${reason ? `（${reason}）` : "（连接提前结束）"}。`);
    error.code = reason === "content_filter" ? "OUTPUT_FILTERED" : "OUTPUT_INCOMPLETE";
    error.partialContent = content || "";
    error.finishReason = reason || "";
    throw error;
  }

  async function fetchWithRetry(url, init, opts) {
    const retryable = new Set([429, 502, 503, 504]);
    const retries = Math.max(0, Math.min(4, Number.isFinite(Number(opts.retries)) ? Number(opts.retries) : 2));
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(url, init);
      if (!retryable.has(res.status) || attempt >= retries) return res;
      await res.body?.cancel?.().catch?.(() => {});
      await abortableDelay(retryDelayMs(res, attempt), opts.signal);
    }
  }

  /**
   * @param {{ baseUrl, apiKey, model, messages, stream, signal, onDelta }} opts
   */
  function friendlyFetchError(err, url) {
    const msg = err?.message || String(err);
    if (err?.name === "AbortError") throw err;
    // 浏览器跨域失败时原生只有 "Failed to fetch"，几乎无信息
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) {
      throw new Error(
        `网络请求失败（${msg}）\n` +
          `目标: ${url}\n` +
          `常见原因：\n` +
          `1) 跨域 CORS 预检被拒（API 对 OPTIONS 要求 Key → 浏览器报 Failed to fetch）\n` +
          `2) baseUrl / API Key 错误，或 gemini 服务不可达\n` +
          `3) 本地用 file:// 打开页面（请用 start.bat / http 服务）\n` +
          `请先点 ⚙ 设置 → 测试连接。`
      );
    }
    throw err instanceof Error ? err : new Error(msg);
  }

  async function performChat(opts, lifetime) {
    const base = normalizeBaseUrl(opts.baseUrl);
    const url = `${base}/chat/completions`;
    let res;
    try {
      if (opts.signal.aborted) throw opts.signal.reason;
      res = await lifetime.wait(fetchWithRetry(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody(opts)),
        signal: opts.signal,
      }, opts));
    } catch (e) {
      friendlyFetchError(e, url);
    }
    if (!res.ok) {
      const errText = await lifetime.wait(res.text());
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
    if (!opts.stream) {
      const data = await lifetime.wait(res.json());
      const choice = data?.choices?.[0];
      const content = normalizeContent(choice?.message?.content);
      assertCompletion(choice?.finish_reason, content);
      if (!content) throw new Error("上游返回空 content");
      return { content, raw: data };
    }
    if (!res.body?.getReader) throw new Error("上游未返回可读取的流式响应体");
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let full = "";
    let finishReason = "";
    let receivedDone = false;

    function consumeEvent(rawEvent) {
      const data = rawEvent
        .split("\n")
        .filter((line) => line.trimStart().startsWith("data:"))
        .map((line) => line.slice(line.indexOf("data:") + 5).trimStart())
        .join("\n")
        .trim();
      if (!data) return;
      if (data === "[DONE]") { receivedDone = true; return; }
      let json;
      try {
        json = JSON.parse(data);
      } catch (e) {
        throw new Error(`无法解析上游 SSE 数据: ${e.message}`, { cause: e });
      }
      if (json?.error) {
        throw new Error(json.error.message || JSON.stringify(json.error));
      }
      const choice = json?.choices?.[0];
      finishReason = choice?.finish_reason || finishReason;
      const delta = normalizeContent(choice?.delta?.content);
      if (delta) {
        full += delta;
        opts.onDelta?.(delta, full);
      }
    }

    function consumeBufferedEvents(flush = false) {
      buffer = buffer.replace(/\r\n?/g, "\n");
      const events = buffer.split("\n\n");
      buffer = flush ? "" : events.pop() || "";
      if (flush && events.at(-1) === "") events.pop();
      for (const event of events) consumeEvent(event);
      if (flush && buffer.trim()) consumeEvent(buffer);
    }

    try {
      while (true) {
        const { done, value } = await lifetime.wait(reader.read());
        if (done) break;
        if (value?.length) lifetime.activity();
        buffer += decoder.decode(value, { stream: true });
        consumeBufferedEvents();
        if (receivedDone || finishReason) break;
      }
      buffer += decoder.decode();
      consumeBufferedEvents(true);
      assertCompletion(finishReason, full, receivedDone);
      if (!full) throw new Error("流式结束但无内容（可能被网页端空帧）");
      return { content: full, finishReason: finishReason || "stop" };
    } catch (error) {
      error.partialContent = full;
      throw error;
    } finally {
      Promise.resolve(reader.cancel()).catch(() => {});
      reader.releaseLock();
    }
  }

  async function rawChat(opts) {
    const lifetime = requestLifetime(opts);
    try {
      return await performChat({ ...opts, signal: lifetime.signal }, lifetime);
    } finally {
      lifetime.dispose();
    }
  }

  async function chat(opts) {
    // 只在显式安装审计端口时记录；请求中绝不暴露凭据或 Authorization。
    const body = requestBody(opts);
    const observer = runtimeObserver();
    const startedAt = observer?.startTimer?.();
    const inputChars = (body.messages || []).reduce(
      (total, message) => total + String(message?.content || "").length,
      0
    );
    const auditId = auditHook("onRequest", {
      model: body.model,
      stream: body.stream,
      temperature: body.temperature ?? null,
      seed: body.seed ?? null,
      outputTokens: body.max_tokens ?? null,
      messages: (body.messages || []).map((message) => ({
        role: String(message?.role || ""),
        content: String(message?.content || ""),
      })),
    });
    try {
      const result = await rawChat(opts);
      const finishReason = result?.finishReason || result?.raw?.choices?.[0]?.finish_reason || "";
      auditHook("onResponse", {
        auditId,
        finishReason,
        contentHash: contentHash(result?.content),
        chars: String(result?.content || "").length,
        usage: result?.raw?.usage || null,
      });
      observer?.record?.("model", {
        stage: opts.diagnosticStage || "model-call",
        durationMs: observer.elapsedMs?.(startedAt) || 0,
        ok: true,
        model: body.model,
        stream: body.stream,
        requestCount: (body.messages || []).length,
        inputChars,
        outputChars: String(result?.content || "").length,
        finishReason,
        usage: result?.raw?.usage || null,
      });
      return result;
    } catch (error) {
      auditHook("onError", {
        auditId,
        code: error?.code || error?.name || "MODEL_ERROR",
        message: error?.message || String(error),
      });
      const classified = observer?.classifyError?.(error, {
        stage: opts.diagnosticStage || "model-call",
      });
      observer?.record?.("model", {
        stage: opts.diagnosticStage || "model-call",
        durationMs: observer.elapsedMs?.(startedAt) || 0,
        ok: false,
        model: body.model,
        stream: body.stream,
        requestCount: (body.messages || []).length,
        inputChars,
        outputChars: Math.max(0, String(error?.partialContent || "").length),
        finishReason: "error",
        code: classified?.code || error?.code || error?.name || "MODEL_ERROR",
        category: classified?.category || "model",
      });
      throw error;
    }
  }

  async function chatJson(opts) {
    const { content } = await chat({ ...opts, stream: false });
    try {
      return extractJson(content);
    } catch (e) {
      throw new Error("JSON 解析失败: " + e.message + "\n原文前 300 字: " + content.slice(0, 300), {
        cause: e,
      });
    }
  }

  return { chat, chatJson, normalizeBaseUrl, extractJson, normalizeContent, requestBody, TIMEOUTS, retryDelayMs };
})();
