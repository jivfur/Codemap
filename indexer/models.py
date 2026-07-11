from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ParsedSymbol:
    kind: str
    name: str
    qualified_name: str
    signature: str
    doc_summary: str | None
    start_line: int
    end_line: int


@dataclass
class ParsedImport:
    module: str


@dataclass
class ParsedCall:
    caller_qualified_name: str
    callee_name: str


@dataclass
class ParsedFile:
    language: str
    loc: int
    symbols: list[ParsedSymbol]
    imports: list[ParsedImport]
    calls: list[ParsedCall]
