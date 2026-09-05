/** Browser adapter for failure presentation and secret-free diagnostics download. */
window.NOVEL_DIAGNOSTICS_UI = (() => {
  "use strict";

  function descriptor(error, category, failure) {
    const message = error?.message || String(error || "未知错误");
    if (category === "cancel") {
      return { log: "用户停止", status: ["已停止", "muted"], auto: "已停止" };
    }
    if (category === "retrieval") {
      return {
        warn: true,
        alert: message || "严格故事记忆策略未满足，已停止生成",
        log: `严格检索阻断: ${message}`,
        status: ["故事记忆未就绪 · 已停止生成", "err"],
        auto: "严格检索阻断",
        refreshWrite: true,
      };
    }
    if (category === "quality" && error?.code === "REVISION_FAILED") {
      return {
        warn: true,
        alert: `修订失败，原稿已保留。\n\n${message}`,
        log: `修订失败，原稿已保留: ${message}`,
        status: ["修订失败 · 原稿已保留", "err"],
        auto: "修订失败 · 原稿已保留",
      };
    }
    if (category === "quality") {
      return {
        warn: true,
        alert: `本章暂未通过质量闸门，正文已保留。\n\n${message}\n请根据检查器建议重试生产，或在设置中切换为宽松闸门。`,
        log: `质量闸门阻断: ${message}`,
        status: ["质量未通过 · 待修订", "err"],
        auto: "质量闸门阻断",
        refreshWrite: true,
      };
    }
    if (category === "plan") {
      return {
        alert: message || "章节规划或生产契约未完成",
        status: ["规划未完成 · 可安全重试", "err"],
        auto: "规划阶段失败",
      };
    }
    if (category === "handoff") {
      return {
        alert: `正文已保留，但章后交接未完成。\n\n${message}\n可重新执行“本章→摘要+关系”。`,
        status: ["正文已保留 · 待补交接", "err"],
        auto: "交接阶段失败",
        refreshWrite: true,
      };
    }
    if (category === "storage" || category === "conflict") {
      return {
        alert: message,
        vault: [category === "conflict" ? "存在磁盘版本冲突" : "安全存盘未完成", "err"],
        auto: category === "conflict" ? "等待冲突裁决" : "存盘失败",
      };
    }
    return {
      error: true,
      alert: message,
      log: failure
        ? `错误 ${failure.category}/${failure.code} @${failure.stage}`
        : `错误: ${message}`,
      status: ["失败", "err"],
      auto: "失败",
    };
  }

  function handleWriteFailure(error, category, failure, ports = {}) {
    const view = descriptor(error, category, failure);
    if (view.warn) ports.console?.warn?.(`${category} failure`, error);
    if (view.error) ports.console?.error?.(error);
    if (view.alert) ports.alert?.(view.alert);
    if (view.log) ports.log?.(view.log);
    if (view.status) ports.setStatus?.(...view.status);
    if (view.vault) ports.setVaultStatus?.(...view.vault);
    if (view.auto) ports.setAutoStatus?.(view.auto);
    if (view.refreshWrite) ports.refreshWrite?.();
    return view;
  }

  function failureContext(project) {
    const chapter = (project?.chapters || []).find((item) => item.id === project.activeChapterId);
    const task = (project?.tasks || []).find(
      (item) => item.id === project.activeTaskId || item.id === chapter?.taskId
    );
    return {
      project,
      chapter,
      task,
      stage: task?.lastErrorStage || chapter?.production?.stage || "write",
    };
  }

  function downloadText(content, filename, type) {
    const blob = new Blob([content], { type });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  function bindDiagnosticsExport({ button, getProject, syncEditor, setStatus, meta, alert: showAlert } = {}) {
    button?.addEventListener("click", () => {
      syncEditor?.();
      const report = window.NOVEL_OBSERVABILITY?.exportReport?.(getProject?.());
      if (!report) {
        showAlert?.("诊断模块尚未加载，请重新启动 Inkwell 后再试。");
        return;
      }
      downloadText(
        `${JSON.stringify(report, null, 2)}\n`,
        `inkwell-diagnostics-${Date.now()}.json`,
        "application/json;charset=utf-8"
      );
      if (meta) {
        meta.textContent = `已导出 ${report.summary.events} 条事件，其中 ${report.summary.failures} 次失败；报告已脱敏。`;
      }
      setStatus?.("脱敏诊断报告已导出", "");
    });
  }

  return { descriptor, handleWriteFailure, failureContext, downloadText, bindDiagnosticsExport };
})();
