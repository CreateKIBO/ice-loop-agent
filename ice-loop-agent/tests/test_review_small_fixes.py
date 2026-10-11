"""Regression tests for the scoped October 8 acceptance repairs; offline only."""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import ModelProfile, sha256_text
from ice_agent.export.bundle import export_bundle
from tests import REPO, temp_dir


class TestOwnedExport(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir("small-export-")

    def export(self, target: Path):
        return export_bundle(job_id="fixture", title="测试", body="# 测试\n\n正文。",
                             content_hash=sha256_text("# 测试\n\n正文。"), slots=[],
                             runs={}, destination=target)

    def test_collision_keeps_unknown_directory_and_sentinel(self):
        token = "collision"
        stage = self.root / ("bundle-staging-" + token)
        stage.mkdir()
        sentinel = stage / "user-document.txt"
        sentinel.write_text("keep me", encoding="utf-8")
        with patch("ice_agent.export.bundle.uuid4", return_value=SimpleNamespace(hex=token)):
            with self.assertRaises(FileExistsError):
                self.export(self.root / "bundle")
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep me")

    def test_same_time_exports_use_distinct_owned_directories(self):
        with patch("ice_agent.export.bundle.now_iso", return_value="2026-10-08T00:00:00Z"):
            self.export(self.root / "one")
            self.export(self.root / "two")
        self.assertFalse(list(self.root.glob("*-staging-*")))
        self.assertFalse((self.root / "one/.ice-export-owner").exists())
        manifest = json.loads((self.root / "one/manifest.json").read_text(encoding="utf-8"))
        self.assertFalse(any("owner" in name for name in manifest["files"]))

    def test_rename_failure_cleans_only_this_owned_stage(self):
        unrelated = self.root / "unknown"
        unrelated.mkdir()
        (unrelated / "keep.txt").write_text("keep", encoding="utf-8")
        with patch.object(Path, "rename", side_effect=PermissionError("locked")):
            with self.assertRaises(PermissionError):
                self.export(self.root / "bundle")
        self.assertFalse(list(self.root.glob("bundle-staging-*")))
        self.assertTrue((unrelated / "keep.txt").exists())

    def test_replaced_ownership_is_preserved(self):
        def replace_owner(stage: Path, destination: Path):
            (stage / ".ice-export-owner").write_text("foreign-owner", encoding="ascii")
            raise PermissionError("replaced")
        with patch.object(Path, "rename", replace_owner):
            with self.assertRaises(PermissionError):
                self.export(self.root / "bundle")
        stages = list(self.root.glob("bundle-staging-*"))
        self.assertEqual(len(stages), 1)
        self.assertEqual((stages[0] / ".ice-export-owner").read_text(), "foreign-owner")

    def test_relative_destination_rejected_without_write(self):
        with self.assertRaisesRegex(ValueError, "绝对路径"):
            self.export(Path("must-not-create-relative-export"))

    def test_c_drive_destination_rejected_before_write(self):
        with self.assertRaises(PermissionError):
            self.export(Path("C:/ice-export-must-not-create"))

    def test_linked_ancestor_rejected_without_write(self):
        with patch.object(Path, "is_junction", return_value=True):
            with self.assertRaises(PermissionError):
                self.export(self.root / "bundle")
        self.assertFalse((self.root / "bundle").exists())


class TestCapabilityProbe(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir("small-probe-")
        self.runtime = self.root / "runtime"
        self.service = DesktopService(REPO, self.runtime, self.root / "articles")

    def tearDown(self):
        self.service.close()

    def test_missing_key_never_creates_adapter_and_restart_works(self):
        with patch.object(ModelProfile, "credential", return_value=None), \
             patch("ice_agent.llm.adapters.make_adapter", side_effect=AssertionError("network forbidden")):
            result = self.service.call("models.probe_capabilities", {"provider": "qwen"})
        self.assertTrue(all(value == "untested" for value in result["probe_results"].values()))
        self.assertNotIn("probe_results", self.service.settings["profiles"]["qwen"])
        restarted = DesktopService(REPO, self.runtime, self.root / "articles")
        try:
            self.assertEqual(restarted.settings["profiles"]["qwen"]["extra"]["probe_results"], result["probe_results"])
            _, _, store = restarted._app()
            store.close()
        finally:
            restarted.close()

    def test_non_json_is_not_verified(self):
        adapter = Mock()
        adapter.chat.return_value = SimpleNamespace(content="I can output JSON")
        with patch.object(ModelProfile, "credential", return_value="offline-fixture"), \
             patch("ice_agent.llm.adapters.make_adapter", return_value=adapter):
            result = self.service.call("models.probe_capabilities", {"provider": "qwen", "aspects": ["structured"]})
        self.assertNotEqual(result["probe_results"]["structured"], "verified")

    def test_valid_json_is_verified_and_profile_remains_valid(self):
        adapter = Mock()
        adapter.chat.return_value = SimpleNamespace(content='{"ok":true}')
        with patch.object(ModelProfile, "credential", return_value="offline-fixture"), \
             patch("ice_agent.llm.adapters.make_adapter", return_value=adapter):
            result = self.service.call("models.probe_capabilities", {"provider": "qwen", "aspects": ["structured"]})
        self.assertEqual(result["probe_results"]["structured"], "verified")
        ModelProfile(**self.service.settings["profiles"]["qwen"])

    def test_old_top_level_probe_metadata_is_recovered(self):
        settings = self.service.settings
        settings["profiles"]["qwen"]["probe_results"] = {"connection": "untested"}
        self.service.settings_file.write_text(json.dumps(settings), encoding="utf-8")
        restarted = DesktopService(REPO, self.runtime, self.root / "articles")
        try:
            profile = restarted.settings["profiles"]["qwen"]
            self.assertNotIn("probe_results", profile)
            self.assertEqual(profile["extra"]["probe_results"]["connection"], "untested")
        finally:
            restarted.close()


if __name__ == "__main__":
    unittest.main()
