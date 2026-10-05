// The language-server bridge the pane runs through `uv run --no-project python`:
// one standard-library script that is both the daemon keeping the language
// servers (pyright, tsserver, terraform-ls) running behind a unix socket, and
// the short-lived client that asks it for diagnostics. hooks/lsp.ts writes it
// to a temp folder and calls it; its own docstring has the protocol.
//
// String.raw: no backtick and no dollar-brace may appear in the script.
export const LSP_BRIDGE_PY = String.raw`
"""lens language-server bridge (standard library only).

  python bridge.py daemon   start the servers' keeper: listens on bridge.sock beside this file
  python bridge.py query    read one JSON request on stdin, print one JSON answer on stdout
  python bridge.py symbol   the same, for what a server knows of the symbol at one place
  python bridge.py ask      the same, for one of the lookups listed below
  python bridge.py status   print what the daemon is running
  python bridge.py stop     stop the daemon and its servers (a JSON {"root": dir} on stdin
                            stops only the servers of projects at or under that folder)

A query is {"repo": abs, "files": [rel...], "envRoot": abs?, "timeout": seconds?}.
The answer is {"ok": true, "files": {rel: {"tool": name, "diagnostics": [LSP diagnostics]}},
"notes": [...], "servers": [...]}: a file is in "files" only when a server answered for it.

A symbol request is {"repo": abs, "file": rel, "line": n, "col": n, "envRoot": abs?,
"timeout": seconds?}, the place 1-based, the column in the units the servers count in (UTF-16
code units, a tab being one). The answer is {"ok": true, "text": hover, "definition": {"path",
"line", "col", "isInRepo"}?, "notes": [...]}: the path relative to repo when it is inside it.
It may also hold "signature" ({"label", "parameters", "active", "docs"}, inside a call's
arguments), "typeDefinition" (a place, when it is not the definition) and "implementations"
(places).

An ask is {"what": name, "repo": abs, "file": rel, "envRoot": abs?, "timeout": seconds?} and
what the lookup needs besides. The answer is {"ok": true, "notes": [...]} and the lookup's
result, which is missing when there is none to give (the notes say why, when it is a failure):
  references  "line", "col"               -> "places": [place + "text"], "total"
  calls       "line", "col", "direction"  -> "calls": [{"name", "kind", "place", "detail"}]
  outline                                 -> "items": [{"name", "kind", "line", "endLine", "col", "depth"}]
  tokens                                  -> "types", "modifiers" (the legend) and "rows":
                                             [[line, col, length, type index, modifier bits]]
  symbols     "query", "near" (not "file"), "limit"
                                          -> "hits": [{"name", "kind", "container", "place"}]
  hints       "fromLine", "toLine"        -> "hints": [{"line", "col", "label", "kind"}]
"""
import bisect
import collections
import fcntl
import glob
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from urllib.parse import quote, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
SOCK = os.path.join(HERE, "bridge.sock")
LOCK = os.path.join(HERE, "bridge.lock")
LOG = os.path.join(HERE, "bridge.log")
IDLE_SECONDS = float(os.environ.get("DIAG_LSP_IDLE_SECONDS", "1800"))
# Set to make the Python server push its diagnostics (the path terraform-ls takes).
NO_PULL = os.environ.get("DIAG_LSP_NO_PULL") == "1"
AGAIN_SECONDS = 8.0
START_SECONDS = 60.0
QUIET_SECONDS = 0.4
# How long after its start pyright is waited for to say it has listed the project's files.
SCAN_SECONDS = 20.0
SCANNED = re.compile("Found \\d+ source files?|No source files found")
STALE_FILE_SECONDS = 600.0
MAX_PER_FILE = 1000
SYMBOL_SECONDS = 30.0
MAX_TEXT = 20000
# What one answer may hold: the client's output is cut at 4 MiB by what runs it.
MAX_PLACES = 1000
MAX_CALLS = 500
MAX_OUTLINE = 5000
MAX_TOKENS = 100000
MAX_HINTS = 5000
MAX_HITS = 500
MAX_IMPLEMENTATIONS = 50
MAX_LINE_TEXT = 300
ASKS = ("references", "calls", "outline", "tokens", "symbols", "hints")

with open(os.path.abspath(__file__), "rb") as _source:
    VERSION = hashlib.sha1(_source.read()).hexdigest()[:12]

PYTHON_EXT = (".py", ".pyi")
TYPESCRIPT_EXT = (".ts", ".tsx", ".mts", ".cts")
TERRAFORM_EXT = (".tf", ".tfvars")
TOOLS = {"python": "pyright", "typescript": "tsserver", "terraform": "terraform-ls"}


def log(*parts):
    try:
        with open(LOG, "a", encoding="utf-8") as out:
            out.write(time.strftime("%H:%M:%S ") + " ".join(str(p) for p in parts) + "\n")
    except OSError:
        pass


def node_dirs():
    found = []
    for path in glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/node")):
        name = path.split("/")[-3].lstrip("v")
        try:
            rank = tuple(int(part) for part in name.split("."))
        except ValueError:
            rank = (0,)
        found.append((rank, os.path.dirname(path)))
    return [folder for _, folder in sorted(found, reverse=True)]


def child_env():
    env = dict(os.environ)
    paths = [p for p in env.get("PATH", "").split(os.pathsep) if p]
    extra = ["/opt/homebrew/bin", "/usr/local/bin"]
    if shutil.which("node", path=os.pathsep.join(paths + extra)) is None:
        extra = node_dirs()[:1] + extra
    for folder in extra:
        if folder not in paths:
            paths.append(folder)
    env["PATH"] = os.pathsep.join(paths)
    return env


ENV = child_env()


def which(name):
    return shutil.which(name, path=ENV["PATH"])


def to_uri(path):
    return "file://" + quote(path)


def from_uri(uri):
    return os.path.realpath(unquote(urlparse(uri).path))


def language_of(rel):
    lower = rel.lower()
    if lower.endswith(PYTHON_EXT):
        return "python"
    if lower.endswith(TYPESCRIPT_EXT):
        return "typescript"
    if lower.endswith(TERRAFORM_EXT):
        return "terraform"
    return None


def venv_python(folder):
    for name in (".venv", "venv"):
        python = os.path.join(folder, name, "bin", "python")
        if os.path.exists(python):
            return python
    return None


def is_python_root(folder):
    return (
        os.path.isfile(os.path.join(folder, "pyproject.toml"))
        or os.path.isfile(os.path.join(folder, "pyrightconfig.json"))
        or venv_python(folder) is not None
    )


def is_typescript_root(folder):
    return os.path.isfile(os.path.join(folder, "tsconfig.json"))


def nearest(repo, rel_dir, is_root):
    """The nearest folder at or above rel_dir, inside repo, that is_root accepts ('.' is repo)."""
    folder = rel_dir or "."
    while True:
        if is_root(os.path.normpath(os.path.join(repo, folder))):
            return folder
        if folder in (".", ""):
            return None
        folder = os.path.dirname(folder) or "."


def root_of(repo, rel, language):
    rel_dir = os.path.dirname(rel) or "."
    if language == "python":
        return nearest(repo, rel_dir, is_python_root) or "."
    if language == "typescript":
        return nearest(repo, rel_dir, is_typescript_root)
    return rel_dir


def find_up(folder, tail):
    while True:
        path = os.path.join(folder, tail)
        if os.path.exists(path):
            return path
        parent = os.path.dirname(folder)
        if parent == folder:
            return None
        folder = parent


SKIPPED_FOLDERS = ("node_modules", "__pycache__", "venv", "site-packages")


def snapshot(root, suffixes):
    """Each source file under root (hidden folders and installed packages aside) and its stamp."""
    seen = {}
    for folder, folders, names in os.walk(root):
        folders[:] = [d for d in folders if not d.startswith(".") and d not in SKIPPED_FOLDERS]
        for name in names:
            if name.endswith(suffixes):
                path = os.path.join(folder, name)
                try:
                    stat = os.stat(path)
                except OSError:
                    continue
                seen[path] = (stat.st_mtime_ns, stat.st_size)
    return seen


class Unavailable(Exception):
    pass


class Server:
    """One language server process and what is known of the files opened in it."""

    def __init__(self, tool, label, root, argv):
        self.tool = tool
        self.label = label
        self.root = root
        self.argv = argv
        self.proc = None
        self.dead = False
        self.write_lock = threading.Lock()
        self.query_lock = threading.Lock()
        self.cond = threading.Condition()
        self.pending = {}
        self.next_id = 0
        self.opened = {}
        self.stderr_tail = collections.deque(maxlen=20)
        self.started_at = time.time()
        self.last_used = time.time()

    def spawn(self):
        try:
            self.proc = subprocess.Popen(
                self.argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=HERE,
                env=ENV,
                start_new_session=True,
            )
        except OSError as error:
            raise Unavailable("failed to start: " + str(error))
        threading.Thread(target=self.read_loop, daemon=True).start()
        threading.Thread(target=self.drain_stderr, daemon=True).start()

    def drain_stderr(self):
        for raw in self.proc.stderr:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                self.stderr_tail.append(line)

    def read_message(self):
        out = self.proc.stdout
        length = None
        while True:
            line = out.readline()
            if not line:
                return None
            line = line.strip()
            if not line:
                if length is None:
                    continue
                break
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":", 1)[1])
        body = out.read(length)
        if len(body) < length:
            return None
        try:
            return json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            return {}

    def read_loop(self):
        try:
            while True:
                message = self.read_message()
                if message is None:
                    break
                self.on_message(message)
        except Exception as error:  # a broken pipe or a bad frame ends the server
            log(self.label, "reader stopped:", repr(error))
        finally:
            with self.cond:
                self.dead = True
                for slot in self.pending.values():
                    slot["event"].set()
                self.cond.notify_all()
            log(self.label, "exited;", " | ".join(list(self.stderr_tail)[-3:]))

    def write(self, data):
        if self.dead:
            raise Unavailable("server exited")
        try:
            with self.write_lock:
                self.proc.stdin.write(data)
                self.proc.stdin.flush()
        except (OSError, ValueError):
            raise Unavailable("server exited")

    def slot(self):
        with self.cond:
            self.next_id += 1
            ident = self.next_id
            slot = {"event": threading.Event(), "message": None}
            self.pending[ident] = slot
        return ident, slot

    def settle(self, ident, message):
        with self.cond:
            slot = self.pending.pop(ident, None)
        if slot is not None:
            slot["message"] = message
            slot["event"].set()

    def await_slot(self, ident, slot, deadline):
        done = slot["event"].wait(max(0.0, deadline - time.time()))
        with self.cond:
            self.pending.pop(ident, None)
        if slot["message"] is not None:
            return slot["message"]
        if not done:
            raise TimeoutError()
        raise Unavailable("server exited: " + self.why())

    def why(self):
        return " | ".join(list(self.stderr_tail)[-3:])[-400:] or "no output"

    def kill(self):
        self.dead = True
        if self.proc is None:
            return
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except OSError:
            pass
        try:
            self.proc.wait(timeout=2)
        except Exception:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except OSError:
                pass

    def hold(self, path, deadline):
        """Takes the query lock for a symbol lookup. Returns whether it was taken.

        A diagnostics query holds the lock until its answers are in. A lookup in a file that
        is already open does not wait for that: it asks about the text the server has.
        """
        if self.query_lock.acquire(False):
            return True
        if path in self.opened:
            return False
        if not self.query_lock.acquire(True, max(0.01, deadline - time.time())):
            raise TimeoutError()
        return True

    def refresh(self, wanted):
        """Brings the files opened by earlier queries up to date with the disk.

        An open file's text is the server's own copy, so one left as it was would hide what
        was since written to it from every file that imports it.
        """
        now = time.time()
        for path, doc in list(self.opened.items()):
            if path in wanted:
                continue
            text = read_text(path)
            if text is None or now - doc["used"] > STALE_FILE_SECONDS:
                self.close_file(path)
            else:
                used = doc["used"]
                self.sync(path, text)
                doc["used"] = used

    def attend(self, path, deadline, work):
        """work(text) with the file (when there is one) as it is on disk now open in the server.

        Like a symbol lookup it does not wait for a diagnostics query when the file is already
        open: it then asks about the text the server has.
        """
        text = read_text(path) if path else None
        is_held = self.hold(path, deadline)
        try:
            self.last_used = time.time()
            if is_held:
                self.catch_up()
                self.refresh(set([path]))
                if text is not None:
                    self.sync(path, text)
            return work(text)
        finally:
            self.last_used = time.time()
            if is_held:
                self.query_lock.release()

    def catch_up(self):
        pass


def read_text(path):
    try:
        with open(path, "rb") as source:
            return source.read().decode("utf-8", "replace")
    except OSError:
        return None


def digest(text):
    return hashlib.md5(text.encode("utf-8", "replace")).hexdigest()


def hover_text(contents):
    """The text of a hover: marked-up content, a marked string, or a list of either."""
    if isinstance(contents, str):
        return contents.strip()
    if isinstance(contents, list):
        return "\n\n".join(part for part in (hover_text(one) for one in contents) if part)
    if isinstance(contents, dict):
        return str(contents.get("value") or "").strip()
    return ""


def places_of(result):
    """The 1-based (path, line, col) of each location or location link in a definition answer."""
    items = result if isinstance(result, list) else [result]
    places = []
    for item in items:
        if not isinstance(item, dict):
            continue
        uri = item.get("uri") or item.get("targetUri") or ""
        span = item.get("range") or item.get("targetSelectionRange") or item.get("targetRange") or {}
        if not uri.startswith("file:"):
            continue
        start = span.get("start") or {}
        places.append((from_uri(uri), int(start.get("line") or 0) + 1, int(start.get("character") or 0) + 1))
    return places


def ts_text(value):
    """What tsserver sends as a string or, by preference, as display parts."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(str(part.get("text", "")) if isinstance(part, dict) else str(part) for part in value)
    return ""


LINE_BREAK = re.compile("\r\n|\r|\n")
# Where tsserver starts a new line.
TS_LINE_BREAK = re.compile("\r\n|[\n\r\u2028\u2029]")

# The Language Server Protocol's SymbolKind, by number.
SYMBOL_KINDS = (
    "", "file", "module", "namespace", "package", "class", "method", "property", "field",
    "constructor", "enum", "interface", "function", "variable", "constant", "string", "number",
    "boolean", "array", "object", "key", "null", "enumMember", "struct", "event", "operator",
    "typeParameter",
)  # fmt: skip

# tsserver's ScriptElementKind, as the nearest SymbolKind name ("type" is a type alias, which
# has none).
TS_KINDS = {
    "script": "file",
    "module": "module",
    "external module name": "module",
    "directory": "file",
    "class": "class",
    "local class": "class",
    "interface": "interface",
    "type": "type",
    "primitive type": "type",
    "enum": "enum",
    "enum member": "enumMember",
    "var": "variable",
    "local var": "variable",
    "let": "variable",
    "using": "variable",
    "await using": "variable",
    "parameter": "variable",
    "alias": "variable",
    "const": "constant",
    "function": "function",
    "local function": "function",
    "method": "method",
    "call": "method",
    "index": "method",
    "construct": "constructor",
    "constructor": "constructor",
    "property": "property",
    "getter": "property",
    "setter": "property",
    "accessor": "property",
    "JSX attribute": "property",
    "type parameter": "typeParameter",
    "string": "string",
    "label": "key",
}

# The semantic token names a client here understands (the protocol's own).
TOKEN_TYPES = [
    "namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter",
    "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword",
    "modifier", "comment", "string", "number", "regexp", "operator", "decorator",
]  # fmt: skip
TOKEN_MODIFIERS = [
    "declaration", "definition", "readonly", "static", "deprecated", "abstract", "async",
    "modification", "documentation", "defaultLibrary",
]  # fmt: skip
# tsserver's "2020" classifications, in its own order: a span's class is
# ((type + 1) << 8) + modifier bits. Its "member" is the protocol's "method".
TS_TOKEN_TYPES = [
    "class", "enum", "interface", "namespace", "typeParameter", "type", "parameter", "variable",
    "enumMember", "property", "function", "method",
]  # fmt: skip
TS_TOKEN_MODIFIERS = ["declaration", "static", "async", "readonly", "defaultLibrary", "local"]

HINT_KINDS = {1: "type", 2: "parameter", "Type": "type", "Parameter": "parameter"}


def kind_name(number):
    try:
        return SYMBOL_KINDS[int(number)]
    except (TypeError, ValueError, IndexError):
        return ""


def ts_kind(kind):
    return TS_KINDS.get(str(kind or ""), "variable")


def utf16_len(text):
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def utf16_slice(text, start, end):
    raw = text.encode("utf-16-le", "surrogatepass")
    return raw[2 * start : 2 * end].decode("utf-16-le", "replace")


def line_starts(text):
    """The offset each of tsserver's lines starts at, in the UTF-16 code units it counts in."""
    is_wide = utf16_len(text) != len(text)
    starts, extra, last = [0], 0, 0
    for found in TS_LINE_BREAK.finditer(text):
        if is_wide:
            extra += sum(1 for char in text[last : found.end()] if ord(char) > 0xFFFF)
            last = found.end()
        starts.append(found.end() + extra)
    return starts


class LineTexts:
    """The text of a line of a file on disk, each file read once."""

    def __init__(self):
        self.files = {}

    def raw(self, path, line):
        lines = self.files.get(path)
        if lines is None:
            source = read_text(path)
            lines = LINE_BREAK.split(source) if source is not None else []
            self.files[path] = lines
        return lines[line - 1] if 1 <= line <= len(lines) else ""

    def text(self, path, line):
        return self.raw(path, line).strip()[:MAX_LINE_TEXT]


def padded(label, kind, is_left, is_right):
    """A hint's label with the space the server wants around it. A type's hint follows its
    name directly (': int'), whatever the server says."""
    left = " " if is_left and kind != "type" and not label.startswith(" ") else ""
    return left + label + (" " if is_right and not label.endswith(" ") else "")


def outline_item(name, kind, line, col, end_line, end_col, name_line, name_col, depth):
    """One outline entry from 1-based places: its whole span, and its name's column when the
    name is on the span's first line."""
    if end_col <= 1 and end_line > line:
        # It ends before the first character of a line: that line is not part of it.
        end_line -= 1
    return {
        "name": str(name or "")[:MAX_LINE_TEXT],
        "kind": kind,
        "line": line,
        "endLine": max(line, end_line),
        "col": name_col if name_line == line else col,
        "depth": depth,
    }


def lsp_signature(result):
    """The active signature of a signatureHelp answer, or None."""
    if not isinstance(result, dict):
        return None
    signatures = [one for one in result.get("signatures") or [] if isinstance(one, dict)]
    if not signatures:
        return None
    index = result.get("activeSignature")
    chosen = signatures[index] if isinstance(index, int) and 0 <= index < len(signatures) else signatures[0]
    label = str(chosen.get("label") or "")
    parameters = []
    for one in chosen.get("parameters") or []:
        name = one.get("label") if isinstance(one, dict) else one
        if isinstance(name, list) and len(name) == 2:
            name = utf16_slice(label, int(name[0]), int(name[1]))
        parameters.append(str(name or ""))
    active = chosen.get("activeParameter")
    if active is None:
        active = result.get("activeParameter")
    if not isinstance(active, int) or not 0 <= active < len(parameters):
        active = -1
    return {
        "label": label[:MAX_TEXT],
        "parameters": parameters,
        "active": active,
        "docs": hover_text(chosen.get("documentation"))[:MAX_TEXT],
    }


def ts_signature(body):
    """The selected item of tsserver's signatureHelp answer, or None."""
    if not isinstance(body, dict):
        return None
    items = [one for one in body.get("items") or [] if isinstance(one, dict)]
    if not items:
        return None
    index = body.get("selectedItemIndex")
    chosen = items[index] if isinstance(index, int) and 0 <= index < len(items) else items[0]
    parameters = [ts_text(one.get("displayParts")) for one in chosen.get("parameters") or []]
    label = (
        ts_text(chosen.get("prefixDisplayParts"))
        + ts_text(chosen.get("separatorDisplayParts")).join(parameters)
        + ts_text(chosen.get("suffixDisplayParts"))
    )
    active = body.get("argumentIndex")
    if isinstance(active, int) and active >= len(parameters) and chosen.get("isVariadic"):
        active = len(parameters) - 1
    if not isinstance(active, int) or not 0 <= active < len(parameters):
        active = -1
    return {
        "label": label[:MAX_TEXT],
        "parameters": parameters,
        "active": active,
        "docs": ts_text(chosen.get("documentation")).strip()[:MAX_TEXT],
    }


class LspServer(Server):
    def __init__(self, tool, label, root, argv, language_ids, settings, wants_pull, watched):
        Server.__init__(self, tool, label, root, argv)
        self.watched = watched
        self.snapshot = {}
        self.epoch = 0
        self.language_ids = language_ids
        self.settings = settings
        self.wants_pull = wants_pull
        self.is_pull = False
        self.seq = 0
        self.published = {}
        self.capabilities = {}
        self.scanned = threading.Event()

    def send(self, message):
        message["jsonrpc"] = "2.0"
        body = json.dumps(message).encode("utf-8")
        self.write(b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)

    def notify(self, method, params):
        self.send({"method": method, "params": params})

    def request(self, method, params, deadline):
        ident, slot = self.slot()
        self.send({"id": ident, "method": method, "params": params})
        return self.await_slot(ident, slot, deadline)

    def setting(self, section):
        value = self.settings
        for part in (section or "").split("."):
            if not part:
                continue
            if not isinstance(value, dict) or part not in value:
                return None
            value = value[part]
        return value

    def on_message(self, message):
        method = message.get("method")
        if method is None:
            if "id" in message:
                self.settle(message["id"], message)
            return
        if "id" in message:
            result = None
            if method == "workspace/configuration":
                items = (message.get("params") or {}).get("items") or []
                result = [self.setting(item.get("section")) for item in items]
            try:
                self.send({"id": message["id"], "result": result})
            except Unavailable:
                pass
            return
        if method == "window/logMessage":
            if SCANNED.match(str((message.get("params") or {}).get("message") or "")):
                self.scanned.set()
            return
        if method == "textDocument/publishDiagnostics":
            params = message.get("params") or {}
            path = from_uri(params.get("uri", ""))
            with self.cond:
                self.seq += 1
                self.published[path] = {
                    "seq": self.seq,
                    "version": params.get("version"),
                    "items": params.get("diagnostics") or [],
                    "at": time.time(),
                }
                self.cond.notify_all()

    def start(self):
        self.spawn()
        text_document = {
            "synchronization": {"dynamicRegistration": False, "didSave": False},
            "publishDiagnostics": {
                "versionSupport": True,
                "relatedInformation": False,
                # 1 is Unnecessary: the server then reports unread names, as hints.
                "tagSupport": {"valueSet": [1]},
            },
            "hover": {"dynamicRegistration": False, "contentFormat": ["plaintext"]},
            "definition": {"dynamicRegistration": False, "linkSupport": False},
            "typeDefinition": {"dynamicRegistration": False, "linkSupport": False},
            "implementation": {"dynamicRegistration": False, "linkSupport": False},
            "references": {"dynamicRegistration": False},
            "callHierarchy": {"dynamicRegistration": False},
            "documentSymbol": {
                "dynamicRegistration": False,
                "hierarchicalDocumentSymbolSupport": True,
            },
            "signatureHelp": {
                "dynamicRegistration": False,
                "signatureInformation": {
                    "documentationFormat": ["plaintext"],
                    "parameterInformation": {"labelOffsetSupport": False},
                    "activeParameterSupport": True,
                },
            },
            "semanticTokens": {
                "dynamicRegistration": False,
                "requests": {"full": True, "range": True},
                "tokenTypes": TOKEN_TYPES,
                "tokenModifiers": TOKEN_MODIFIERS,
                "formats": ["relative"],
                "overlappingTokenSupport": False,
                "multilineTokenSupport": False,
            },
            "inlayHint": {"dynamicRegistration": False},
        }
        if self.wants_pull:
            text_document["diagnostic"] = {"dynamicRegistration": False}
        answer = self.request(
            "initialize",
            {
                "processId": os.getpid(),
                "clientInfo": {"name": "lens"},
                "rootPath": self.root,
                "rootUri": to_uri(self.root),
                "workspaceFolders": [{"uri": to_uri(self.root), "name": os.path.basename(self.root)}],
                "capabilities": {
                    "workspace": {
                        "configuration": True,
                        "workspaceFolders": True,
                        "symbol": {"dynamicRegistration": False},
                    },
                    "textDocument": text_document,
                },
                "initializationOptions": {},
            },
            time.time() + START_SECONDS,
        )
        if "error" in answer:
            raise Unavailable("initialize failed: " + str(answer["error"].get("message")))
        capabilities = (answer.get("result") or {}).get("capabilities") or {}
        self.capabilities = capabilities
        log(self.label, "offers:", " ".join(sorted(key for key, value in capabilities.items() if value)))
        self.is_pull = self.wants_pull and bool(capabilities.get("diagnosticProvider"))
        self.notify("initialized", {})
        self.snapshot = snapshot(self.root, self.watched)
        self.notify("workspace/didChangeConfiguration", {"settings": self.settings})

    def stop(self):
        try:
            self.request("shutdown", None, time.time() + 2)
            self.notify("exit", None)
        except Exception:
            pass
        self.kill()

    def close_file(self, path):
        if self.opened.pop(path, None) is not None:
            self.notify("textDocument/didClose", {"textDocument": {"uri": to_uri(path)}})
            with self.cond:
                self.published.pop(path, None)

    def language_id(self, path):
        for suffix, ident in self.language_ids:
            if path.endswith(suffix):
                return ident
        return self.language_ids[0][1]

    def sync(self, path, text, is_forced=False):
        """Opens the file or sends its new text. Returns whether anything was sent.

        is_forced sends the text even when it is the same, so that the server checks the
        file again and answers for the new version.
        """
        doc = self.opened.get(path)
        stamp = digest(text)
        if doc is None:
            self.opened[path] = {"version": 1, "digest": stamp, "used": time.time(), "epoch": -1}
            self.notify(
                "textDocument/didOpen",
                {
                    "textDocument": {
                        "uri": to_uri(path),
                        "languageId": self.language_id(path),
                        "version": 1,
                        "text": text,
                    }
                },
            )
            return True
        doc["used"] = time.time()
        if doc["digest"] == stamp and not is_forced:
            return False
        doc["version"] += 1
        doc["digest"] = stamp
        self.notify(
            "textDocument/didChange",
            {
                "textDocument": {"uri": to_uri(path), "version": doc["version"]},
                "contentChanges": [{"text": text}],
            },
        )
        return True

    def tell_changes(self):
        """Tells the server which of the project's files changed on disk since the last query.

        Neither server here watches the disk itself (the editor does that for them), so a
        change to a file that is not open would otherwise never reach it.
        """
        seen = snapshot(self.root, self.watched)
        changes = []
        for path, stamp in seen.items():
            before = self.snapshot.get(path)
            if before is None:
                changes.append({"uri": to_uri(path), "type": 1})
            elif before != stamp:
                changes.append({"uri": to_uri(path), "type": 2})
        for path in self.snapshot:
            if path not in seen:
                changes.append({"uri": to_uri(path), "type": 3})
        self.snapshot = seen
        if changes:
            self.epoch += 1
            self.notify("workspace/didChangeWatchedFiles", {"changes": changes[:5000]})

    def query(self, files, deadline):
        """files: [(rel, abs)]. Returns ({rel: [diagnostics]}, [notes])."""
        with self.query_lock:
            self.last_used = time.time()
            results, waiting = {}, []
            self.tell_changes()
            self.refresh(set(path for _, path in files))
            with self.cond:
                before = self.seq
            for rel, path in files:
                text = read_text(path)
                if text is None:
                    # A file that is gone has nothing wrong with it.
                    self.close_file(path)
                    results[rel] = []
                    continue
                state = "sent" if self.sync(path, text) else "same"
                if state == "same" and self.opened[path]["epoch"] != self.epoch:
                    # Something else in the project changed since this file was last
                    # answered for: what the server holds for it may be out of date, and
                    # it answers from what it holds. Sending the text again makes it check.
                    self.sync(path, text, True)
                    state = "again"
                waiting.append((rel, path, state))
            if self.is_pull:
                late = self.pull(waiting, results, deadline)
            else:
                late = self.await_published(waiting, results, before, deadline)
            for rel, path, _ in waiting:
                if rel in results:
                    self.opened[path]["epoch"] = self.epoch
            self.last_used = time.time()
            notes = []
            if late:
                notes.append("%s: no answer in time for %d file(s)" % (self.label, late))
            return results, notes

    def lookup(self, method, path, line, col, deadline, notes):
        """One position request's result, or None. A request the server dropped is sent again."""
        params = {
            "textDocument": {"uri": to_uri(path)},
            "position": {"line": line - 1, "character": col - 1},
        }
        tries = 0
        while True:
            answer = self.request(method, params, deadline)
            error = answer.get("error")
            if error is None:
                return answer.get("result")
            tries += 1
            if tries > 5 or time.time() > deadline:
                log(self.label, method, "failed:", error)
                message = error.get("message") if isinstance(error, dict) else error
                notes.append("%s: %s failed: %s" % (self.label, method, str(message)[:200]))
                return None
            time.sleep(0.05)

    def symbol(self, path, line, col, deadline):
        """The hover text and the definitions [(path, line, col)] of a 1-based place, and notes."""
        text = read_text(path)
        is_held = self.hold(path, deadline)
        try:
            self.last_used = time.time()
            if is_held and text is not None:
                self.tell_changes()
                self.sync(path, text)
            notes = []
            hover = self.lookup("textDocument/hover", path, line, col, deadline, notes)
            found = self.lookup("textDocument/definition", path, line, col, deadline, notes)
            self.last_used = time.time()
            contents = hover.get("contents") if isinstance(hover, dict) else None
            places = places_of(found)
            try:
                extras = self.more(path, line, col, deadline, places)
            except TimeoutError:
                extras = {}
            self.last_used = time.time()
            return hover_text(contents), places, notes, extras
        finally:
            if is_held:
                self.query_lock.release()

    def more(self, path, line, col, deadline, defined):
        """What else is known of a place: the call it is in, its type's and its implementers'
        places. Only what the server offers is asked for, and a failure is nothing."""
        extras, quiet = {}, []
        if self.capabilities.get("signatureHelpProvider"):
            signature = lsp_signature(self.lookup("textDocument/signatureHelp", path, line, col, deadline, quiet))
            if signature is not None:
                extras["signature"] = signature
        if self.capabilities.get("typeDefinitionProvider"):
            found = self.lookup("textDocument/typeDefinition", path, line, col, deadline, quiet)
            types = places_of(found)
            # A class or a function is its own type: that is the definition again.
            extras["types"] = [] if any(place in defined for place in types) else types
        if self.capabilities.get("implementationProvider"):
            found = self.lookup("textDocument/implementation", path, line, col, deadline, quiet)
            extras["implementations"] = [place for place in places_of(found) if place not in defined]
        return extras

    def catch_up(self):
        self.tell_changes()

    def await_scan(self, deadline):
        """Waits for a pyright that has just started to list the project's files: until then
        it answers a project-wide lookup from the few files it was shown."""
        if self.tool == "pyright" and not self.scanned.is_set():
            self.scanned.wait(max(0.0, min(deadline, self.started_at + SCAN_SECONDS) - time.time()))

    def offers(self, provider, what, notes):
        if self.capabilities.get(provider):
            return True
        notes.append("%s does not offer %s" % (self.tool, what))
        return False

    def call(self, method, params, deadline, notes, what):
        """A request's result, or None with a note. One the server dropped is sent again."""
        tries = 0
        while True:
            answer = self.request(method, params, deadline)
            error = answer.get("error")
            if error is None:
                return answer.get("result")
            code = error.get("code") if isinstance(error, dict) else None
            if code == -32601:
                notes.append("%s does not offer %s" % (self.tool, what))
                return None
            tries += 1
            if tries > 5 or time.time() > deadline:
                log(self.label, method, "failed:", error)
                message = error.get("message") if isinstance(error, dict) else error
                notes.append("%s: %s failed: %s" % (self.label, method, str(message)[:200]))
                return None
            time.sleep(0.05)

    @staticmethod
    def at(path, line, col):
        return {
            "textDocument": {"uri": to_uri(path)},
            "position": {"line": line - 1, "character": col - 1},
        }

    def references(self, path, line, col, deadline):
        """[(path, line, col, None)] of every use of the symbol at a place, and notes."""
        notes = []

        def work(_):
            if not self.offers("referencesProvider", "references", notes):
                return []
            self.await_scan(deadline)
            params = dict(self.at(path, line, col), context={"includeDeclaration": True})
            found = self.call("textDocument/references", params, deadline, notes, "references")
            return [place + (None,) for place in places_of(found or [])]

        return self.attend(path, deadline, work), notes

    def calls(self, path, line, col, direction, deadline):
        """The callers or the callees of the function at a place, and notes."""
        notes = []

        def work(_):
            what = "a call hierarchy"
            if not self.offers("callHierarchyProvider", what, notes):
                return []
            self.await_scan(deadline)
            items = self.call("textDocument/prepareCallHierarchy", self.at(path, line, col), deadline, notes, what)
            if isinstance(items, dict):
                items = [items]
            method, side = "callHierarchy/outgoingCalls", "to"
            if direction == "incoming":
                method, side = "callHierarchy/incomingCalls", "from"
            found = []
            for item in (items or [])[:5]:
                for one in self.call(method, {"item": item}, deadline, notes, what) or []:
                    node = one.get(side) or {}
                    uri = str(node.get("uri") or "")
                    if not uri.startswith("file:"):
                        continue
                    span = node.get("selectionRange") or node.get("range") or {}
                    start = span.get("start") or {}
                    found.append(
                        {
                            "name": str(node.get("name") or ""),
                            "kind": kind_name(node.get("kind")),
                            "path": from_uri(uri),
                            "line": int(start.get("line") or 0) + 1,
                            "col": int(start.get("character") or 0) + 1,
                            "detail": str(node.get("detail") or ""),
                        }
                    )
            return found

        return self.attend(path, deadline, work), notes

    def outline(self, path, deadline):
        """The file's symbols in its order, parents first, and notes."""
        notes = []

        def work(_):
            what = "an outline"
            if not self.offers("documentSymbolProvider", what, notes):
                return []
            doc = {"textDocument": {"uri": to_uri(path)}}
            result = self.call("textDocument/documentSymbol", doc, deadline, notes, what)
            items = []

            def span_of(node):
                return node.get("range") or (node.get("location") or {}).get("range") or {}

            def start_of(node):
                start = span_of(node).get("start") or {}
                return (int(start.get("line") or 0), int(start.get("character") or 0))

            def walk(nodes, depth):
                for node in sorted((one for one in nodes if isinstance(one, dict)), key=start_of):
                    span = span_of(node)
                    end = span.get("end") or span.get("start") or {}
                    name = (node.get("selectionRange") or span).get("start") or {}
                    line, col = start_of(node)
                    items.append(
                        outline_item(
                            node.get("name"),
                            kind_name(node.get("kind")),
                            line + 1,
                            col + 1,
                            int(end.get("line") or 0) + 1,
                            int(end.get("character") or 0) + 1,
                            int(name.get("line") or 0) + 1,
                            int(name.get("character") or 0) + 1,
                            depth,
                        )
                    )
                    walk(node.get("children") or [], depth + 1)

            walk(result if isinstance(result, list) else [], 0)
            return items

        return self.attend(path, deadline, work), notes

    def tokens(self, path, deadline):
        """The file's semantic tokens: (type names, modifier names, rows), and notes.

        A row is [line, col, length, index of its type, bits of its modifiers].
        """
        notes = []

        def work(text):
            what = "semantic tokens"
            provider = self.capabilities.get("semanticTokensProvider")
            if not isinstance(provider, dict) or not (provider.get("full") or provider.get("range")):
                notes.append("%s does not offer %s" % (self.tool, what))
                return [], [], []
            legend = provider.get("legend") or {}
            doc = {"textDocument": {"uri": to_uri(path)}}
            if provider.get("full"):
                result = self.call("textDocument/semanticTokens/full", doc, deadline, notes, what)
            else:
                end = {"line": len(LINE_BREAK.split(text or "")), "character": 0}
                doc["range"] = {"start": {"line": 0, "character": 0}, "end": end}
                result = self.call("textDocument/semanticTokens/range", doc, deadline, notes, what)
            data = result.get("data") if isinstance(result, dict) else None
            rows, line, char = [], 0, 0
            for index in range(0, len(data or []) - 4, 5):
                if data[index]:
                    line += data[index]
                    char = data[index + 1]
                else:
                    char += data[index + 1]
                rows.append([line + 1, char + 1, data[index + 2], data[index + 3], data[index + 4]])
            return list(legend.get("tokenTypes") or []), list(legend.get("tokenModifiers") or []), rows

        return self.attend(path, deadline, work), notes

    def symbols(self, query, near, limit, deadline):
        """The project's symbols whose name matches, the closest matches first, and notes."""
        notes = []

        def rank(hit):
            name = hit["name"]
            if name == query:
                return 0
            if name.lower() == query.lower():
                return 1
            return 2 if name.lower().startswith(query.lower()) else 3

        def work(_):
            what = "a symbol search"
            if not self.offers("workspaceSymbolProvider", what, notes):
                return []
            self.await_scan(deadline)
            hits = []
            for item in self.call("workspace/symbol", {"query": query}, deadline, notes, what) or []:
                location = item.get("location") or {}
                uri = str(location.get("uri") or "")
                if not uri.startswith("file:"):
                    continue
                start = (location.get("range") or {}).get("start") or {}
                hits.append(
                    {
                        "name": str(item.get("name") or ""),
                        "kind": kind_name(item.get("kind")),
                        "container": str(item.get("containerName") or ""),
                        "path": from_uri(uri),
                        "line": int(start.get("line") or 0) + 1,
                        "col": int(start.get("character") or 0) + 1,
                    }
                )
            hits.sort(key=rank)
            return hits[:limit]

        return self.attend(near, deadline, work), notes

    def hints(self, path, first, last, deadline):
        """The inlay hints of lines first..last, and notes."""
        notes = []

        def work(_):
            what = "inlay hints"
            if not self.offers("inlayHintProvider", what, notes):
                return []
            params = {
                "textDocument": {"uri": to_uri(path)},
                "range": {"start": {"line": first - 1, "character": 0}, "end": {"line": last, "character": 0}},
            }
            hints = []
            for item in self.call("textDocument/inlayHint", params, deadline, notes, what) or []:
                at = item.get("position") or {}
                label = item.get("label")
                if isinstance(label, list):
                    label = "".join(str(part.get("value") or "") for part in label if isinstance(part, dict))
                kind = HINT_KINDS.get(item.get("kind"), "other")
                hints.append(
                    {
                        "line": int(at.get("line") or 0) + 1,
                        "col": int(at.get("character") or 0) + 1,
                        "label": padded(str(label or ""), kind, item.get("paddingLeft"), item.get("paddingRight")),
                        "kind": kind,
                    }
                )
            return hints

        return self.attend(path, deadline, work), notes

    def pull(self, waiting, results, deadline):
        late = 0
        slots = []
        for rel, path, _ in waiting:
            ident, slot = self.slot()
            self.send(
                {
                    "id": ident,
                    "method": "textDocument/diagnostic",
                    "params": {"textDocument": {"uri": to_uri(path)}},
                }
            )
            slots.append((rel, path, ident, slot))
        for rel, path, ident, slot in slots:
            tries = 0
            while True:
                try:
                    answer = self.await_slot(ident, slot, deadline)
                except TimeoutError:
                    late += 1
                    break
                error = answer.get("error")
                if error is None:
                    report = answer.get("result") or {}
                    if report.get("kind", "full") == "full":
                        results[rel] = report.get("items") or []
                    else:
                        late += 1
                    break
                tries += 1
                # The server drops a pull when the program changes under it, and asks for another.
                if tries > 20 or time.time() > deadline:
                    late += 1
                    log(self.label, "pull failed:", error)
                    break
                time.sleep(0.05)
                ident, slot = self.slot()
                self.send(
                    {
                        "id": ident,
                        "method": "textDocument/diagnostic",
                        "params": {"textDocument": {"uri": to_uri(path)}},
                    }
                )
        return late

    def await_published(self, waiting, results, before, deadline):
        """Waits until each file sent has diagnostics newer than the send, and they went quiet.

        A file sent again with the same text may get no new diagnostics from a server that
        sees nothing to do; after a grace period what it last published stands.
        """
        grace_at = time.time() + AGAIN_SECONDS

        def fresh(path, state):
            seen = self.published.get(path)
            if seen is None:
                return None
            if state == "same" or (state == "again" and time.time() >= grace_at):
                return seen
            version = self.opened[path]["version"]
            if seen["seq"] > before and seen["version"] in (None, version):
                return seen
            return None

        with self.cond:
            while not self.dead:
                now = time.time()
                found = [fresh(path, state) for _, path, state in waiting]
                if all(one is not None for one in found):
                    newest = max([one["at"] for one in found if one["seq"] > before] or [0.0])
                    quiet_at = newest + QUIET_SECONDS
                    if now >= quiet_at:
                        break
                    self.cond.wait(min(quiet_at, deadline) - now + 0.01)
                elif now >= deadline:
                    break
                else:
                    until = deadline if now >= grace_at else min(deadline, grace_at)
                    self.cond.wait(until - now + 0.01)
                if time.time() >= deadline:
                    break
            late = 0
            for rel, path, state in waiting:
                seen = fresh(path, state)
                if seen is None:
                    late += 1
                else:
                    results[rel] = seen["items"]
            if self.dead:
                raise Unavailable("server exited: " + self.why())
            return late


TS_CATEGORY = {"error": 1, "warning": 2, "message": 3, "suggestion": 4}
# What tsserver draws as inlay hints: it draws none until told to.
TS_PREFERENCES = {
    "includeInlayParameterNameHints": "all",
    "includeInlayParameterNameHintsWhenArgumentMatchesName": False,
    "includeInlayFunctionParameterTypeHints": True,
    "includeInlayVariableTypeHints": True,
    "includeInlayVariableTypeHintsWhenTypeMatchesName": False,
    "includeInlayPropertyDeclarationTypeHints": True,
    "includeInlayFunctionLikeReturnTypeHints": True,
    "includeInlayEnumMemberValueHints": True,
    "interactiveInlayHints": False,
}


def ts_places(body):
    """The (path, line, col) of each span of a definition-like answer of tsserver."""
    places = []
    for item in body if isinstance(body, list) else []:
        start = item.get("start") or {}
        if item.get("file"):
            places.append(
                (os.path.realpath(item["file"]), int(start.get("line") or 1), int(start.get("offset") or 1))
            )
    return places


def ts_body(answer):
    return answer.get("body") if answer.get("success") else None


class TsServer(Server):
    """tsserver itself, asked for a file's diagnostics by request (it answers when it is done)."""

    def command(self, name, arguments):
        ident, slot = self.slot()
        body = {"seq": ident, "type": "request", "command": name, "arguments": arguments}
        self.write((json.dumps(body) + "\n").encode("utf-8"))
        return ident, slot

    def ask(self, name, arguments, deadline):
        ident, slot = self.command(name, arguments)
        return self.await_slot(ident, slot, deadline)

    def tell(self, name, arguments):
        # A command with no response: it leaves no slot behind.
        self.next_id += 1
        body = {"seq": self.next_id, "type": "request", "command": name, "arguments": arguments}
        self.write((json.dumps(body) + "\n").encode("utf-8"))

    def on_message(self, message):
        if message.get("type") == "response":
            self.settle(message.get("request_seq"), message)

    def start(self):
        self.spawn()
        setup = {"hostInfo": "lens", "preferences": TS_PREFERENCES}
        answer = self.ask("configure", setup, time.time() + START_SECONDS)
        if not answer.get("success", False):
            raise Unavailable("configure failed: " + str(answer.get("message")))

    def stop(self):
        try:
            self.tell("exit", {})
        except Exception:
            pass
        self.kill()

    def close_file(self, path):
        if self.opened.pop(path, None) is not None:
            self.tell("close", {"file": path})

    def sync(self, path, text):
        doc = self.opened.get(path)
        stamp = digest(text)
        if doc is None:
            self.opened[path] = {"digest": stamp, "used": time.time()}
            self.tell("open", {"file": path, "fileContent": text, "projectRootPath": self.root})
            return
        doc["used"] = time.time()
        if doc["digest"] != stamp:
            doc["digest"] = stamp
            # Takes the file's text from disk again.
            self.command("reload", {"file": path, "tmpfile": path})

    def query(self, files, deadline):
        with self.query_lock:
            self.last_used = time.time()
            results, asked = {}, []
            self.refresh(set(path for _, path in files))
            for rel, path in files:
                text = read_text(path)
                if text is None:
                    self.close_file(path)
                    results[rel] = []
                    continue
                self.sync(path, text)
                asked.append(
                    (
                        rel,
                        self.command("projectInfo", {"file": path, "needFileNameList": False}),
                        self.command("syntacticDiagnosticsSync", {"file": path}),
                        self.command("semanticDiagnosticsSync", {"file": path}),
                        self.command("suggestionDiagnosticsSync", {"file": path}),
                    )
                )
            late, loose = 0, 0
            for rel, project, syntactic, semantic, suggested in asked:
                try:
                    answers = [self.await_slot(i, s, deadline) for i, s in (project, syntactic, semantic)]
                except TimeoutError:
                    late += 1
                    continue
                try:
                    hinted = ts_body(self.await_slot(suggested[0], suggested[1], deadline))
                except TimeoutError:
                    hinted = None
                config = str((answers[0].get("body") or {}).get("configFileName", ""))
                if not config.endswith(".json"):
                    # No tsconfig includes it: tsserver would check it with default options.
                    loose += 1
                    continue
                if not (answers[1].get("success") and answers[2].get("success")):
                    late += 1
                    log(self.label, "diagnostics failed:", answers[1].get("message"), answers[2].get("message"))
                    continue
                items = []
                for answer in answers[1:]:
                    for item in answer.get("body") or []:
                        items.append(self.to_lsp(item))
                # Of its suggestions, only the code it calls unnecessary (what an editor fades).
                seen = set(json.dumps([item["range"], item["code"]], sort_keys=True) for item in items)
                for item in hinted if isinstance(hinted, list) else []:
                    if item.get("reportsUnnecessary"):
                        one = self.to_lsp(item)
                        if json.dumps([one["range"], one["code"]], sort_keys=True) not in seen:
                            items.append(one)
                results[rel] = items
            self.last_used = time.time()
            notes = []
            if late:
                notes.append("%s: no answer in time for %d file(s)" % (self.label, late))
            if loose:
                notes.append("%s: %d file(s) not in any tsconfig project" % (self.label, loose))
            return results, notes

    def symbol(self, path, line, col, deadline):
        """The quick info and the definitions [(path, line, col)] of a 1-based place, and notes."""
        text = read_text(path)
        is_held = self.hold(path, deadline)
        try:
            self.last_used = time.time()
            if is_held and text is not None:
                self.sync(path, text)
            place = {"file": path, "line": line, "offset": col}
            names = ("quickinfo", "definition", "signatureHelp", "typeDefinition", "implementation")
            asked = [self.command(name, place) for name in names]
            info, found = [self.await_slot(ident, slot, deadline) for ident, slot in asked[:2]]
            try:
                more = [ts_body(self.await_slot(ident, slot, deadline)) for ident, slot in asked[2:]]
            except TimeoutError:
                more = [None, None, None]
            self.last_used = time.time()
            parts = []
            # Nothing at the place is an unsuccessful answer ("No content available.").
            body = info.get("body") if info.get("success") else None
            if isinstance(body, dict):
                parts.append(ts_text(body.get("displayString")).strip())
                parts.append(ts_text(body.get("documentation")).strip())
                tags = []
                for tag in body.get("tags") or []:
                    said = ts_text(tag.get("text")).strip()
                    tags.append("@" + str(tag.get("name", "")) + (" " + said if said else ""))
                parts.append("\n".join(tags))
            places = []
            for item in (found.get("body") or []) if found.get("success") else []:
                start = item.get("start") or {}
                if item.get("file"):
                    places.append(
                        (os.path.realpath(item["file"]), int(start.get("line") or 1), int(start.get("offset") or 1))
                    )
            extras = {}
            signature = ts_signature(more[0])
            if signature is not None:
                extras["signature"] = signature
            types = ts_places(more[1])
            # A class or a function is its own type: that is the definition again.
            extras["types"] = [] if any(one in places for one in types) else types
            # A function or a variable is its own implementation: only what is declared
            # elsewhere than the definition counts.
            spans = []
            for item in (found.get("body") or []) if found.get("success") else []:
                if item.get("file"):
                    start = item.get("contextStart") or item.get("start") or {}
                    end = item.get("contextEnd") or item.get("end") or {}
                    spans.append(
                        (
                            os.path.realpath(item["file"]),
                            (int(start.get("line") or 1), int(start.get("offset") or 1)),
                            (int(end.get("line") or 1), int(end.get("offset") or 1)),
                        )
                    )
            extras["implementations"] = [
                one
                for one in ts_places(more[2])
                if one not in types
                and not any(one[0] == file and start <= one[1:] <= end for file, start, end in spans)
            ]
            return "\n\n".join(part for part in parts if part), places, [], extras
        finally:
            if is_held:
                self.query_lock.release()

    def reply(self, answer, what, notes):
        """An answer's body, or None: with a note unless it only says nothing is there."""
        if answer.get("success"):
            return answer.get("body")
        message = str(answer.get("message") or "").strip().split("\n")[0]
        if message.startswith("Unrecognized JSON command"):
            notes.append("%s does not offer %s (this TypeScript is too old)" % (self.tool, what))
        elif message and not message.startswith("No content available"):
            notes.append("%s: %s failed: %s" % (self.label, what, message[:200]))
        return None

    def references(self, path, line, col, deadline):
        """[(path, line, col, line text)] of every use of the symbol at a place, and notes."""
        notes = []

        def work(_):
            place = {"file": path, "line": line, "offset": col}
            body = self.reply(self.ask("references", place, deadline), "references", notes)
            found = []
            for ref in (body or {}).get("refs") or []:
                start = ref.get("start") or {}
                if ref.get("file"):
                    found.append(
                        (
                            os.path.realpath(ref["file"]),
                            int(start.get("line") or 1),
                            int(start.get("offset") or 1),
                            str(ref.get("lineText") or ""),
                        )
                    )
            return found

        return self.attend(path, deadline, work), notes

    def calls(self, path, line, col, direction, deadline):
        """The callers or the callees of the function at a place, and notes."""
        notes = []

        def work(_):
            what = "a call hierarchy"
            place = {"file": path, "line": line, "offset": col}
            items = self.reply(self.ask("prepareCallHierarchy", place, deadline), what, notes)
            if isinstance(items, dict):
                items = [items]
            name, side = "provideCallHierarchyOutgoingCalls", "to"
            if direction == "incoming":
                name, side = "provideCallHierarchyIncomingCalls", "from"
            found = []
            for item in (items or [])[:5]:
                at = (item.get("selectionSpan") or item.get("span") or {}).get("start") or {}
                where = {"file": item.get("file"), "line": at.get("line"), "offset": at.get("offset")}
                for one in self.reply(self.ask(name, where, deadline), what, notes) or []:
                    node = one.get(side) or {}
                    start = (node.get("selectionSpan") or node.get("span") or {}).get("start") or {}
                    if not node.get("file"):
                        continue
                    found.append(
                        {
                            "name": str(node.get("name") or ""),
                            "kind": ts_kind(node.get("kind")),
                            "path": os.path.realpath(node["file"]),
                            "line": int(start.get("line") or 1),
                            "col": int(start.get("offset") or 1),
                            "detail": str(node.get("containerName") or ""),
                        }
                    )
            return found

        return self.attend(path, deadline, work), notes

    def outline(self, path, deadline):
        """The file's navigation tree in its order, parents first, and notes."""
        notes = []

        def work(_):
            tree = self.reply(self.ask("navtree", {"file": path}, deadline), "an outline", notes)
            items = []

            def start_of(node):
                start = node["spans"][0].get("start") or {}
                return (int(start.get("line") or 1), int(start.get("offset") or 1))

            def walk(nodes, depth):
                # An alias is an imported name: not something the file declares.
                rows = [
                    one
                    for one in nodes
                    if isinstance(one, dict) and one.get("spans") and one.get("kind") != "alias"
                ]
                for node in sorted(rows, key=start_of):
                    line, col = start_of(node)
                    end = node["spans"][0].get("end") or {}
                    name = (node.get("nameSpan") or node["spans"][0]).get("start") or {}
                    items.append(
                        outline_item(
                            node.get("text"),
                            ts_kind(node.get("kind")),
                            line,
                            col,
                            int(end.get("line") or line),
                            int(end.get("offset") or col),
                            int(name.get("line") or line),
                            int(name.get("offset") or col),
                            depth,
                        )
                    )
                    walk(node.get("childItems") or [], depth + 1)

            # The tree's root is the file itself.
            walk(tree.get("childItems") or [] if isinstance(tree, dict) else [], 0)
            return items

        return self.attend(path, deadline, work), notes

    def tokens(self, path, deadline):
        """The file's semantic tokens: (type names, modifier names, rows), and notes."""
        notes = []

        def work(text):
            starts = line_starts(text or "")
            span = {"file": path, "start": 0, "length": utf16_len(text or ""), "format": "2020"}
            answer = self.ask("encodedSemanticClassifications-full", span, deadline)
            body = self.reply(answer, "semantic tokens", notes)
            spans = (body or {}).get("spans") or []
            rows = []
            for index in range(0, len(spans) - 2, 3):
                start, length, sort = spans[index], spans[index + 1], spans[index + 2]
                kind = (sort >> 8) - 1
                if not 0 <= kind < len(TS_TOKEN_TYPES):
                    continue
                line = bisect.bisect_right(starts, start) - 1
                rows.append([line + 1, start - starts[line] + 1, length, kind, sort & 255])
            return TS_TOKEN_TYPES, TS_TOKEN_MODIFIERS, rows

        return self.attend(path, deadline, work), notes

    def symbols(self, query, near, limit, deadline):
        """The symbols of the project of the file near whose name matches, and notes."""
        notes = []

        def work(_):
            # More than wanted are asked for: the project's own come before its packages'.
            search = {"searchValue": query, "file": near, "maxResultCount": max(4 * limit, 200)}
            body = self.reply(self.ask("navto", search, deadline), "a symbol search", notes)
            hits, texts = [], LineTexts()
            for item in body if isinstance(body, list) else []:
                start = item.get("start") or {}
                if not item.get("file"):
                    continue
                hits.append(
                    {
                        "name": str(item.get("name") or ""),
                        "kind": ts_kind(item.get("kind")),
                        "container": str(item.get("containerName") or ""),
                        "path": os.path.realpath(item["file"]),
                        "line": int(start.get("line") or 1),
                        "col": int(start.get("offset") or 1),
                    }
                )
            hits.sort(key=lambda hit: is_installed(hit["path"]))
            for hit in hits[:limit]:
                # tsserver gives where the declaration starts ("export class X"): the name
                # is what is searched for.
                line = texts.raw(hit["path"], hit["line"])
                start = utf16_slice(line, 0, hit["col"] - 1)
                at = line.find(hit["name"], len(start)) if hit["name"] else -1
                if at >= 0:
                    hit["col"] = utf16_len(line[:at]) + 1
            return hits[:limit]

        return self.attend(near, deadline, work), notes

    def hints(self, path, first, last, deadline):
        """The inlay hints of lines first..last, and notes."""
        notes = []

        def work(text):
            starts = line_starts(text or "")
            if first > len(starts):
                return []
            start = starts[first - 1]
            end = starts[last] if last < len(starts) else utf16_len(text or "")
            span = {"file": path, "start": start, "length": max(0, end - start)}
            body = self.reply(self.ask("provideInlayHints", span, deadline), "inlay hints", notes)
            hints = []
            for item in body if isinstance(body, list) else []:
                at = item.get("position") or {}
                label = ts_text(item.get("displayParts")) or ts_text(item.get("text"))
                kind = HINT_KINDS.get(item.get("kind"), "other")
                hints.append(
                    {
                        "line": int(at.get("line") or 1),
                        "col": int(at.get("offset") or 1),
                        "label": padded(label, kind, item.get("whitespaceBefore"), item.get("whitespaceAfter")),
                        "kind": kind,
                    }
                )
            return hints

        return self.attend(path, deadline, work), notes

    @staticmethod
    def to_lsp(item):
        start = item.get("start") or {}
        end = item.get("end") or start
        code = item.get("code")
        found = {
            "range": {
                "start": {"line": start.get("line", 1) - 1, "character": start.get("offset", 1) - 1},
                "end": {"line": end.get("line", 1) - 1, "character": end.get("offset", 1) - 1},
            },
            "severity": TS_CATEGORY.get(item.get("category"), 1),
            "code": "TS%s" % code if code is not None else "",
            "source": "ts",
            "message": item.get("text") or item.get("message") or "",
        }
        if item.get("reportsUnnecessary"):
            found["tags"] = [1]
        return found


class Nothing(Exception):
    """There is no result to give; its text is the note that says why."""


def whole(value, name):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise Nothing("no %s given" % name)


def place_of(repo, target, line, col):
    """A place as the answers spell it: the path relative to repo when it is inside it."""
    is_in_repo = target.startswith(repo.rstrip(os.sep) + os.sep)
    return {
        "path": os.path.relpath(target, repo) if is_in_repo else target,
        "line": line,
        "col": col,
        "isInRepo": is_in_repo,
    }


def is_installed(path):
    return "/node_modules/" in path or "/site-packages/" in path or "/typeshed" in path


def unavailable(tool, label, error):
    """The note for a server that cannot be used: one line per language when it is not there."""
    said = str(error)
    missing = "not installed" in said or "not found" in said
    if missing and said.startswith(tool):
        return said
    return "%s: %s" % (tool if missing else label, said)


class Daemon:
    def __init__(self):
        self.lock = threading.Lock()
        self.servers = {}
        self.starting = {}
        self.last_request = time.time()
        self.active = 0
        self.stopping = threading.Event()

    def make(self, language, root, env_dir, label):
        tool = TOOLS[language]
        if language == "python":
            python = venv_python(root) or (venv_python(env_dir) if env_dir else None)
            if which("uvx"):
                argv = [which("uvx"), "--from", "pyright", "pyright-langserver", "--stdio"]
            elif which("pyright-langserver"):
                argv = [which("pyright-langserver"), "--stdio"]
            else:
                raise Unavailable("pyright not installed (no uvx or pyright-langserver on PATH)")
            settings = {"python": {"analysis": {}}, "pyright": {}}
            if python:
                settings["python"]["pythonPath"] = python
            ids = [(".py", "python"), (".pyi", "python")]
            watched = (".py", ".pyi", "pyproject.toml", "pyrightconfig.json")
            server = LspServer(tool, label, root, argv, ids, settings, not NO_PULL, watched)
            return server, python or ""
        if language == "typescript":
            node = which("node")
            if node is None:
                raise Unavailable("node not found (PATH or ~/.nvm/versions/node)")
            tail = os.path.join("node_modules", "typescript", "lib", "tsserver.js")
            tsserver = find_up(root, tail) or (find_up(env_dir, tail) if env_dir else None)
            if tsserver is None:
                raise Unavailable("no node_modules/typescript at or above " + root)
            argv = [node, tsserver, "--disableAutomaticTypingAcquisition", "--suppressDiagnosticEvents"]
            return TsServer(tool, label, root, argv), tsserver
        binary = which("terraform-ls")
        if binary is None:
            raise Unavailable("terraform-ls not installed")
        ids = [(".tfvars", "terraform-vars"), (".tf", "terraform")]
        return LspServer(tool, label, root, [binary, "serve"], ids, {}, False, TERRAFORM_EXT), ""

    def server(self, language, root, env_dir, label):
        """The running server for (language, root), started on first use. Returns (server, state)."""
        key = (language, root)
        with self.lock:
            gate = self.starting.setdefault(key, threading.Lock())
        with gate:
            with self.lock:
                known = self.servers.get(key)
            if known is not None:
                server, variant = known
                fresh, wanted = None, variant
                if not server.dead:
                    try:
                        fresh, wanted = self.make(language, root, env_dir, label)
                    except Unavailable:
                        fresh = None
                if not server.dead and wanted == variant:
                    return server, "reused"
                # It died, or the project's virtualenv or TypeScript changed: start over.
                server.stop()
                with self.lock:
                    self.servers.pop(key, None)
            server, variant = self.make(language, root, env_dir, label)
            began = time.time()
            try:
                server.start()
            except TimeoutError:
                server.kill()
                raise Unavailable("failed to start: no answer in %ds" % START_SECONDS)
            except Unavailable as error:
                server.kill()
                raise Unavailable("failed to start: " + str(error))
            log(label, "started in %.1fs:" % (time.time() - began), " ".join(server.argv))
            with self.lock:
                self.servers[key] = (server, variant)
            return server, "started"

    def query(self, request):
        repo = os.path.realpath(request["repo"])
        env_root = request.get("envRoot")
        deadline = time.time() + float(request.get("timeout") or 120)
        groups, notes, answered, used = {}, [], {}, []
        for rel in request.get("files") or []:
            language = language_of(rel)
            if language is None:
                continue
            if not os.path.exists(os.path.join(repo, rel)):
                # A file that is gone has nothing wrong with it; a server that had it open
                # drops it the next time it is asked anything.
                answered[rel] = {"tool": TOOLS[language], "diagnostics": []}
                continue
            root = root_of(repo, rel, language)
            if root is None:
                note = "%s: no tsconfig.json at or above some files" % TOOLS[language]
                if note not in notes:
                    notes.append(note)
                continue
            groups.setdefault((language, root), []).append(rel)

        def run(language, root, rels):
            tool = TOOLS[language]
            label = "%s (%s)" % (tool, root)
            folder = os.path.normpath(os.path.join(repo, root))
            env_dir = os.path.normpath(os.path.join(env_root, root)) if env_root else None
            began = time.time()
            try:
                server, state = self.server(language, folder, env_dir, label)
                files = [(rel, os.path.normpath(os.path.join(repo, rel))) for rel in rels]
                try:
                    results, found = server.query(files, deadline)
                except TimeoutError:
                    results, found = {}, ["%s: no answer in time" % label]
            except Unavailable as error:
                text = str(error)
                # One line per language when the tool is simply not there.
                missing = "not installed" in text or "not found" in text
                note = text if missing and text.startswith(tool) else "%s: %s" % (tool if missing else label, text)
                with self.lock:
                    if note not in notes:
                        notes.append(note)
                return
            except Exception as error:
                log(label, "query failed:", repr(error))
                with self.lock:
                    notes.append("%s: %r" % (label, error))
                return
            with self.lock:
                for rel, items in results.items():
                    answered[rel] = {"tool": tool, "diagnostics": items[:MAX_PER_FILE]}
                notes.extend(found)
                used.append(
                    {
                        "tool": tool,
                        "root": root,
                        "state": state,
                        "files": len(rels),
                        "ms": int((time.time() - began) * 1000),
                    }
                )

        threads = [
            threading.Thread(target=run, args=(language, root, rels))
            for (language, root), rels in groups.items()
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        return {"ok": True, "version": VERSION, "files": answered, "notes": notes, "servers": used}

    def symbol(self, request):
        """What the file's server knows of the symbol at a place. Says why in a note when nothing."""
        began = time.time()
        repo = os.path.realpath(request["repo"])
        rel = str(request.get("file") or "")
        env_root = request.get("envRoot")
        deadline = began + float(request.get("timeout") or SYMBOL_SECONDS)

        def nothing(note):
            return {"ok": True, "version": VERSION, "text": "", "notes": [note]}

        try:
            line, col = int(request.get("line")), int(request.get("col"))
        except (TypeError, ValueError):
            return nothing("no line and column given")
        if line < 1 or col < 1:
            return nothing("no such place: line %d, column %d" % (line, col))
        language = language_of(rel)
        if language is None:
            return nothing("no language server for %s" % (os.path.splitext(rel)[1] or rel))
        tool = TOOLS[language]
        path = os.path.normpath(os.path.join(repo, rel))
        if not os.path.isfile(path):
            return nothing("%s: no such file" % rel)
        root = root_of(repo, rel, language)
        if root is None:
            return nothing("%s: no tsconfig.json at or above %s" % (tool, rel))
        label = "%s (%s)" % (tool, root)
        folder = os.path.normpath(os.path.join(repo, root))
        env_dir = os.path.normpath(os.path.join(env_root, root)) if env_root else None
        try:
            server, state = self.server(language, folder, env_dir, label)
            text, places, notes, extras = server.symbol(path, line, col, deadline)
        except TimeoutError:
            return nothing("%s: no answer in time" % label)
        except Unavailable as error:
            said = str(error)
            missing = "not installed" in said or "not found" in said
            if missing and said.startswith(tool):
                return nothing(said)
            return nothing("%s: %s" % (tool if missing else label, said))
        answer = {
            "ok": True,
            "version": VERSION,
            "text": text[:MAX_TEXT],
            "notes": notes,
            "tool": tool,
            "state": state,
            "ms": int((time.time() - began) * 1000),
        }
        if places:
            target, at_line, at_col = places[0]
            is_in_repo = target.startswith(repo.rstrip(os.sep) + os.sep)
            answer["definition"] = {
                "path": os.path.relpath(target, repo) if is_in_repo else target,
                "line": at_line,
                "col": at_col,
                "isInRepo": is_in_repo,
            }
        if extras.get("signature"):
            answer["signature"] = extras["signature"]
        if extras.get("types"):
            answer["typeDefinition"] = place_of(repo, *extras["types"][0])
        made = []
        for one in extras.get("implementations") or []:
            if one not in made:
                made.append(one)
        if made:
            answer["implementations"] = [place_of(repo, *one) for one in made[:MAX_IMPLEMENTATIONS]]
        return answer

    def ask(self, request):
        """One of the lookups in ASKS. What cannot be answered is a note and no result."""
        began = time.time()
        answer = {"ok": True, "version": VERSION, "notes": []}
        try:
            self.answer(request, answer, began)
        except Nothing as nothing:
            answer["notes"].append(str(nothing))
        answer["ms"] = int((time.time() - began) * 1000)
        return answer

    def answer(self, request, answer, began):
        what = str(request.get("what") or "")
        if what not in ASKS:
            raise Nothing("unknown lookup: %s" % what)
        repo = os.path.realpath(request["repo"])
        rel = str(request.get("near" if what == "symbols" else "file") or "")
        env_root = request.get("envRoot")
        deadline = began + float(request.get("timeout") or SYMBOL_SECONDS)
        line = col = first = last = 0
        if what in ("references", "calls"):
            line, col = whole(request.get("line"), "line"), whole(request.get("col"), "column")
            if line < 1 or col < 1:
                raise Nothing("no such place: line %d, column %d" % (line, col))
        if what == "hints":
            first = max(1, whole(request.get("fromLine"), "first line"))
            last = whole(request.get("toLine"), "last line")
        query = str(request.get("query") or "")
        if what == "symbols" and not query.strip():
            raise Nothing("no name to search for")
        language = language_of(rel)
        if language is None:
            raise Nothing("no language server for %s" % (os.path.splitext(rel)[1] or rel or "no file"))
        tool = TOOLS[language]
        path = os.path.normpath(os.path.join(repo, rel))
        if not os.path.isfile(path):
            raise Nothing("%s: no such file" % rel)
        root = root_of(repo, rel, language)
        if root is None:
            raise Nothing("%s: no tsconfig.json at or above %s" % (tool, rel))
        label = "%s (%s)" % (tool, root)
        folder = os.path.normpath(os.path.join(repo, root))
        env_dir = os.path.normpath(os.path.join(env_root, root)) if env_root else None
        notes = answer["notes"]

        def cut(items, most, name):
            if len(items) > most:
                notes.append("showing the first %d of %d %s" % (most, len(items), name))
            return items[:most]

        try:
            server, state = self.server(language, folder, env_dir, label)
            answer["tool"], answer["state"] = tool, state
            if what == "references":
                found, said = server.references(path, line, col, deadline)
                texts, seen = LineTexts(), {}
                for target, at_line, at_col, text in found:
                    seen.setdefault((target, at_line, at_col), text)
                keys = sorted(seen, key=lambda key: (is_installed(key[0]),) + key)
                answer["total"] = len(keys)
                places = []
                for key in cut(keys, MAX_PLACES, "references"):
                    place = place_of(repo, *key)
                    text = seen[key]
                    place["text"] = texts.text(key[0], key[1]) if text is None else text.strip()[:MAX_LINE_TEXT]
                    places.append(place)
                answer["places"] = places
            elif what == "calls":
                direction = "incoming" if request.get("direction") == "incoming" else "outgoing"
                found, said = server.calls(path, line, col, direction, deadline)
                answer["calls"] = [
                    {
                        "name": one["name"],
                        "kind": one["kind"],
                        "place": place_of(repo, one["path"], one["line"], one["col"]),
                        "detail": one["detail"][:MAX_LINE_TEXT],
                    }
                    for one in cut(found, MAX_CALLS, "calls")
                ]
            elif what == "outline":
                found, said = server.outline(path, deadline)
                answer["items"] = cut(found, MAX_OUTLINE, "outline entries")
            elif what == "tokens":
                (types, modifiers, rows), said = server.tokens(path, deadline)
                answer["types"], answer["modifiers"] = types, modifiers
                answer["rows"] = cut(rows, MAX_TOKENS, "semantic tokens")
            elif what == "symbols":
                try:
                    limit = int(request.get("limit") or 50)
                except (TypeError, ValueError):
                    limit = 50
                found, said = server.symbols(query, path, max(1, min(limit, MAX_HITS)), deadline)
                answer["hits"] = [
                    {
                        "name": one["name"],
                        "kind": one["kind"],
                        "container": one["container"],
                        "place": place_of(repo, one["path"], one["line"], one["col"]),
                    }
                    for one in found
                ]
            else:
                found, said = ([], []) if last < first else server.hints(path, first, last, deadline)
                found.sort(key=lambda one: (one["line"], one["col"]))
                answer["hints"] = cut(found, MAX_HINTS, "inlay hints")
            notes.extend(said)
        except TimeoutError:
            raise Nothing("%s: no answer in time" % label)
        except Unavailable as error:
            raise Nothing(unavailable(tool, label, error))

    def status(self):
        with self.lock:
            servers = [
                {
                    "tool": server.tool,
                    "root": server.root,
                    "pid": server.proc.pid if server.proc else None,
                    "dead": server.dead,
                    "open": len(server.opened),
                    "idle": int(time.time() - server.last_used),
                    "argv": server.argv,
                }
                for server, _ in self.servers.values()
            ]
        return {"ok": True, "version": VERSION, "pid": os.getpid(), "socket": SOCK, "servers": servers}

    def stop_servers(self, is_wanted):
        with self.lock:
            gone = [(key, pair[0]) for key, pair in self.servers.items() if is_wanted(pair[0])]
            for key, _ in gone:
                del self.servers[key]
        for _, server in gone:
            log(server.label, "stopping", server.root)
            server.stop()
        return len(gone)

    def handle(self, conn):
        with self.lock:
            self.active += 1
        try:
            conn.settimeout(900)
            stream = conn.makefile("rwb")
            line = stream.readline()
            request = json.loads(line.decode("utf-8"))
            op = request.get("op")
            if request.get("version") not in (None, VERSION):
                # A newer script was written over this one: make way for its daemon.
                answer = {"ok": False, "stale": True}
                self.stopping.set()
            elif op in ("query", "symbol", "ask") and self.stopping.is_set():
                # Stopping, and still listening for a moment: servers started now would be
                # stopped under the request. The client asks again, and gets the next daemon.
                answer = {"ok": False, "stale": True}
            elif op == "query":
                answer = self.query(request)
            elif op == "symbol":
                answer = self.symbol(request)
            elif op == "ask":
                answer = self.ask(request)
            elif op == "status":
                answer = self.status()
            elif op == "stop":
                root = request.get("root")
                if root:
                    root = os.path.realpath(root)
                    count = self.stop_servers(
                        lambda server: server.root == root or server.root.startswith(root + os.sep)
                    )
                    answer = {"ok": True, "stopped": count}
                else:
                    answer = {"ok": True, "stopped": "daemon"}
                    self.stopping.set()
            else:
                answer = {"ok": False, "error": "unknown op"}
            stream.write((json.dumps(answer) + "\n").encode("utf-8"))
            stream.flush()
        except Exception as error:
            log("request failed:", repr(error))
            try:
                conn.sendall((json.dumps({"ok": False, "error": repr(error)}) + "\n").encode("utf-8"))
            except OSError:
                pass
        finally:
            with self.lock:
                self.active -= 1
                self.last_request = time.time()
            try:
                conn.close()
            except OSError:
                pass

    def serve(self):
        os.makedirs(HERE, exist_ok=True)
        lock = open(LOCK, "w")
        for _ in range(100):
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                # Another daemon holds it: when that one is answering, this one is not needed.
                probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                try:
                    probe.connect(SOCK)
                    return
                except OSError:
                    time.sleep(0.1)
                finally:
                    probe.close()
        else:
            return
        try:
            os.unlink(SOCK)
        except OSError:
            pass
        try:
            if os.path.getsize(LOG) > 1000000:
                os.unlink(LOG)
        except OSError:
            pass
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(SOCK)
        os.chmod(SOCK, 0o600)
        listener.listen(16)
        listener.settimeout(1.0)
        signal.signal(signal.SIGTERM, lambda *_: self.stopping.set())
        signal.signal(signal.SIGINT, lambda *_: self.stopping.set())
        log("daemon", VERSION, "pid", os.getpid(), "listening")
        while not self.stopping.is_set():
            try:
                conn, _ = listener.accept()
            except socket.timeout:
                now = time.time()
                with self.lock:
                    idle = self.active == 0 and now - self.last_request > IDLE_SECONDS
                if idle:
                    log("daemon idle, exiting")
                    break
                self.stop_servers(
                    lambda server: now - server.last_used > IDLE_SECONDS
                    and not server.query_lock.locked()
                )
                continue
            except OSError:
                break
            threading.Thread(target=self.handle, args=(conn,), daemon=True).start()
        listener.close()
        try:
            os.unlink(SOCK)
        except OSError:
            pass
        self.stop_servers(lambda server: True)
        log("daemon stopped")


def spawn_daemon():
    with open(LOG, "ab") as out:
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "daemon"],
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=out,
            cwd=HERE,
            start_new_session=True,
        )


def exchange(payload, wait):
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        conn.connect(SOCK)
        conn.settimeout(wait)
        conn.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        chunks = []
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
        return json.loads(b"".join(chunks).decode("utf-8"))
    finally:
        conn.close()


def call(payload, wait, may_start=True):
    """Asks the daemon, starting it (or replacing an older script's daemon) when needed."""
    payload = dict(payload, version=VERSION)
    give_up = time.time() + 20
    spawned_at = 0.0
    while True:
        try:
            answer = exchange(payload, wait)
        except (FileNotFoundError, ConnectionRefusedError, ConnectionResetError, ValueError):
            answer = None
        if answer is not None and not answer.get("stale"):
            return answer
        if not may_start:
            return {"ok": True, "stopped": "nothing", "servers": []}
        if time.time() > give_up:
            return {"ok": False, "error": "the bridge daemon did not start (see %s)" % LOG}
        if answer is None and time.time() - spawned_at > 12:
            spawn_daemon()
            spawned_at = time.time()
        time.sleep(0.05)


def stdin_json():
    if sys.stdin is None or sys.stdin.isatty():
        return {}
    text = sys.stdin.read().strip()
    return json.loads(text) if text else {}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "daemon":
        Daemon().serve()
        return 0
    try:
        if mode == "query":
            request = stdin_json()
            request["op"] = "query"
            answer = call(request, float(request.get("timeout") or 120) + 30)
        elif mode == "symbol":
            request = stdin_json()
            request["op"] = "symbol"
            answer = call(request, float(request.get("timeout") or SYMBOL_SECONDS) + 30)
        elif mode == "ask":
            request = stdin_json()
            request["op"] = "ask"
            answer = call(request, float(request.get("timeout") or SYMBOL_SECONDS) + 30)
        elif mode == "status":
            answer = call({"op": "status"}, 10, may_start=False)
        elif mode == "stop":
            answer = call(dict(stdin_json(), op="stop"), 30, may_start=False)
        else:
            answer = {"ok": False, "error": "usage: bridge.py daemon|query|symbol|ask|status|stop"}
    except Exception as error:
        answer = {"ok": False, "error": repr(error)}
    sys.stdout.write(json.dumps(answer))
    sys.stdout.flush()
    return 0 if answer.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
`
