;; Match only named function declarations
;; Captures:
;;  - @function.name: identifier of the function
;;  - @function.decl: entire function declaration node (for source extraction)

(function_declaration
  name: (identifier) @function.name) @function.decl

(generator_function_declaration
  name: (identifier) @function.name) @function.decl
