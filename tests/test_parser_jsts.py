from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from indexer.parser import parse_source_file


class JsTsParserTests(unittest.TestCase):
    def test_parse_javascript_file_extracts_symbols_imports_and_calls(self) -> None:
        sample = """
import { util } from 'pkg-util';

class Service {
  run(data) {
    helper(data);
  }
}

function helper(x) {
  return util(x);
}
""".strip()

        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            target = repo_root / "src" / "service.js"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(sample, encoding="utf-8")

            parsed = parse_source_file(target, repo_root)
            self.assertIsNotNone(parsed)
            assert parsed is not None

            symbol_names = {s.qualified_name for s in parsed.symbols}
            imports = {imp.module for imp in parsed.imports}
            calls = {(c.caller_qualified_name, c.callee_name) for c in parsed.calls}

            self.assertEqual(parsed.language, "javascript")
            self.assertIn("src.service.Service", symbol_names)
            self.assertIn("src.service.helper", symbol_names)
            self.assertIn("pkg-util", imports)
            self.assertIn(("src.service.helper", "util"), calls)

    def test_parse_typescript_file_extracts_symbols_imports_and_calls(self) -> None:
        sample = """
import { fetcher } from 'sdk';

function runTask(input: string) {
  return fetcher(input);
}
""".strip()

        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            target = repo_root / "app" / "task.ts"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(sample, encoding="utf-8")

            parsed = parse_source_file(target, repo_root)
            self.assertIsNotNone(parsed)
            assert parsed is not None

            symbol_names = {s.qualified_name for s in parsed.symbols}
            imports = {imp.module for imp in parsed.imports}
            calls = {(c.caller_qualified_name, c.callee_name) for c in parsed.calls}

            self.assertEqual(parsed.language, "typescript")
            self.assertIn("app.task.runTask", symbol_names)
            self.assertIn("sdk", imports)
            self.assertIn(("app.task.runTask", "fetcher"), calls)


if __name__ == "__main__":
    unittest.main()
