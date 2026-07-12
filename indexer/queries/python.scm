; Python tree-sitter query placeholders for future parity work.
; These captures define extraction targets used by the parser roadmap.

(function_definition
  name: (identifier) @function.name) @function.definition

(class_definition
  name: (identifier) @class.name) @class.definition

(import_statement) @import.statement
(import_from_statement) @import.from_statement

(call
  function: (_) @call.callee) @call.expression
