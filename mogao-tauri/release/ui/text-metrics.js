/**
 * 正文计量：CJK 基本区字符数 + [A-Za-z0-9]+ 连续段数。
 *
 * 与历史正则 words() 逐 UTF-16 代码单元等价：不扫 CJK 扩展区，
 * 不合并代理对。扩展区或按码点计数会改用户已经看到的字数。
 */
(function () {
  "use strict";

  function countWords(text) {
    const s = text || "";
    let cjk = 0;
    let runs = 0;
    let inRun = false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x4e00 && c <= 0x9fff) {
        cjk += 1;
        inRun = false;
        continue;
      }
      const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      if (alnum) {
        if (!inRun) {
          runs += 1;
          inRun = true;
        }
      } else {
        inRun = false;
      }
    }
    return cjk + runs;
  }

  window.NOVEL_TEXT_METRICS = {
    countWords,
  };
})();
