// What the language-server bridge answers with, beyond diagnostics: the shapes
// the bridge (lsp.ts) produces and the pane's helpers (semantic.ts) and screens
// consume. Lines and columns are 1-based throughout; a column is a JS string
// index + 1 on the file's own text (a tab is one character).

// A position in a file. `path` is relative to the folder under review when the
// file is inside it (`isInRepo`), else absolute.
export type Place = { path: string; line: number; col: number; isInRepo: boolean }

// A place with the text of its line, trimmed, for a list a person reads.
export type PlaceLine = Place & { text: string }

// One entry of a file's outline: a function, class, method, variable and so
// on. `kind` is the LSP SymbolKind's name in lower case ('function', 'class',
// 'method', 'property', 'variable', 'constant', 'interface', 'enum', ...).
// `line`..`endLine` is everything it spans (its fold); `depth` is how deeply
// it is nested, 0 at the top. Entries come in the file's order, a parent
// before its children.
export type OutlineItem = {
  name: string
  kind: string
  line: number
  endLine: number
  col: number
  depth: number
}

// What a name is, as the server understands it: `type` and `modifiers` are the
// LSP semantic token names ('parameter', 'property', 'variable', 'function',
// 'method', 'class', 'type', 'namespace', 'enumMember', 'typeParameter', ...;
// 'readonly', 'declaration', 'defaultLibrary', 'async', ...). A token never
// spans lines.
export type SemanticToken = {
  line: number
  col: number
  length: number
  type: string
  modifiers: string[]
}

// A hint the server would draw inside the code: an inferred type after a name
// (': int'), or a parameter's name before an argument ('amount='). It sits
// before the character at `col`.
export type InlayHint = {
  line: number
  col: number
  label: string
  kind: 'type' | 'parameter' | 'other'
}

// One caller or callee of a function: its name and kind, where it is, and what
// the server says of it besides (its container or signature).
export type CallNode = { name: string; kind: string; place: Place; detail: string }

// A match of a project-wide search for a name.
export type SymbolHit = { name: string; kind: string; container: string; place: Place }

// The call the cursor is inside: its whole label, each parameter's own text,
// which one is active (0-based, -1 for none), and its docs.
export type Signature = { label: string; parameters: string[]; active: number; docs: string }
