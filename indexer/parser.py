from __future__ import annotations

import ast
import importlib
import re
from pathlib import Path
from typing import Any

from .models import ParsedCall, ParsedFile, ParsedImport, ParsedSymbol


LANGUAGE_BY_EXTENSION: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
}


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


def detect_language(file_path: Path) -> str | None:
    return LANGUAGE_BY_EXTENSION.get(file_path.suffix.lower())


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


def javascript_parser_backend() -> str:
    try:
        mod = importlib.import_module("tree_sitter_languages")
        get_parser = getattr(mod, "get_parser")
        parser = get_parser("javascript")
        if parser is not None:
            return "tree-sitter"
    except (ImportError, AttributeError, TypeError, ValueError, RuntimeError):
        pass
    return "regex-fallback"


def _parse_jsts_with_regex(file_path: Path, repo_root: Path, language: str) -> ParsedFile:
    source = file_path.read_text(encoding="utf-8", errors="replace")
    lines = source.splitlines()
    module_name = module_name_for_path(file_path, repo_root)

    symbols: list[ParsedSymbol] = []
    imports: list[ParsedImport] = []
    calls: list[ParsedCall] = []

    function_stack: list[tuple[str, int]] = []

    for line_no, line in enumerate(lines, start=1):
        stripped = line.strip()

        m_import_from = re.match(r"^import\s+.+\s+from\s+['\"]([^'\"]+)['\"]", stripped)
        if m_import_from:
            imports.append(ParsedImport(module=m_import_from.group(1)))
        m_import_bare = re.match(r"^import\s+['\"]([^'\"]+)['\"]", stripped)
        if m_import_bare:
            imports.append(ParsedImport(module=m_import_bare.group(1)))
        m_require = re.search(r"require\(\s*['\"]([^'\"]+)['\"]\s*\)", stripped)
        if m_require:
            imports.append(ParsedImport(module=m_require.group(1)))

        m_class = re.match(r"^class\s+([A-Za-z_][A-Za-z0-9_]*)", stripped)
        if m_class:
            class_name = m_class.group(1)
            symbols.append(
                ParsedSymbol(
                    kind="class",
                    name=class_name,
                    qualified_name=f"{module_name}.{class_name}",
                    signature=class_name,
                    doc_summary=None,
                    start_line=line_no,
                    end_line=line_no,
                )
            )

        m_func = re.match(r"^function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)", stripped)
        if m_func:
            fn_name = m_func.group(1)
            sig = f"{fn_name}({m_func.group(2).strip()})"
            qname = f"{module_name}.{fn_name}"
            symbols.append(
                ParsedSymbol(
                    kind="function",
                    name=fn_name,
                    qualified_name=qname,
                    signature=sig,
                    doc_summary=None,
                    start_line=line_no,
                    end_line=line_no,
                )
            )
            function_stack.append((qname, 0))

        call_names = re.findall(r"([A-Za-z_][A-Za-z0-9_]*)\s*\(", stripped)
        if function_stack:
            caller = function_stack[-1][0]
            for callee in call_names:
                if callee in {"if", "for", "while", "switch", "catch", "function"}:
                    continue
                calls.append(ParsedCall(caller_qualified_name=caller, callee_name=callee))

    return ParsedFile(
        language=language,
        loc=len(lines),
        symbols=symbols,
        imports=imports,
        calls=calls,
    )


def _parse_jsts_with_tree_sitter(file_path: Path, repo_root: Path, language: str) -> ParsedFile:
    mod = importlib.import_module("tree_sitter_languages")
    get_parser = getattr(mod, "get_parser")

    parser_language = "javascript" if language == "javascript" else "typescript"
    source = file_path.read_text(encoding="utf-8", errors="replace")
    source_bytes = bytes(source, encoding="utf-8")
    parser = get_parser(parser_language)
    tree = parser.parse(source_bytes)

    module_name = module_name_for_path(file_path, repo_root)
    symbols: list[ParsedSymbol] = []
    imports: list[ParsedImport] = []
    calls: list[ParsedCall] = []
    scope_stack: list[tuple[str, str]] = []

    def text(node: Any) -> str:
        return source_bytes[node.start_byte : node.end_byte].decode("utf-8", errors="replace")

    def qname(name: str) -> str:
        if scope_stack:
            scope = ".".join([s for s, _ in scope_stack])
            return f"{module_name}.{scope}.{name}"
        return f"{module_name}.{name}"

    def caller_scope() -> str | None:
        if not scope_stack:
            return None
        scope = ".".join([s for s, _ in scope_stack])
        return f"{module_name}.{scope}"

    def walk(node: Any) -> None:
        if node.type == "import_statement":
            stmt = text(node)
            for mod_name in re.findall(r"from\s+['\"]([^'\"]+)['\"]", stmt):
                imports.append(ParsedImport(module=mod_name))
            bare = re.findall(r"import\s+['\"]([^'\"]+)['\"]", stmt)
            for mod_name in bare:
                imports.append(ParsedImport(module=mod_name))

        if node.type == "call_expression":
            caller = caller_scope()
            if caller:
                fn = node.child_by_field_name("function")
                if fn:
                    fn_text = text(fn).strip()
                    callee = fn_text.split(".")[-1]
                    if callee:
                        calls.append(ParsedCall(caller_qualified_name=caller, callee_name=callee))

        if node.type == "class_declaration":
            name_node = node.child_by_field_name("name")
            if name_node:
                name = text(name_node).strip()
                symbols.append(
                    ParsedSymbol(
                        kind="class",
                        name=name,
                        qualified_name=qname(name),
                        signature=name,
                        doc_summary=None,
                        start_line=node.start_point[0] + 1,
                        end_line=node.end_point[0] + 1,
                    )
                )
                scope_stack.append((name, "class"))
                for child in node.children:
                    walk(child)
                scope_stack.pop()
                return

        if node.type in {"function_declaration", "method_definition"}:
            name_node = node.child_by_field_name("name")
            if name_node:
                name = text(name_node).strip()
                kind = "method" if node.type == "method_definition" or (scope_stack and scope_stack[-1][1] == "class") else "function"
                params = node.child_by_field_name("parameters")
                sig = f"{name}{text(params).strip() if params else '()'}"
                symbols.append(
                    ParsedSymbol(
                        kind=kind,
                        name=name,
                        qualified_name=qname(name),
                        signature=sig,
                        doc_summary=None,
                        start_line=node.start_point[0] + 1,
                        end_line=node.end_point[0] + 1,
                    )
                )
                scope_stack.append((name, "function"))
                for child in node.children:
                    walk(child)
                scope_stack.pop()
                return

        for child in node.children:
            walk(child)

    walk(tree.root_node)
    return ParsedFile(
        language=language,
        loc=len(source.splitlines()),
        symbols=symbols,
        imports=imports,
        calls=calls,
    )


def parse_jsts_file(file_path: Path, repo_root: Path, language: str) -> ParsedFile:
    if javascript_parser_backend() == "tree-sitter":
        try:
            return _parse_jsts_with_tree_sitter(file_path, repo_root, language)
        except (ImportError, AttributeError, TypeError, ValueError, RuntimeError):
            return _parse_jsts_with_regex(file_path, repo_root, language)
    return _parse_jsts_with_regex(file_path, repo_root, language)


def parse_source_file(file_path: Path, repo_root: Path) -> ParsedFile | None:
    language = detect_language(file_path)
    if language is None:
        return None
    if language == "python":
        return parse_python_file(file_path, repo_root)
    if language in {"javascript", "typescript"}:
        return parse_jsts_file(file_path, repo_root, language)
    return None
