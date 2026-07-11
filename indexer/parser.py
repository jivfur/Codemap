from __future__ import annotations

import ast
from pathlib import Path

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


def module_name_for_path(file_path: Path, repo_root: Path) -> str:
    rel = file_path.relative_to(repo_root)
    without_suffix = rel.with_suffix("")
    return ".".join(without_suffix.parts)


def parse_python_file(file_path: Path, repo_root: Path) -> ParsedFile:
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
