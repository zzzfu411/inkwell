//! Markdown → HTML 预览（pulldown-cmark）+ 简易消毒
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag};
use regex::Regex;
use std::sync::OnceLock;

/// 渲染 Markdown 为 HTML。
/// 启用：表格、删除线、任务列表、脚注、智能标点等。
/// 后处理：移除危险标签/协议与 on* 事件属性。
pub fn render_markdown(src: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);
    // 0.13 还支持这些；有则启用，提升预览质量
    options.insert(Options::ENABLE_SMART_PUNCTUATION);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);

    let parser = Parser::new_ext(src, options).filter_map(sanitize_markdown_event);
    let mut html_out = String::with_capacity(src.len().saturating_mul(3) / 2);
    html::push_html(&mut html_out, parser);
    sanitize_html(&html_out)
}

fn safe_destination(destination: &str) -> bool {
    let trimmed = destination.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return true;
    }
    let compact: String = trimmed
        .chars()
        .filter(|character| !character.is_ascii_control() && !character.is_ascii_whitespace())
        .collect();
    let lower = compact.to_ascii_lowercase();
    let colon = lower.find(':');
    let separator = lower.find(['/', '?', '#']).unwrap_or(usize::MAX);
    match colon {
        Some(index) if index < separator => {
            matches!(&lower[..index], "http" | "https" | "mailto")
        }
        _ => !lower.starts_with("//"),
    }
}

fn safe_url<'a>(destination: CowStr<'a>) -> CowStr<'a> {
    if safe_destination(&destination) {
        destination
    } else {
        CowStr::Borrowed("#")
    }
}

