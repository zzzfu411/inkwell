/**
 * Writing inspector helpers: beat plan editor and pace label.
 */
window.NOVEL_WRITE_UI = (() => {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderBeatPlan(host, plan, pace, coverage) {
    if (!host) return;
    const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
    const missing = new Set((coverage?.missing || []).map((item) => Number(item.index)));
    const hasCoverage = coverage && Number(coverage.total) > 0;
    const rows =
      scenes.length > 0
        ? scenes
            .map((scene, index) => {
              const klass = hasCoverage ? (missing.has(index) ? "beat-gap" : "beat-covered") : "";
              return `<li data-scene-index="${index}" class="${klass}">
          <label>地点<input type="text" data-beat-field="place" value="${escapeHtml(scene.place || "")}" /></label>
          <label>动作<input type="text" data-beat-field="action" value="${escapeHtml(scene.action || "")}" /></label>
          <label>转折<input type="text" data-beat-field="turn" value="${escapeHtml(scene.turn || "")}" /></label>
          <label>感官<input type="text" data-beat-field="sensory" value="${escapeHtml(scene.sensory || "")}" /></label>
        </li>`;
            })
            .join("")
        : `<li class="beat-empty">尚未铺细纲。生成前会按「${escapeHtml(pace?.label || "推进")}」自动规划，也可先点「重出细纲」。</li>`;
    host.innerHTML = rows;
  }

  function renderCraftHint(el, score) {
    if (!el) return;
    const coverage = score?.beatCoverage;
    if (!coverage || !coverage.total) return;
    const dialogue = Math.round((Number(score.dialogueRate) || 0) * 100);
    el.textContent = `场面落地 ${coverage.covered}/${coverage.total} · 对白 ${dialogue}%`;
  }

  function collectBeatPlan(host, base = {}) {
    if (!host) return window.NOVEL_CRAFT?.normalizeBeatPlan?.(base) || base;
    const scenes = [...host.querySelectorAll("[data-scene-index]")].map((row) => {
      const read = (name) => row.querySelector(`[data-beat-field="${name}"]`)?.value?.trim() || "";
      return {
        place: read("place"),
        action: read("action"),
        turn: read("turn"),
        sensory: read("sensory"),
      };
    }).filter((scene) => scene.place || scene.action);
    return (
      window.NOVEL_CRAFT?.normalizeBeatPlan?.({
        ...base,
        scenes,
      }) || { ...base, scenes }
    );
  }

  return { renderBeatPlan, collectBeatPlan, renderCraftHint };
})();
