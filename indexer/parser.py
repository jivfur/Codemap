from __future__ import annotations

import ast
import importlib
from pathlib import Path
from typing import Any

from .models import ParsedCall, ParsedFile, ParsedImport, ParsedSymbol


class PythonGraphVisitor(ast.NodeVisitor):
    def __init__(self, module_name: str) -> None:
        self.module_name = module_name
        self.scope_stack: list[tuple[str, str]] = []
        self.symbols: list[ParsedSymbol] = []
        self.imports: list[ParsedImport] = []
        self.calls: list[ParsedCall] = []

    def _qualified_name(self, name: str) -> str:
        if self.scope_stack:
            scope = ".".join([scope_name for scope_name, _ in self.scope_stack])
            return f"{self.module_name}.{scope}.{name}"
        return f"{self.module_name}.{name}"

    def _current_callable_scope(self) -> str | None:
        if not self.scope_stack:
            return None
        scope = ".".join([scope_name for scope_name, _ in self.scope_stack])
        return f"{self.module_name}.{scope}"

    def _doc_summary(self, node: ast.AST) -> str | None:
        doc = ast.get_docstring(node, clean=True)
        if not doc:
            return None
        first = doc.strip().splitlines()[0].strip()
        return first or None

    def _build_signature(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
        parts: list[str] = []
        for arg in node.args.posonlyargs:
            parts.append(arg.arg)
        for arg in node.args.args:
            parts.append(arg.arg)
        if node.args.vararg:
            parts.append(f"*{node.args.vararg.arg}")
        for arg in node.args.kwonlyargs:
            parts.append(arg.arg)
        if node.args.kwarg:
            parts.append(f"**{node.args.kwarg.arg}")
        return f"{node.name}({', '.join(parts)})"

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.imports.append(ParsedImport(module=alias.name))
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module:
            self.imports.append(ParsedImport(module=node.module))
        self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        qname = self._qualified_name(node.name)
        self.symbols.append(
            ParsedSymbol(
                kind="class",
                name=node.name,
                qualified_name=qname,
                signature=node.name,
                doc_summary=self._doc_summary(node),
                start_line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno),
            )
        )
        self.scope_stack.append((node.name, "class"))
        self.generic_visit(node)
        self.scope_stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_callable(node, is_async=False)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_callable(node, is_async=True)

    def _visit_callable(self, node: ast.FunctionDef | ast.AsyncFunctionDef, is_async: bool) -> None:
        parent_is_class = len(self.scope_stack) > 0 and self.scope_stack[-1][1] == "class"
        kind = "method" if parent_is_class else "function"
        qname = self._qualified_name(node.name)
        sig = self._build_signature(node)
        if is_async:
            sig = f"async {sig}"
        self.symbols.append(
            ParsedSymbol(
                kind=kind,
                name=node.name,
                qualified_name=qname,
                signature=sig,
                doc_summary=self._doc_summary(node),
                start_line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno),
            )
        )
        self.scope_stack.append((node.name, "function"))
        self.generic_visit(node)
        self.scope_stack.pop()

    def visit_Call(self, node: ast.Call) -> None:
        caller = self._current_callable_scope()
        if caller:
            callee_name = self._callee_name(node.func)
            if callee_name:
                self.calls.append(ParsedCall(caller_qualified_name=caller, callee_name=callee_name))
        self.generic_visit(node)

    def _callee_name(self, func: ast.AST) -> str | None:
        if isinstance(func, ast.Name):
            return func.id
        if isinstance(func, ast.Attribute):
            return func.attr
        return None


