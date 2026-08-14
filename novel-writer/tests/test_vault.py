#!/usr/bin/env python3
"""墨稿 vault 核心路径单测（无网络）。"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class VaultTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mogao-test-"))
        os.environ["MOGAO_VAULT"] = str(self.tmp / "vault")
        # 重新加载 server 模块以吃到新 VAULT
        if "server" in sys.modules:
            del sys.modules["server"]
        import server as S

        self.S = S
        self.S.VAULT = (self.tmp / "vault").resolve()
        self.S.BOOKS = self.S.VAULT / "books"
        self.S.LIBRARY_FILE = self.S.VAULT / "library.json"
        self.S.SETTINGS_FILE = self.tmp / "mogao-settings.json"
        self.S.ensure_vault()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_create_and_save_chapters_incremental(self):
        S = self.S
        book = S.create_book("单测之书", "idea")
        slug = book["slug"]
        book["chapters"] = [
            {
                "id": "c1",
                "taskId": "t1",
                "title": "第1章 起",
                "order": 1,
                "body": "甲乙丙",
                "updatedAt": 1,
            }
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)
        p1 = S.BOOKS / slug / "章节"
        files1 = list(p1.glob("*.md"))
        self.assertEqual(len(files1), 1)
        self.assertIn("甲乙丙", files1[0].read_text(encoding="utf-8"))

        # 追加第二章，第一章文件应仍在（先写后删孤儿）
        book["chapters"].append(
            {
                "id": "c2",
                "taskId": "t2",
                "title": "第2章 承",
                "order": 2,
                "body": "丁戊己",
                "updatedAt": 2,
            }
        )
        S.save_book_to_disk(slug, book, do_snapshot=False)
        files2 = sorted(p1.glob("*.md"))
        self.assertEqual(len(files2), 2)
        bodies = "\n".join(f.read_text(encoding="utf-8") for f in files2)
        self.assertIn("甲乙丙", bodies)
        self.assertIn("丁戊己", bodies)

        loaded = S.load_book_from_disk(slug)
        self.assertEqual(len(loaded["chapters"]), 2)
        self.assertEqual(loaded["chapters"][0]["body"].strip(), "甲乙丙")

    def test_orphan_cleanup(self):
        S = self.S
        book = S.create_book("孤儿测试", "")
        slug = book["slug"]
        book["chapters"] = [
            {"id": "a", "title": "第1章", "order": 1, "body": "one", "updatedAt": 1},
            {"id": "b", "title": "第2章", "order": 2, "body": "two", "updatedAt": 2},
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)
        book["chapters"] = [book["chapters"][0]]  # 删掉第2章
        book["clearChapters"] = True  # 显式授权清理不在列表内的章节
        S.save_book_to_disk(slug, book, do_snapshot=False)
        files = list((S.BOOKS / slug / "章节").glob("*.md"))
        self.assertEqual(len(files), 1)
        self.assertIn("one", files[0].read_text(encoding="utf-8"))

    def test_snapshot_and_restore(self):
        S = self.S
        book = S.create_book("快照书", "")
        slug = book["slug"]
        book["chapters"] = [
            {"id": "c1", "title": "第1章", "order": 1, "body": "VERSION_A", "updatedAt": 1}
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)
        hid = S.create_snapshot(slug, reason="test")
        self.assertTrue(hid)
        book["chapters"][0]["body"] = "VERSION_B"
        S.save_book_to_disk(slug, book, do_snapshot=False)
        restored = S.restore_snapshot(slug, hid)
        self.assertIn("VERSION_A", restored["chapters"][0]["body"])

    def test_atomic_json(self):
        S = self.S
        path = self.tmp / "x.json"
        S.write_json(path, {"ok": True})
        self.assertTrue(path.exists())
        self.assertTrue(json.loads(path.read_text(encoding="utf-8"))["ok"])

    def test_health_version_constant(self):
        self.assertTrue(self.S.VERSION)
        self.assertRegex(self.S.VERSION, r"^\d+\.\d+")

    def test_debug_origin_guard_only_allows_local_same_port(self):
        S = self.S
        self.assertTrue(S.is_trusted_browser_origin(None))
        self.assertTrue(S.is_trusted_browser_origin(f"http://127.0.0.1:{S.PORT}"))
        self.assertTrue(S.is_trusted_browser_origin(f"http://localhost:{S.PORT}"))
        self.assertFalse(S.is_trusted_browser_origin("https://example.com"))
        self.assertFalse(S.is_trusted_browser_origin(f"http://127.0.0.1:{S.PORT + 1}"))

    def test_migration_rolls_back_all_projects_on_failure(self):
        S = self.S
        with self.assertRaises(ValueError):
            S.migrate_projects(
                [
                    {"title": "可迁入", "chapters": []},
                    42,
                ]
            )
        library = S.rescan_library()
        self.assertEqual(library.get("books"), [])

    def test_file_tree_does_not_follow_directory_symlink(self):
        S = self.S
        book = S.create_book("链接边界", "")
        slug = book["slug"]
        outside = self.tmp / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("secret", encoding="utf-8")
        link = S.BOOKS / slug / "outside-link"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlink unavailable: {error}")
        tree = S.build_file_tree(slug)
        self.assertNotIn("outside-link", json.dumps(tree, ensure_ascii=False))

    def test_settings_merge_and_replace(self):
        S = self.S
        first = S.update_settings(
            {
                "clientCfg": {"theme": "soft-paper", "model": "alpha"},
                "uiState": {"activeSection": "write"},
            }
        )
        self.assertEqual(first["clientCfg"]["model"], "alpha")
        merged = S.update_settings(
            {
                "clientCfg": {"theme": "ink-night"},
                "uiState": {"focusMode": True},
            }
        )
        self.assertEqual(merged["clientCfg"]["model"], "alpha")
        self.assertEqual(merged["clientCfg"]["theme"], "ink-night")
        self.assertEqual(merged["uiState"]["activeSection"], "write")
        self.assertTrue(merged["uiState"]["focusMode"])
        replaced = S.update_settings({"clientCfg": {"theme": "qing-jian"}, "replaceClientCfg": True})
        self.assertEqual(replaced["clientCfg"], {"theme": "qing-jian"})
        payload = S.settings_payload(replaced)
        self.assertEqual(payload["engine"], "python-debug")
        self.assertEqual(payload["version"], S.VERSION)

    def test_continuity_sidecars_roundtrip(self):
        S = self.S
        book = S.create_book("连续性侧车", "")
        slug = book["slug"]
        book["plotLoops"] = [{"id": "loop1", "summary": "账册", "status": "open"}]
        book["continuityIssues"] = [{"id": "issue1", "summary": "人物位置", "status": "open"}]
        book["entityStates"] = {"苏清月": {"entity": "苏清月", "location": "市一院"}}
        book["timelineEvents"] = [{"id": "event1", "event": "进入医院", "order": 1}]
        book["styleBible"] = {"pov": "第三人称限知"}
        S.save_book_to_disk(slug, book, do_snapshot=False)
        memory_dir = S.BOOKS / slug / "记忆"
        self.assertTrue((memory_dir / "plot-loops.json").is_file())
        self.assertTrue((memory_dir / "entity-states.json").is_file())
        loaded = S.load_book_from_disk(slug)
        self.assertEqual(loaded["plotLoops"][0]["id"], "loop1")
        self.assertEqual(loaded["entityStates"]["苏清月"]["location"], "市一院")
        self.assertEqual(loaded["styleBible"]["pov"], "第三人称限知")

    def test_save_does_not_blank_between_writes(self):
        """回归：保存过程中章节文件不应出现「先被删光」的空窗（抽样检查最终一致）。"""
        S = self.S
        book = S.create_book("空窗测试", "")
        slug = book["slug"]
        book["chapters"] = [
            {"id": "c1", "title": "第1章", "order": 1, "body": "KEEP_ME", "updatedAt": 1},
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)
        path = next((S.BOOKS / slug / "章节").glob("*.md"))
        self.assertIn("KEEP_ME", path.read_text(encoding="utf-8"))
        book["chapters"][0]["body"] = "KEEP_ME_V2"
        S.save_book_to_disk(slug, book, do_snapshot=False)
        texts = [p.read_text(encoding="utf-8") for p in (S.BOOKS / slug / "章节").glob("*.md")]
        self.assertTrue(any("KEEP_ME_V2" in t for t in texts))

    def test_empty_or_missing_chapters_preserves_disk_without_explicit_clear(self):
        S = self.S
        book = S.create_book("空数组保护", "")
        slug = book["slug"]
        book["chapters"] = [
            {"id": "c1", "title": "第一章", "order": 1, "body": "KEEP_ON_DISK", "updatedAt": S.now_ms()}
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)
        chapter_dir = S.BOOKS / slug / "章节"

        metadata_only = {"id": book["id"], "title": book["title"]}
        saved_missing = S.save_book_to_disk(slug, metadata_only, do_snapshot=False)
        self.assertEqual(len(saved_missing["chapters"]), 1)
        self.assertEqual(len(list(chapter_dir.glob("*.md"))), 1)

        saved_empty = S.save_book_to_disk(
            slug,
            {"id": book["id"], "title": book["title"], "chapters": []},
            do_snapshot=False,
        )
        self.assertEqual(len(saved_empty["chapters"]), 1)
        self.assertIn("KEEP_ON_DISK", saved_empty["chapters"][0]["body"])

        S.save_book_to_disk(
            slug,
            {"id": book["id"], "title": book["title"], "chapters": [], "clearChapters": True},
            do_snapshot=False,
        )
        self.assertEqual(list(chapter_dir.glob("*.md")), [])

    def test_slim_empty_body_does_not_wipe_disk_md(self):
        S = self.S
        book = S.create_book("空串保护", "")
        slug = book["slug"]
        book["chapters"] = [
            {"id": "c1", "title": "第一章", "order": 1, "body": "磁盘正文必须留下", "updatedAt": S.now_ms()}
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)
        loaded = S.load_book_from_disk(slug)
        loaded["chapters"][0]["body"] = ""
        saved = S.save_book_to_disk(slug, loaded, do_snapshot=False)
        chapter_dir = S.BOOKS / slug / "章节"
        texts = [p.read_text(encoding="utf-8") for p in chapter_dir.glob("*.md")]
        self.assertTrue(any("磁盘正文必须留下" in t for t in texts))
        warnings = saved.get("_saveWarnings") or []
        self.assertTrue(any(w.get("kind") == "preservedExternal" for w in warnings))
        self.assertIn("磁盘正文必须留下", saved["chapters"][0]["body"])

    def test_external_chapter_is_preserved_and_reported(self):
        S = self.S
        book = S.create_book("外部新增保护", "")
        slug = book["slug"]
        book["chapters"] = [
            {"id": "c1", "title": "第一章", "order": 1, "body": "LOCAL", "updatedAt": S.now_ms()}
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)
        extra = S.BOOKS / slug / "章节" / "002-外部新增.md"
        extra.write_text(
            '---\nid: "external-2"\ntitle: "外部新增"\norder: 2\nupdatedAt: 2\n---\n\nEXTERNAL\n',
            encoding="utf-8",
        )

        saved = S.save_book_to_disk(slug, book, do_snapshot=False)
        warnings = saved.get("_saveWarnings") or []
        self.assertTrue(any(w.get("kind") == "preservedExternal" for w in warnings))
        self.assertTrue(any(w.get("chapterId") == "external-2" for w in warnings))
        self.assertEqual(len(saved["chapters"]), 2)
        self.assertTrue(extra.is_file())

    def test_newer_external_edit_wins_and_returns_conflict_warning(self):
        S = self.S
        book = S.create_book("外部冲突保护", "")
        slug = book["slug"]
        book["chapters"] = [
            {"id": "c1", "title": "第一章", "order": 1, "body": "BASE", "updatedAt": S.now_ms()}
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)
        loaded = S.load_book_from_disk(slug)
        chapter = loaded["chapters"][0]
        path = S.BOOKS / slug / chapter["_file"]
        path.write_text(path.read_text(encoding="utf-8").replace("BASE", "DISK_NEW"), encoding="utf-8")
        future = (chapter["_fileMtime"] + 2000) / 1000
        os.utime(path, (future, future))

        chapter["body"] = "LOCAL_NEW"
        chapter["updatedAt"] = S.now_ms()
        saved = S.save_book_to_disk(slug, loaded, do_snapshot=False)
        warnings = saved.get("_saveWarnings") or []
        self.assertTrue(any(w.get("kind") == "externalConflict" for w in warnings))
        self.assertTrue(any(w.get("chapterId") == "c1" for w in warnings))
        self.assertIn("DISK_NEW", path.read_text(encoding="utf-8"))
        self.assertNotIn("LOCAL_NEW", path.read_text(encoding="utf-8"))

    def test_save_returns_fresh_chapter_baselines_for_the_next_save(self):
        """保存要回传新基线：同一次会话里连改两次同一章，不能被判成外部修改。"""
        S = self.S
        book = S.create_book("基线回传", "")
        slug = book["slug"]
        book["chapters"] = [
            {"id": "c1", "title": "第一章", "order": 1, "body": "第一版", "updatedAt": S.now_ms()}
        ]
        first = S.save_book_to_disk(slug, book, do_snapshot=False)
        baselines = S.chapter_baselines(first)
        self.assertEqual(len(baselines), 1)
        self.assertEqual(baselines[0]["id"], "c1")
        self.assertEqual(baselines[0]["file"], "章节/001-第一章.md")
        self.assertGreater(baselines[0]["mtime"], 0)

        # 真实的一次保存就会把磁盘 mtime 推新；这里显式推远，让判定不受文件系统精度影响
        path = S.BOOKS / slug / baselines[0]["file"]
        future = (baselines[0]["mtime"] + 5000) / 1000
        os.utime(path, (future, future))

        stale = json.loads(json.dumps(first))
        stale["chapters"][0]["body"] = "第二版"
        stale_saved = S.save_book_to_disk(slug, stale, do_snapshot=False)
        self.assertTrue(
            any(w.get("kind") == "externalConflict" for w in stale_saved.get("_saveWarnings") or []),
            "旧基线必须仍然判冲突，否则乐观并发形同虚设",
        )
        self.assertIn("第一版", path.read_text(encoding="utf-8"))

        fresh = json.loads(json.dumps(first))
        fresh["chapters"][0]["body"] = "第二版"
        fresh["chapters"][0]["_fileMtime"] = int(path.stat().st_mtime * 1000)
        fresh_saved = S.save_book_to_disk(slug, fresh, do_snapshot=False)
        self.assertFalse(
            fresh_saved.get("_saveWarnings"),
            "换过基线的第二次保存不该报冲突",
        )
        self.assertIn("第二版", path.read_text(encoding="utf-8"))
        self.assertGreater(S.chapter_baselines(fresh_saved)[0]["mtime"], 0)

    def test_whole_book_saves_are_serialized(self):
        S = self.S
        book = S.create_book("并发保存", "")
        slug = book["slug"]
        original_write = S.write_text_atomic
        counter_lock = threading.Lock()
        active_writes = 0
        max_active_writes = 0
        errors = []

        def observed_write(path, text, encoding="utf-8"):
            nonlocal active_writes, max_active_writes
            with counter_lock:
                active_writes += 1
                max_active_writes = max(max_active_writes, active_writes)
            try:
                time.sleep(0.003)
                return original_write(path, text, encoding)
            finally:
                with counter_lock:
                    active_writes -= 1

        start = threading.Barrier(3)

        def save_version(label):
            try:
                project = json.loads(json.dumps(book, ensure_ascii=False))
                project["title"] = label
                project["chapters"] = [
                    {
                        "id": "concurrent-chapter",
                        "title": "第一章",
                        "order": 1,
                        "body": label,
                        "updatedAt": S.now_ms(),
                    }
                ]
                start.wait()
                S.save_book_to_disk(slug, project, do_snapshot=False)
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)

        S.write_text_atomic = observed_write
        threads = [threading.Thread(target=save_version, args=(label,)) for label in ("VERSION_A", "VERSION_B")]
        try:
            for thread in threads:
                thread.start()
            start.wait()
            for thread in threads:
                thread.join(timeout=10)
        finally:
            S.write_text_atomic = original_write

        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(max_active_writes, 1, "whole-book writes must never interleave")
        loaded = S.load_book_from_disk(slug)
        self.assertIn(loaded["title"], {"VERSION_A", "VERSION_B"})
        self.assertEqual(loaded["chapters"][0]["body"].strip(), loaded["title"])

    def test_load_preserves_chapter_runtime_state(self):
        """book.json 里的交接/细纲状态必须在从 md 读回后还在。"""
        S = self.S
        book = S.create_book("章状态保留", "")
        slug = book["slug"]
        book["chapters"] = [
            {
                "id": "c-state",
                "title": "第一章",
                "order": 1,
                "body": "正文",
                "handoffStatus": "done",
                "beatPlan": {"scenes": [{"goal": "开场"}]},
                "beatPlanLocked": True,
                "updatedAt": S.now_ms(),
            }
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)
        loaded = S.load_book_from_disk(slug)
        self.assertEqual(loaded["chapters"][0]["id"], "c-state")
        self.assertEqual(loaded["chapters"][0]["handoffStatus"], "done")
        self.assertEqual(loaded["chapters"][0]["beatPlan"]["scenes"][0]["goal"], "开场")
        self.assertTrue(loaded["chapters"][0]["beatPlanLocked"])

    def test_reload_includes_book_mtime(self):
        """GET 与 POST /reload 共用 load_book_from_disk，必须带并发基线 _mtime。"""
        S = self.S
        book = S.create_book("重载mtime", "")
        slug = book["slug"]
        loaded = S.load_book_from_disk(slug)
        self.assertIn("_mtime", loaded)
        self.assertGreater(loaded["_mtime"], 0)
        self.assertTrue(str(loaded.get("_path") or "").endswith(slug))
        bj = S.BOOKS / slug / "book.json"
        self.assertEqual(loaded["_mtime"], int(bj.stat().st_mtime * 1000))

    def test_non_chapter_workspace_file_syncs_mirror_not_chapters(self):
        """资料区改 graph.json 必须写回 book.json；非章节笔记不得变成一章。"""
        S = self.S
        book = S.create_book("镜像回写", "")
        slug = book["slug"]
        book["chapters"] = [
            {"id": "c1", "title": "第一章", "order": 1, "body": "正文", "updatedAt": S.now_ms()}
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)

        S.write_book_file(
            slug,
            "关系/graph.json",
            json.dumps({"nodes": [{"id": "n-keep"}], "edges": []}, ensure_ascii=False),
        )
        loaded = S.load_book_from_disk(slug)
        self.assertEqual(loaded["graph"]["nodes"][0]["id"], "n-keep")
        disk = S.read_json(S.BOOKS / slug / "book.json")
        self.assertEqual(disk["graph"]["nodes"][0]["id"], "n-keep")

        before = len(loaded["chapters"])
        S.write_book_file(slug, "资料/采访.md", "这是采访笔记，不是章节。")
        loaded2 = S.load_book_from_disk(slug)
        self.assertEqual(len(loaded2["chapters"]), before)
        self.assertEqual(loaded2["chapters"][0]["id"], "c1")
        self.assertNotIn("采访笔记", json.dumps(loaded2["chapters"], ensure_ascii=False))

        # 未同步的话，随后一次整本保存会用旧 graph 盖掉资料区改动
        meta_only = {"id": loaded2["id"], "title": loaded2["title"], "graph": loaded2["graph"]}
        S.save_book_to_disk(slug, meta_only, do_snapshot=False)
        graph_file = json.loads((S.BOOKS / slug / "关系" / "graph.json").read_text(encoding="utf-8"))
        self.assertEqual(graph_file["nodes"][0]["id"], "n-keep")

    def test_chapter_order_zero_is_kept(self):
        """order=0 是合法序号（序章），不得被当成缺失而改写成 1。"""
        S = self.S
        book = S.create_book("零序号", "")
        slug = book["slug"]
        book["chapters"] = [
            {"id": "prologue", "title": "序章", "order": 0, "body": "从前", "updatedAt": S.now_ms()},
            {"id": "c1", "title": "第一章", "order": 1, "body": "后来", "updatedAt": S.now_ms()},
        ]
        saved = S.save_book_to_disk(slug, book, do_snapshot=False)
        self.assertEqual(saved["chapters"][0]["order"], 0)
        self.assertEqual(saved["chapters"][0]["id"], "prologue")
        names = sorted(p.name for p in (S.BOOKS / slug / "章节").glob("*.md"))
        self.assertTrue(any(name.startswith("000-") for name in names), names)
        loaded = S.load_book_from_disk(slug)
        prologue = next(ch for ch in loaded["chapters"] if ch["id"] == "prologue")
        self.assertEqual(prologue["order"], 0)
        self.assertEqual(S.resolve_chapter_order({"order": 0, "title": "第9章"}, {}, 3), 0)

    def test_idless_note_does_not_steal_chapter_id(self):
        """无 id 的 001-随手记.md 不得借用第一章的 id；两次加载 id 必须稳定。"""
        S = self.S
        book = S.create_book("章id稳定", "")
        slug = book["slug"]
        book["chapters"] = [
            {
                "id": "c1",
                "title": "第一章",
                "order": 1,
                "body": "第一章正文必须留下",
                "handoffStatus": "done",
                "updatedAt": S.now_ms(),
            }
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)
        S.write_book_file(
            slug,
            "章节/001-随手记.md",
            "---\ntitle: 随手记\ncreated: 2026-08-13 19:00:00\n---\n\n# 随手记\n\n笔记正文\n",
        )
        loaded = S.load_book_from_disk(slug)
        ids = [ch["id"] for ch in loaded["chapters"]]
        self.assertEqual(len(ids), len(set(ids)), ids)
        self.assertIn("c1", ids)
        c1 = next(ch for ch in loaded["chapters"] if ch["id"] == "c1")
        self.assertIn("第一章正文必须留下", c1["body"])
        self.assertNotIn("笔记正文", c1["body"])
        self.assertEqual(c1["handoffStatus"], "done")
        note = next(ch for ch in loaded["chapters"] if ch["id"] != "c1")
        self.assertTrue(note["id"])
        self.assertNotEqual(note["id"], "c1")
        loaded2 = S.load_book_from_disk(slug)
        note2 = next(ch for ch in loaded2["chapters"] if ch["id"] != "c1")
        self.assertEqual(note["id"], note2["id"])

    def test_save_does_not_resurrect_user_deleted_progressed_task(self):
        """整本保存以客户端任务板为权威：删掉的 done 任务不得从磁盘复活。"""
        S = self.S
        book = S.create_book("删任务", "")
        slug = book["slug"]
        book["tasks"] = [
            {"id": "t-done", "order": 1, "status": "done", "chapter_title": "已完成"},
            {"id": "t-keep", "order": 2, "status": "pending", "chapter_title": "留下"},
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)

        after_delete = S.load_book_from_disk(slug)
        after_delete["tasks"] = [
            {"id": "t-keep", "order": 2, "status": "pending", "chapter_title": "留下"}
        ]
        S.save_book_to_disk(slug, after_delete, do_snapshot=False)
        reloaded = S.load_book_from_disk(slug)
        ids = [t.get("id") for t in reloaded.get("tasks") or []]
        self.assertEqual(ids, ["t-keep"], ids)
        disk = S.read_json(S.BOOKS / slug / "策划" / "tasks.json")
        self.assertEqual([t.get("id") for t in disk], ["t-keep"])

    def test_save_omitted_tasks_keeps_disk_board(self):
        """整本保存若省略 tasks 键，不得把磁盘任务板写成空。"""
        S = self.S
        book = S.create_book("省略任务", "")
        slug = book["slug"]
        book["tasks"] = [
            {"id": "t-done", "order": 1, "status": "done", "chapter_title": "已完成"}
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)
        slim = S.load_book_from_disk(slug)
        slim.pop("tasks", None)
        S.save_book_to_disk(slug, slim, do_snapshot=False)
        reloaded = S.load_book_from_disk(slug)
        self.assertEqual([t.get("id") for t in reloaded.get("tasks") or []], ["t-done"])

    def test_workspace_tasks_overlay_keeps_progressed_not_in_draft(self):
        """资料区改 tasks.json 仍走 merge：重跑策划草稿不得清掉已有进度。"""
        S = self.S
        book = S.create_book("资料区任务", "")
        slug = book["slug"]
        book["tasks"] = [
            {"id": "t1", "order": 1, "status": "done", "chapter_title": "A"},
            {"id": "t2", "order": 2, "status": "written", "chapter_title": "B"},
        ]
        S.save_book_to_disk(slug, book, do_snapshot=False)
        S.write_book_file(
            slug,
            "策划/tasks.json",
            json.dumps(
                [{"id": "t3", "order": 3, "status": "pending", "chapter_title": "C"}],
                ensure_ascii=False,
            ),
        )
        loaded = S.load_book_from_disk(slug)
        ids = [t.get("id") for t in loaded.get("tasks") or []]
        self.assertEqual(set(ids), {"t1", "t2", "t3"}, ids)


if __name__ == "__main__":
    unittest.main()
