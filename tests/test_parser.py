from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from indexer.parser import parse_python_file, python_parser_backend


class ParserTests(unittest.TestCase):
    def test_parse_python_file_extracts_core_graph_data(self) -> None:
        sample = """
import os
from pkg import dep

class Greeter:
    def hello(self, name):
        print(name)


def helper(value):
    return str(value)


def runner():
    g = Greeter()
    g.hello('x')
    helper(1)
""".strip()

        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            target = repo_root / "pkg" / "module.py"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(sample, encoding="utf-8")

            parsed = parse_python_file(target, repo_root)

            symbol_qnames = {s.qualified_name for s in parsed.symbols}
            import_modules = {imp.module for imp in parsed.imports}
            call_pairs = {(c.caller_qualified_name, c.callee_name) for c in parsed.calls}

            self.assertEqual(parsed.language, "python")
            self.assertGreaterEqual(parsed.loc, 1)
            self.assertIn("pkg.module.Greeter", symbol_qnames)
            self.assertIn("pkg.module.Greeter.hello", symbol_qnames)
            self.assertIn("pkg.module.helper", symbol_qnames)
            self.assertIn("pkg.module.runner", symbol_qnames)
            self.assertIn("os", import_modules)
            self.assertIn("pkg", import_modules)
            self.assertIn(("pkg.module.Greeter.hello", "print"), call_pairs)
            self.assertIn(("pkg.module.runner", "hello"), call_pairs)
            self.assertIn(("pkg.module.runner", "helper"), call_pairs)

    def test_parser_backend_is_declared(self) -> None:
        backend = python_parser_backend()
        self.assertIn(backend, {"tree-sitter", "ast-fallback"})


if __name__ == "__main__":
    unittest.main()