class TreeSitterPythonVisitor:
    def __init__(self, module_name: str, source_bytes: bytes) -> None:
        self.module_name = module_name
        self.source_bytes = source_bytes
        self.scope_stack: list[tuple[str, str]] = []
        self.symbols: list[ParsedSymbol] = []
        self.imports: list[ParsedImport] = []
        self.calls: list[ParsedCall] = []

    def _text(self, node: Any) -> str:
        return self.source_bytes[node.start_byte : node.end_byte].decode("utf-8", errors="replace")

    def _node_name(self, node: Any) -> str | None:
        name = node.child_by_field_name("name")
        if not name:
            return None
        text = self._text(name).strip()
        return text or None

    def _qualified_name(self, name: str) -> str:
        if self.scope_stack:
            scope = ".".join([scope_name for scope_name, _ in self.scope_stack])
            return f"{self.module_name}.{scope}.{name}"
        return f"{self.module_name}.{name}"

    def _current_callable_scope(self) -> str | None:
        if not self.scope_stack:
            return None
        scope = ".".join([scope_name for scope_name, _ in self.scope_stack])
        return f"{self.module_name}.{scope}"

    def _callee_name(self, call_node: Any) -> str | None:
        func = call_node.child_by_field_name("function")
        if not func:
            return None
        if func.type == "identifier":
            return self._text(func).strip()
        if func.type == "attribute":
            attr = func.child_by_field_name("attribute")
            if attr:
                return self._text(attr).strip()
            identifiers = [child for child in func.children if child.type == "identifier"]
            if identifiers:
                return self._text(identifiers[-1]).strip()
        return None

    def _signature(self, node: Any, name: str) -> str:
        params = node.child_by_field_name("parameters")
        params_text = self._text(params).strip() if params else "()"
        node_text = self._text(node).lstrip()
        if node_text.startswith("async def"):
            return f"async {name}{params_text}"
        return f"{name}{params_text}"

    def walk(self, node: Any) -> None:
        if node.type == "import_statement":
            text = self._text(node).strip()
            if text.startswith("import "):
                imported = text[len("import ") :]
                for part in imported.split(","):
                    name = part.strip().split(" as ")[0].strip()
                    if name:
                        self.imports.append(ParsedImport(module=name))

        if node.type == "import_from_statement":
            text = self._text(node).strip()
            if text.startswith("from ") and " import " in text:
                module = text.split(" import ", 1)[0].replace("from ", "", 1).strip()
                if module:
                    self.imports.append(ParsedImport(module=module))

        if node.type == "class_definition":
            name = self._node_name(node)
            if name:
                qname = self._qualified_name(name)
                self.symbols.append(
                    ParsedSymbol(
                        kind="class",
                        name=name,
                        qualified_name=qname,
                        signature=name,
                        doc_summary=None,
                        start_line=node.start_point[0] + 1,
                        end_line=node.end_point[0] + 1,
                    )
                )
                self.scope_stack.append((name, "class"))
                for child in node.children:
                    self.walk(child)
                self.scope_stack.pop()
                return

        if node.type == "function_definition":
            name = self._node_name(node)
            if name:
                parent_is_class = len(self.scope_stack) > 0 and self.scope_stack[-1][1] == "class"
                kind = "method" if parent_is_class else "function"
                qname = self._qualified_name(name)
                self.symbols.append(
                    ParsedSymbol(
                        kind=kind,
                        name=name,
                        qualified_name=qname,
                        signature=self._signature(node, name),
                        doc_summary=None,
                        start_line=node.start_point[0] + 1,
                        end_line=node.end_point[0] + 1,
                    )
                )
                self.scope_stack.append((name, "function"))
                for child in node.children:
                    self.walk(child)
                self.scope_stack.pop()
                return

        if node.type == "call":
            caller = self._current_callable_scope()
            if caller:
                callee = self._callee_name(node)
                if callee:
                    self.calls.append(ParsedCall(caller_qualified_name=caller, callee_name=callee))

        for child in node.children:
            self.walk(child)


def module_name_for_path(file_path: Path, repo_root: Path) -> str:
    rel = file_path.relative_to(repo_root)
    without_suffix = rel.with_suffix("")
    return ".".join(without_suffix.parts)


def python_parser_backend() -> str:
    try:
        mod = importlib.import_module("tree_sitter_languages")
        get_parser = getattr(mod, "get_parser")
        parser = get_parser("python")
        if parser is not None:
            return "tree-sitter"
    except (ImportError, AttributeError, TypeError, ValueError, RuntimeError):
        pass
    return "ast-fallback"


def _parse_python_file_with_ast(file_path: Path, repo_root: Path) -> ParsedFile:
    source = file_path.read_text(encoding="utf-8", errors="replace")
    tree = ast.parse(source)
    visitor = PythonGraphVisitor(module_name=module_name_for_path(file_path, repo_root))
    visitor.visit(tree)
    return ParsedFile(
        language="python",
        loc=len(source.splitlines()),
        symbols=visitor.symbols,
        imports=visitor.imports,
        calls=visitor.calls,
    )


def _parse_python_file_with_tree_sitter(file_path: Path, repo_root: Path) -> ParsedFile:
    mod = importlib.import_module("tree_sitter_languages")
    get_parser = getattr(mod, "get_parser")

    source = file_path.read_text(encoding="utf-8", errors="replace")
    parser = get_parser("python")
    tree = parser.parse(bytes(source, encoding="utf-8"))

    visitor = TreeSitterPythonVisitor(
        module_name=module_name_for_path(file_path, repo_root),
        source_bytes=bytes(source, encoding="utf-8"),
    )
    visitor.walk(tree.root_node)

    return ParsedFile(
        language="python",
        loc=len(source.splitlines()),
        symbols=visitor.symbols,
        imports=visitor.imports,
        calls=visitor.calls,
    )


def parse_python_file(file_path: Path, repo_root: Path) -> ParsedFile:
    if python_parser_backend() == "tree-sitter":
        try:
            return _parse_python_file_with_tree_sitter(file_path, repo_root)
        except (ImportError, AttributeError, TypeError, ValueError, RuntimeError):
            # Keep indexing resilient even if tree-sitter parsing fails for a file.
            return _parse_python_file_with_ast(file_path, repo_root)
    return _parse_python_file_with_ast(file_path, repo_root)
