from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from indexer.parser import (
    _parse_python_file_with_ast,
    _parse_python_file_with_tree_sitter,
    parse_python_file,
    python_parser_backend,
)


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
            inherits_pairs = {(i.child_qualified_name, i.base_name) for i in parsed.inherits}

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
            self.assertEqual(inherits_pairs, set())

    def test_parse_python_file_extracts_inheritance(self) -> None:
        sample = """
class Base:
    pass

class Child(Base):
    pass
""".strip()

        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            target = repo_root / "pkg" / "inherit.py"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(sample, encoding="utf-8")

            parsed = parse_python_file(target, repo_root)
            inherits_pairs = {(i.child_qualified_name, i.base_name) for i in parsed.inherits}
            self.assertEqual(inherits_pairs, {("pkg.inherit.Child", "Base")})

    def test_parser_backend_is_declared(self) -> None:
        backend = python_parser_backend()
        self.assertIn(backend, {"tree-sitter", "ast-fallback"})

    @unittest.skipUnless(python_parser_backend() == "tree-sitter", "tree-sitter backend not available")
    def test_tree_sitter_parity_with_ast_for_core_extraction(self) -> None:
        sample = """
import os
from pkg.subpkg import dep as alias

class Worker:
    def run(self, data):
        return helper(data)

def helper(value):
    return str(value)

def entrypoint():
    worker = Worker()
    worker.run(1)
    helper(2)
""".strip()

        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            target = repo_root / "pkg" / "module.py"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(sample, encoding="utf-8")

            ast_parsed = _parse_python_file_with_ast(target, repo_root)
            ts_parsed = _parse_python_file_with_tree_sitter(target, repo_root)

            ast_symbols = {(s.kind, s.qualified_name) for s in ast_parsed.symbols}
            ts_symbols = {(s.kind, s.qualified_name) for s in ts_parsed.symbols}
            ast_imports = {imp.module for imp in ast_parsed.imports}
            ts_imports = {imp.module for imp in ts_parsed.imports}
            ast_calls = {(c.caller_qualified_name, c.callee_name) for c in ast_parsed.calls}
            ts_calls = {(c.caller_qualified_name, c.callee_name) for c in ts_parsed.calls}

            self.assertEqual(ts_symbols, ast_symbols)
            self.assertEqual(ts_imports, ast_imports)
            self.assertEqual(ts_calls, ast_calls)


if __name__ == "__main__":
    unittest.main()
