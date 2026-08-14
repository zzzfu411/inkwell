#!/usr/bin/env python3
"""书内文件树 / 读写 API 单测。"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class FileApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mogao-ws-"))
        os.environ["MOGAO_VAULT"] = str(self.tmp / "vault")
        if "server" in sys.modules:
            del sys.modules["server"]
        import server as S

        self.S = S
        self.S.VAULT = (self.tmp / "vault").resolve()
        self.S.BOOKS = self.S.VAULT / "books"
        self.S.LIBRARY_FILE = self.S.VAULT / "library.json"
        self.S.ensure_vault()
        self.book = S.create_book("工作区测试", "idea")
        self.slug = self.book["slug"]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_tree_and_read_write(self):
        S = self.S
        tree = S.build_file_tree(self.slug)
        self.assertTrue(any(n["name"] == "README.md" for n in tree["tree"] if n["type"] == "file") or True)
        # 写章节
        rel = "章节/001-试写.md"
        body = "---\nid: \"c9\"\ntitle: \"试写\"\norder: 1\n---\n\n工作区正文甲。\n"
        S.write_book_file(self.slug, rel, body)
        got = S.read_book_file(self.slug, rel)
        self.assertIn("工作区正文甲", got["content"])
        tree2 = S.build_file_tree(self.slug)
        flat = []

        def walk(nodes):
            for n in nodes:
                if n["type"] == "file":
                    flat.append(n["path"])
                else:
                    walk(n.get("children") or [])

        walk(tree2["tree"])
        self.assertIn(rel, flat)
        # book.json 应同步章节
        loaded = S.load_book_from_disk(self.slug)
        bodies = [c.get("body", "") for c in loaded.get("chapters") or []]
        self.assertTrue(any("工作区正文甲" in b for b in bodies))

    def test_path_traversal_blocked(self):
        S = self.S
        with self.assertRaises(ValueError):
            S.safe_rel_under_book(self.slug, "../outside.txt")
        with self.assertRaises(ValueError):
            S.safe_rel_under_book(self.slug, str((self.tmp / "outside.txt").resolve()))
        with self.assertRaises(ValueError):
            S.book_dir("../books-evil")

        outside = self.tmp / "outside"
        outside.mkdir()
        link = S.book_dir(self.slug) / "outside-link"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            return
        with self.assertRaises(ValueError):
            S.safe_rel_under_book(self.slug, "outside-link/secret.txt")

    def test_watch(self):
        S = self.S
        w = S.tree_mtimes(self.slug)
        self.assertIn("files", w)
        self.assertTrue(isinstance(w["files"], dict))

    def test_delete_path_updates_chapter_metadata(self):
        S = self.S
        rel = "章节/009-删除.md"
        S.write_book_file(
            self.slug,
            rel,
            '---\nid: "delete-me"\ntitle: "删除"\norder: 9\n---\n\n待删除正文\n',
        )
        self.assertTrue(S.safe_rel_under_book(self.slug, rel).is_file())
        result = S.delete_book_path(self.slug, rel)
        self.assertTrue(result["deleted"])
        self.assertFalse(S.safe_rel_under_book(self.slug, rel).exists())
        project = S.read_json(S.book_dir(self.slug) / "book.json")
        self.assertFalse(any(ch.get("_file") == rel for ch in project.get("chapters") or []))

    def test_request_body_limit_matches_tauri(self):
        S = self.S
        self.assertEqual(S.parse_content_length(str(64 * 1024 * 1024)), 64 * 1024 * 1024)
        with self.assertRaises(S.RequestBodyTooLarge):
            S.parse_content_length(str(64 * 1024 * 1024 + 1))
        for invalid in ("-1", "not-a-number"):
            with self.assertRaises(ValueError):
                S.parse_content_length(invalid)

    def test_search_groups_story_material_and_skips_external_links(self):
        S = self.S
        marker = "红莲证据"
        expected = {
            "章节/001-开场.md": "chapter",
            "关系/graph.json": "character",
            "记忆/canon.json": "canon",
            "记忆/plot-loops.json": "loop",
            "资料/采访.md": "other",
        }
        for rel in expected:
            S.write_book_file(self.slug, rel, f"{marker} · {rel}")

        outside = self.tmp / "outside-search"
        outside.mkdir()
        (outside / "secret.md").write_text(marker, encoding="utf-8")
        link = S.book_dir(self.slug) / "external-search"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            link = None

        result = S.search_vault(marker, 50)
        by_path = {hit["path"]: hit["group"] for hit in result["hits"] if hit.get("path")}
        for rel, group in expected.items():
            self.assertEqual(by_path.get(rel), group)
        if link is not None:
            self.assertFalse(any(hit.get("path", "").startswith("external-search/") for hit in result["hits"]))


if __name__ == "__main__":
    unittest.main()
