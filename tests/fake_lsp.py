"""A language server small enough to read in one go, for bridge_test.py.

It speaks the Language Server Protocol on stdin and stdout, and says one thing about every
file it is shown: a warning on the first line, whose message holds the language the file was
opened as and the name of the project folder the server was started for. It also answers a
hover and an outline, so the lookups have something to find.
"""
import json
import sys

root = ""


def read():
    length = 0
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, _, value = line.decode("ascii").partition(":")
        if name.lower() == "content-length":
            length = int(value)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send(message):
    body = json.dumps(dict(message, jsonrpc="2.0")).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
    sys.stdout.buffer.flush()


def publish(document, language):
    whole = {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 4}}
    send(
        {
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": document["uri"],
                "version": document.get("version"),
                "diagnostics": [
                    {
                        "range": whole,
                        "severity": 2,
                        "code": "fake-rule",
                        "message": "opened as %s in %s" % (language, root),
                    }
                ],
            },
        }
    )


def main():
    global root
    languages = {}
    while True:
        message = read()
        if message is None:
            return
        method, params = message.get("method"), message.get("params") or {}
        if method == "initialize":
            root = params["rootUri"].rstrip("/").rsplit("/", 1)[-1]
            capabilities = {"textDocumentSync": 1, "hoverProvider": True, "documentSymbolProvider": True}
            send({"id": message["id"], "result": {"capabilities": capabilities}})
        elif method == "textDocument/didOpen":
            document = params["textDocument"]
            languages[document["uri"]] = document["languageId"]
            publish(document, document["languageId"])
        elif method == "textDocument/didChange":
            document = params["textDocument"]
            publish(document, languages.get(document["uri"], "?"))
        elif method == "textDocument/hover":
            send({"id": message["id"], "result": {"contents": "a fake symbol"}})
        elif method == "textDocument/documentSymbol":
            whole = {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 4}}
            symbol = {"name": "first", "kind": 12, "range": whole, "selectionRange": whole}
            send({"id": message["id"], "result": [symbol]})
        elif method == "exit":
            return
        elif "id" in message and method is not None:
            send({"id": message["id"], "result": None})


main()
