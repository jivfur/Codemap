; JavaScript tree-sitter query placeholders for extraction targets.

(function_declaration
  name: (identifier) @function.name) @function.definition

(class_declaration
  name: (identifier) @class.name) @class.definition

(method_definition
  name: (property_identifier) @method.name) @method.definition

(import_statement) @import.statement

(call_expression
  function: (_) @call.callee) @call.expression
