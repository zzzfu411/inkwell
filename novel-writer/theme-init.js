/* Apply the saved theme before first paint without requiring inline script. */
(() => {
  try {
    const raw = localStorage.getItem("mogao_novel_cfg_v1");
    let theme = "soft-paper";
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg?.theme) theme = cfg.theme;
    }
    document.documentElement.setAttribute("data-theme", theme);
    const colorScheme = document.querySelector('meta[name="color-scheme"]');
    colorScheme?.setAttribute("content", theme === "ink-night" ? "dark" : "light");
  } catch (_) {
    document.documentElement.setAttribute("data-theme", "soft-paper");
  }
})();