fn sanitize_markdown_event(event: Event<'_>) -> Option<Event<'_>> {
    match event {
        // Raw HTML is never required for a writing preview. Dropping the
        // parser event avoids regex-based tag parsing and all event attributes.
        Event::Html(_) | Event::InlineHtml(_) => None,
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => Some(Event::Start(Tag::Link {
            link_type,
            dest_url: safe_url(dest_url),
            title,
            id,
        })),
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => Some(Event::Start(Tag::Image {
            link_type,
            dest_url: safe_url(dest_url),
            title,
            id,
        })),
        other => Some(other),
    }
}

/// 简易 HTML 消毒：
/// - 去 script / iframe / object / embed / svg / link / meta / base 标签
/// - 去 on* 事件属性
/// - 将 href/src 中的 javascript: 协议中和
pub fn sanitize_html(html: &str) -> String {
    static RE_SCRIPT: OnceLock<Regex> = OnceLock::new();
    static RE_IFRAME: OnceLock<Regex> = OnceLock::new();
    static RE_OBJECT: OnceLock<Regex> = OnceLock::new();
    static RE_EMBED: OnceLock<Regex> = OnceLock::new();
    static RE_SVG: OnceLock<Regex> = OnceLock::new();
    static RE_LINK: OnceLock<Regex> = OnceLock::new();
    static RE_META: OnceLock<Regex> = OnceLock::new();
    static RE_BASE: OnceLock<Regex> = OnceLock::new();
    static RE_ON: OnceLock<Regex> = OnceLock::new();
    static RE_JS_HREF: OnceLock<Regex> = OnceLock::new();
    static RE_JS_SRC: OnceLock<Regex> = OnceLock::new();

    // regex crate 不支持 backref，分标签各写一条
    let re_script = RE_SCRIPT.get_or_init(|| {
        Regex::new(r"(?is)<\s*script\b[^>]*>.*?</\s*script\s*>|<\s*script\b[^>]*/?\s*>")
            .expect("script regex")
    });
    let re_iframe = RE_IFRAME.get_or_init(|| {
        Regex::new(r"(?is)<\s*iframe\b[^>]*>.*?</\s*iframe\s*>|<\s*iframe\b[^>]*/?\s*>")
            .expect("iframe regex")
    });
    let re_object = RE_OBJECT.get_or_init(|| {
        Regex::new(r"(?is)<\s*object\b[^>]*>.*?</\s*object\s*>|<\s*object\b[^>]*/?\s*>")
            .expect("object regex")
    });
    let re_embed = RE_EMBED.get_or_init(|| {
        Regex::new(r"(?is)<\s*embed\b[^>]*>.*?</\s*embed\s*>|<\s*embed\b[^>]*/?\s*>")
            .expect("embed regex")
    });
    // 整块去掉 svg（含内部 on* / 外链脚本等）
    let re_svg = RE_SVG.get_or_init(|| {
        Regex::new(r"(?is)<\s*svg\b[^>]*>.*?</\s*svg\s*>|<\s*svg\b[^>]*/?\s*>").expect("svg regex")
    });
    let re_link =
        RE_LINK.get_or_init(|| Regex::new(r"(?is)<\s*link\b[^>]*/?\s*>").expect("link regex"));
    let re_meta =
        RE_META.get_or_init(|| Regex::new(r"(?is)<\s*meta\b[^>]*/?\s*>").expect("meta regex"));
    let re_base =
        RE_BASE.get_or_init(|| Regex::new(r"(?is)<\s*base\b[^>]*/?\s*>").expect("base regex"));
    let re_on = RE_ON.get_or_init(|| {
        Regex::new(r#"(?i)\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#).expect("on= regex")
    });
    // href/src 中的 javascript:（含空白混淆 javascript: / JaVaScRiPt:）
    let re_js_href = RE_JS_HREF.get_or_init(|| {
        Regex::new(
            r#"(?i)(\bhref\s*=\s*)(?:"\s*javascript\s*:[^"]*"|'\s*javascript\s*:[^']*'|javascript\s*:[^\s>]+)"#,
        )
        .expect("js href regex")
    });
    let re_js_src = RE_JS_SRC.get_or_init(|| {
        Regex::new(
            r#"(?i)(\bsrc\s*=\s*)(?:"\s*javascript\s*:[^"]*"|'\s*javascript\s*:[^']*'|javascript\s*:[^\s>]+)"#,
        )
        .expect("js src regex")
    });

    let s = re_script.replace_all(html, "");
    let s = re_iframe.replace_all(&s, "");
    let s = re_object.replace_all(&s, "");
    let s = re_embed.replace_all(&s, "");
    let s = re_svg.replace_all(&s, "");
    let s = re_link.replace_all(&s, "");
    let s = re_meta.replace_all(&s, "");
    let s = re_base.replace_all(&s, "");
    let s = re_on.replace_all(&s, "");
    // 中和为 href="" / src=""（保留属性名，去掉 javascript: 载荷）
    let s = re_js_href.replace_all(&s, r#"$1"""#);
    let s = re_js_src.replace_all(&s, r#"$1"""#);
    s.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_heading_and_table() {
        let md = "# Hi\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
        let h = render_markdown(md);
        assert!(h.contains("<h1>"));
        assert!(h.contains("<table>"));
    }

    #[test]
    fn renders_strikethrough_and_task() {
        let md = "~~x~~\n\n- [ ] todo\n- [x] done\n";
        let h = render_markdown(md);
        assert!(h.contains("<del>") || h.contains("<s>"));
        assert!(
            h.contains("checkbox") || h.contains("task-list") || h.contains("type=\"checkbox\"")
        );
    }

    #[test]
    fn strips_script_tags() {
        let md = "hello <script>alert(1)</script> world";
        let h = render_markdown(md);
        assert!(
            !h.to_lowercase().contains("<script"),
            "script tag must be stripped, got: {h}"
        );
        assert!(!h.contains("alert(1)") || !h.to_lowercase().contains("<script"));
    }

    #[test]
    fn strips_onclick_attr() {
        let raw = r#"<p onclick="alert(1)">x</p><img onerror='steal()' src=x>"#;
        let h = sanitize_html(raw);
        assert!(!h.to_lowercase().contains("onclick"));
        assert!(!h.to_lowercase().contains("onerror"));
    }

    #[test]
    fn strips_iframe() {
        let raw = r#"<iframe src="evil"></iframe><p>ok</p>"#;
        let h = sanitize_html(raw);
        assert!(!h.to_lowercase().contains("iframe"));
        assert!(h.contains("<p>ok</p>"));
    }

    #[test]
    fn strips_embed_and_object() {
        let raw =
            r#"<p>a</p><embed src="x.swf"><object data="y"><param name="x"></object><p>b</p>"#;
        let h = sanitize_html(raw);
        let low = h.to_lowercase();
        assert!(!low.contains("<embed"), "embed must be stripped, got: {h}");
        assert!(
            !low.contains("<object"),
            "object must be stripped, got: {h}"
        );
        assert!(h.contains("<p>a</p>") && h.contains("<p>b</p>"));
    }

    #[test]
    fn strips_javascript_href_and_src() {
        let raw = r#"<a href="javascript:alert(1)">x</a><a href='JaVaScRiPt:void(0)'>y</a><img src="javascript:steal()"><p ok>"#;
        let h = sanitize_html(raw);
        let low = h.to_lowercase();
        assert!(
            !low.contains("javascript:"),
            "javascript: protocol must be neutralized, got: {h}"
        );
        assert!(h.contains("<a") || h.contains("<img") || h.contains("<p"));
    }

    #[test]
    fn strips_svg_block() {
        let raw =
            r#"<p>before</p><svg onload="alert(1)"><script>evil()</script></svg><p>after</p>"#;
        let h = sanitize_html(raw);
        let low = h.to_lowercase();
        assert!(!low.contains("<svg"), "svg must be stripped, got: {h}");
        assert!(!low.contains("onload"));
        assert!(h.contains("<p>before</p>") && h.contains("<p>after</p>"));
    }

    #[test]
    fn strips_link_meta_base() {
        let raw = r#"<link rel="stylesheet" href="evil.css"><meta http-equiv="refresh" content="0;url=evil"><base href="https://evil/"><p>ok</p>"#;
        let h = sanitize_html(raw);
        let low = h.to_lowercase();
        assert!(!low.contains("<link"), "link must be stripped, got: {h}");
        assert!(!low.contains("<meta"), "meta must be stripped, got: {h}");
        assert!(!low.contains("<base"), "base must be stripped, got: {h}");
        assert!(h.contains("<p>ok</p>"));
    }

    #[test]
    fn markdown_drops_raw_html_instead_of_parsing_event_attributes() {
        let markdown = r#"before <img src=x onerror=alert(1)> <details open ontoggle=alert(2)>x</details> after"#;
        let rendered = render_markdown(markdown);
        let lower = rendered.to_lowercase();
        assert!(!lower.contains("<img"));
        assert!(!lower.contains("<details"));
        assert!(!lower.contains("onerror"));
        assert!(!lower.contains("ontoggle"));
    }

    #[test]
    fn markdown_neutralizes_unsafe_link_schemes() {
        for markdown in [
            "[x](javascript:alert(1))",
            "[x](JaVaScRiPt:alert(1))",
            "[x](data:text/html;base64,PHNjcmlwdD4=)",
            "![x](file:///sensitive/path)",
        ] {
            let rendered = render_markdown(markdown).to_lowercase();
            assert!(!rendered.contains("javascript:"), "rendered={rendered}");
            assert!(!rendered.contains("data:text/html"), "rendered={rendered}");
            assert!(!rendered.contains("file:///"), "rendered={rendered}");
        }
    }

    #[test]
    fn markdown_keeps_normal_https_and_relative_links() {
        let rendered = render_markdown("[web](https://example.com) [local](chapter.md)");
        assert!(rendered.contains("https://example.com"));
        assert!(rendered.contains("chapter.md"));
    }
}
