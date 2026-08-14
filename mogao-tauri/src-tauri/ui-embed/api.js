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
    return body;
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
    if (!ms) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason || new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );
    });
  }

  function retryDelayMs(res, attempt) {
    const retryAfter = Number(res.headers?.get?.("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 5000);
    return Math.min(400 * 2 ** attempt, 2000);
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

  async function chat(opts) {
    const base = normalizeBaseUrl(opts.baseUrl);
    const url = `${base}/chat/completions`;
    let res;
    try {
      res = await fetchWithRetry(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody(opts)),
        signal: opts.signal,
      }, opts);
    } catch (e) {
      friendlyFetchError(e, url);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
    if (!opts.stream) {
      const data = await res.json();
      const choice = data?.choices?.[0];
      const content = normalizeContent(choice?.message?.content);
      if (choice?.finish_reason === "length") throw outputTruncatedError(content);
      if (!content) throw new Error("上游返回空 content");
      return { content, raw: data };
    }
    if (!res.body?.getReader) throw new Error("上游未返回可读取的流式响应体");
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let full = "";
    let finishReason = "";

    function consumeEvent(rawEvent) {
      const data = rawEvent
        .split("\n")
        .filter((line) => line.trimStart().startsWith("data:"))
        .map((line) => line.slice(line.indexOf("data:") + 5).trimStart())
        .join("\n")
        .trim();
      if (!data || data === "[DONE]") return;
      let json;
      try {
        json = JSON.parse(data);
      } catch (e) {
        throw new Error(`无法解析上游 SSE 数据: ${e.message}`);
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consumeBufferedEvents();
    }
    buffer += decoder.decode();
    consumeBufferedEvents(true);
    if (finishReason === "length") throw outputTruncatedError(full);
    if (!full) throw new Error("流式结束但无内容（可能被网页端空帧）");
    return { content: full, finishReason };
  }

  async function chatJson(opts) {
    const { content } = await chat({ ...opts, stream: false });
    try {
      return extractJson(content);
    } catch (e) {
      throw new Error("JSON 解析失败: " + e.message + "\n原文前 300 字: " + content.slice(0, 300));
    }
  }

  return { chat, chatJson, normalizeBaseUrl, extractJson, normalizeContent, requestBody };
})();
