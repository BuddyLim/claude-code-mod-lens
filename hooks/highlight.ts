// The tokenizer the pane runs through `uv run --with pygments python -c`:
// argv is the file, then the first and last line wanted (1-based), then
// optionally "-" to read the text from stdin. It prints
// { lineCount, lines }, each line a list of [color, text] spans in the
// colours of VS Code's Dark+ theme ('' is the default foreground).
export const HIGHLIGHT_PY = String.raw`
import json, sys
from pygments.lexers import guess_lexer_for_filename, TextLexer
from pygments.token import Token as T

path, lo, hi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
# A fourth argument means the text comes on stdin (a commit's version of the
# file, which is not on disk); the path then only picks the lexer.
if len(sys.argv) > 4:
    text = sys.stdin.read()
else:
    text = open(path, encoding="utf-8", errors="replace").read()
try:
    lexer = guess_lexer_for_filename(path, text, stripnl=False, ensurenl=False)
except Exception:
    lexer = TextLexer(stripnl=False, ensurenl=False)

BLUE = set("""def class lambda None True False and or not in is const let var
function new typeof instanceof this super null undefined true false interface
type enum extends implements public private protected static readonly void
async declare namespace abstract""".split())
TYPES = set("str int float bool dict list set tuple bytes object type frozenset complex".split())
RULES = [
    (T.Comment, "#6A9955"), (T.String.Escape, "#D7BA7D"), (T.String.Interpol, "#569CD6"),
    (T.String, "#CE9178"), (T.Number, "#B5CEA8"), (T.Keyword.Type, "#4EC9B0"),
    (T.Keyword.Constant, "#569CD6"), (T.Operator.Word, "#569CD6"),
    (T.Name.Function, "#DCDCAA"), (T.Name.Decorator, "#DCDCAA"), (T.Name.Class, "#4EC9B0"),
    (T.Name.Exception, "#4EC9B0"), (T.Name.Namespace, "#4EC9B0"),
    (T.Name.Builtin.Pseudo, "#569CD6"), (T.Name.Builtin, "#DCDCAA"),
    (T.Name.Constant, "#4FC1FF"), (T.Name.Tag, "#569CD6"), (T.Name, "#9CDCFE"),
]

def color(tok, val, after):
    if tok in T.Name and val in TYPES:
        return "#4EC9B0"
    # A plain name that is called reads as a function, or a class when capitalised.
    if (tok is T.Name or tok is T.Name.Other) and after == "(":
        return "#4EC9B0" if val[:1].isupper() else "#DCDCAA"
    for kind, shade in RULES:
        if tok in kind:
            return shade
    if tok in T.Keyword:
        return "#569CD6" if val in BLUE else "#C586C0"
    return ""

tokens = [(tok, val) for tok, val in lexer.get_tokens(text) if val]
lines = [[]]
for i, (tok, val) in enumerate(tokens):
    after = tokens[i + 1][1][:1] if i + 1 < len(tokens) else ""
    shade = color(tok, val, after)
    for n, piece in enumerate(val.split("\n")):
        if n:
            lines.append([])
        piece = "".join(c for c in piece.replace("\t", "    ") if c >= " " and c != "\x7f")
        if not piece:
            continue
        row = lines[-1]
        if row and (row[-1][0] == shade or not piece.strip()):
            row[-1][1] += piece
        else:
            row.append([shade, piece])

print(json.dumps({"lineCount": len(lines), "lines": lines[lo - 1:hi]}))
`
