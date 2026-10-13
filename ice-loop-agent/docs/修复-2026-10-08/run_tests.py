"""Scoped offline regression runner; all outputs stay in this G-drive workspace."""
import json
import os
import sys
import unittest
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
root = repo / ".test-tmp/small-fixes-20261008"
root.mkdir(parents=True, exist_ok=True)
os.environ["TEMP"] = os.environ["TMP"] = str(root)
os.environ["PYTHONUTF8"] = "1"
for key in ("DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "BIGMODEL_API_KEY", "ARK_API_KEY", "MINIMAX_API_KEY"):
    os.environ.pop(key, None)
sys.path.insert(0, str(repo))
import tests
tests.TEST_TMP = root
# No network call is authorized by these regressions, including a missed mock.
from unittest.mock import patch
small_only = "--small" in sys.argv
modules = ["tests.test_review_small_fixes"] if small_only else [
    "tests.test_review_small_fixes", "tests.test_v2_editor", "tests.test_v2_ops_export",
    "tests.test_v2_dispatch", "tests.test_v2_knowledge"]
stem = "python-small" if small_only else "python"
suite = unittest.defaultTestLoader.loadTestsFromNames(modules)
with patch("socket.socket.connect", side_effect=RuntimeError("offline tests forbid network")), \
     patch("urllib.request.OpenerDirector.open", side_effect=RuntimeError("offline tests forbid network")), \
     (Path(__file__).parent / (stem + "-tests.log")).open("w", encoding="utf-8") as output:
    result = unittest.TextTestRunner(stream=output, verbosity=2).run(suite)
summary = {"tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
           "skipped": len(result.skipped), "successful": result.wasSuccessful(), "modules": modules}
(Path(__file__).parent / (stem + "-result.json")).write_text(json.dumps(summary, indent=2), encoding="utf-8")
print(json.dumps(summary))
sys.exit(0 if result.wasSuccessful() else 1)
