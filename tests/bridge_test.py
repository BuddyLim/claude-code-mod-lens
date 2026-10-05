"""Tests of the language-server bridge's table of servers (hooks/lsp-bridge.ts).

    uv run --no-project python tests/bridge_test.py

`claude plugin test` cannot start a process, so what needs one is here: the script is taken out
of its TypeScript module, its config parsing is tested as plain functions, and a server declared
in a config file (tests/fake_lsp.py) is driven through the real client and daemon. The daemon is
one of the test's own, in a temp folder, and is stopped at the end: the one a session is using
(/tmp/lens-lsp-<uid>) is not touched, and neither is ~/.claude/lens/servers.json.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MODULE = os.path.join(HERE, "..", "hooks", "lsp-bridge.ts")
FAKE = os.path.join(HERE, "fake_lsp.py")


def script():
    with open(MODULE, encoding="utf-8") as source:
        return source.read().split("String.raw`", 1)[1].rsplit("`", 1)[0]


class Folder(unittest.TestCase):
    """A temp folder holding the script, a config file to write and a repo to ask about."""

    def setUp(self):
        # Short, and real: a socket's path has a length limit, and the bridge resolves links.
        self.folder = os.path.realpath(tempfile.mkdtemp(prefix="lens-test-", dir="/tmp"))
        self.addCleanup(shutil.rmtree, self.folder, True)
        self.bridge = os.path.join(self.folder, "bridge.py")
        self.config = os.path.join(self.folder, "servers.json")
        self.repo = os.path.join(self.folder, "repo")
        with open(self.bridge, "w", encoding="utf-8") as out:
            out.write(script())

    def configure(self, servers):
        with open(self.config, "w", encoding="utf-8") as out:
            out.write(servers if isinstance(servers, str) else json.dumps({"servers": servers}))

    def write(self, rel, text=""):
        path = os.path.join(self.repo, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as out:
            out.write(text)


class Table(Folder):
    def setUp(self):
        Folder.setUp(self)
        spec = importlib.util.spec_from_file_location("lens_bridge", self.bridge)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.module.CONFIG = self.config

    def read(self, servers=None):
        if servers is not None:
            self.configure(servers)
        found, notes = self.module.read_servers(self.config)
        return {server["name"]: server for server in found}, notes

    def test_no_config_file_is_the_built_in_servers(self):
        table, notes = self.read()
        self.assertEqual(notes, [])
        self.assertEqual(
            list(table),
            ["pyright", "tsserver", "terraform-ls", "clangd", "csharp-ls", "gopls", "rust-analyzer", "pulumi-lsp"],
        )
        self.assertEqual(table["pyright"]["extensions"], (".py", ".pyi"))
        self.assertEqual(table["tsserver"]["extensions"], (".ts", ".tsx", ".mts", ".cts"))
        terraform = table["terraform-ls"]
        self.assertEqual(terraform["commands"], [["terraform-ls", "serve"]])
        self.assertEqual(terraform["root_markers"], ())
        self.assertEqual(terraform["language_ids"][:2], [(".tfvars", "terraform-vars"), (".tf", "terraform")])
        self.assertEqual(table["csharp-ls"]["commands"], [["csharp-ls"], ["OmniSharp", "-lsp"]])
        self.assertEqual(dict(table["clangd"]["language_ids"])[".hpp"], "cpp")

    def test_an_entry_adds_a_server_ahead_of_the_built_in_ones(self):
        table, notes = self.read(
            {"zls": {"extensions": [".ZIG"], "command": ["zls"], "rootMarkers": ["build.zig"], "language": "Zig"}}
        )
        self.assertEqual(notes, [])
        self.assertEqual(list(table)[0], "zls")
        zig = table["zls"]
        self.assertEqual((zig["extensions"], zig["commands"], zig["root_markers"]), ((".zig",), [["zls"]], ("build.zig",)))
        # A language not given is the extension's own letters; a file with another name gets the first.
        self.assertEqual(zig["language_ids"], [(".zig", "zig"), ("", "zig")])
        self.assertEqual((zig["kind"], zig["language"], zig["is_user"]), ("lsp", "Zig", True))

    def test_an_entry_named_as_a_built_in_changes_only_what_it_gives(self):
        table, notes = self.read({"gopls": {"command": ["/opt/gopls", "-remote=auto"]}})
        self.assertEqual(notes, [])
        self.assertEqual(table["gopls"]["commands"], [["/opt/gopls", "-remote=auto"]])
        self.assertEqual(table["gopls"]["extensions"], (".go",))
        self.assertEqual(table["gopls"]["root_markers"], ("go.work", "go.mod"))

    def test_disabled_takes_a_server_out_even_one_started_in_its_own_way(self):
        table, notes = self.read({"clangd": {"disabled": True}, "pyright": {"disabled": True}})
        self.assertEqual(notes, [])
        self.assertNotIn("clangd", table)
        self.assertNotIn("pyright", table)
        self.assertIn("gopls", table)

    def test_a_wrong_entry_is_left_out_and_named_and_the_rest_stand(self):
        table, notes = self.read(
            {
                "good": {"extensions": [".good"], "command": ["good-ls", "--stdio"]},
                "no-command": {"extensions": [".x"]},
                "nothing-read": {"command": ["x"]},
                "typo": {"extensions": [".x"], "command": ["x"], "rootMarker": ["x"]},
                "bad-extension": {"extensions": ["x"], "command": ["x"]},
                "bad-command": {"extensions": [".x"], "command": "x --stdio"},
                "empty-command": {"extensions": [".x"], "command": []},
                "not-an-object": ["x"],
                "bad name": {"extensions": [".x"], "command": ["x"]},
                "gopls": {"rootMarkers": "go.mod"},
                "tsserver": {"command": ["my-tsserver"]},
                "escapes": {"extensions": [".x"], "command": ["x"], "rootMarkers": ["../x"]},
            }
        )
        self.assertEqual(
            notes,
            [
                'servers.json: "no-command" is ignored: it needs a "command"',
                'servers.json: "nothing-read" is ignored: it needs "extensions" or "filenames" to read',
                'servers.json: "typo" is ignored: unknown field "rootMarker"',
                'servers.json: "bad-extension" is ignored: an extension starts with a dot: "x"',
                'servers.json: "bad-command" is ignored: "command" must be a list of strings',
                'servers.json: "empty-command" is ignored: "command" must name a program',
                'servers.json: "not-an-object" is ignored: it must be an object',
                'servers.json: "bad name" is ignored: a name is letters, digits and . _ + - alone',
                'servers.json: "gopls" is ignored: "rootMarkers" must be a list of strings',
                'servers.json: "tsserver" is ignored: only "disabled" can be set: tsserver is found and started in a way of its own',
                'servers.json: "escapes" is ignored: "rootMarkers" are names inside the project',
            ],
        )
        self.assertEqual(list(table)[0], "good")
        self.assertEqual(len(table), 9)
        # The built-in a wrong entry was for is as it was.
        self.assertEqual(table["gopls"]["root_markers"], ("go.work", "go.mod"))
        self.assertFalse(table["gopls"]["is_user"])

    def test_a_file_that_is_not_the_config_is_ignored_whole(self):
        for text, said in (
            ("{not json", "servers.json is ignored: Expecting property name"),
            ("[]", 'servers.json is ignored: it must be {"servers": {name: entry}}'),
            ('{"servers": []}', 'servers.json is ignored: it must be {"servers": {name: entry}}'),
        ):
            table, notes = self.read(text)
            self.assertEqual(len(notes), 1)
            self.assertTrue(notes[0].startswith(said), notes[0])
            self.assertEqual(len(table), 8)

    def test_a_file_is_matched_by_its_name_then_its_extension_installed_first(self):
        self.configure(
            {
                "yaml-ls": {"extensions": [".yaml"], "command": ["yaml-ls"]},
                "mine": {"extensions": [".go"], "command": ["not-installed-go-server"]},
            }
        )
        self.module.which = lambda name: None if name.startswith("not-installed") else "/bin/" + name
        name_of = lambda rel: (self.module.language_of(rel) or {}).get("name")
        self.assertEqual(name_of("infra/Pulumi.dev.yaml"), "pulumi-lsp")
        self.assertEqual(name_of("infra/Pulumi.yaml"), "pulumi-lsp")
        self.assertEqual(name_of("infra/other.yaml"), "yaml-ls")
        self.assertEqual(name_of("infra/NotPulumi.yaml"), "yaml-ls")
        # A user's entry is first, unless it is not installed and another one is.
        self.assertEqual(name_of("cmd/main.go"), "gopls")
        self.assertEqual(name_of("src/A.PY"), "pyright")
        self.assertEqual(name_of("README.md"), None)
        # The config file is read again once it has changed.
        self.configure({"gopls": {"disabled": True}})
        self.assertEqual(name_of("cmd/main.go"), None)

    def test_a_project_is_the_first_marker_found_nearest_the_file(self):
        table, _ = self.read()
        for rel in ("go.work", "svc/go.mod", "svc/api/x.go", "app/App.sln", "app/web/Web.csproj", "app/web/a.cs"):
            self.write(rel)
        root_of = lambda rel, name: self.module.root_of(self.repo, rel, table[name])
        # go.work is listed before go.mod, so the workspace wins over the nearer module.
        self.assertEqual(root_of("svc/api/x.go", "gopls"), ".")
        self.assertEqual(root_of("app/web/a.cs", "csharp-ls"), "app")
        # No marker anywhere: the folder asked about. No markers to look for: the file's own.
        self.assertEqual(root_of("svc/api/x.rs", "rust-analyzer"), ".")
        self.assertEqual(root_of("infra/prod/main.tf", "terraform-ls"), "infra/prod")

    def test_served_lists_what_each_server_reads_and_whether_it_is_there(self):
        self.configure({"mine": {"filenames": ["Justfile"], "command": ["not-installed"], "install": "get it"}, "x": 1})
        self.module.which = lambda name: None if name == "not-installed" else "/bin/" + name
        answer = self.module.served()
        self.assertEqual(answer["notes"], ['servers.json: "x" is ignored: it must be an object'])
        self.assertEqual(
            answer["servers"][0],
            {"name": "mine", "language": "mine", "extensions": [], "filenames": ["Justfile"], "isInstalled": False, "install": "get it"},
        )
        self.assertTrue(all(server["isInstalled"] for server in answer["servers"][1:]))


class EndToEnd(Folder):
    def ask(self, mode, request=None):
        ran = subprocess.run(
            [sys.executable, self.bridge, mode],
            input=json.dumps(request or {}),
            capture_output=True,
            text=True,
            timeout=90,
            env=dict(os.environ, LENS_SERVERS_CONFIG=self.config),
        )
        self.assertTrue(ran.stdout, ran.stderr)
        return json.loads(ran.stdout)

    def test_a_server_from_the_config_file_answers_through_the_daemon(self):
        self.addCleanup(self.ask, "stop")
        self.configure(
            {
                "fake": {
                    "extensions": [".fake"],
                    "filenames": ["Fakefile"],
                    "languageId": {".fake": "fakelang"},
                    "command": [["not-installed-fake-server"], [sys.executable, FAKE]],
                    "rootMarkers": ["fake.toml"],
                },
                "broken": {"extensions": [".broken"]},
            }
        )
        self.write("proj/fake.toml")
        self.write("proj/src/a.fake", "one\ntwo\n")
        self.write("proj/Fakefile", "one\n")
        self.write("proj/src/b.md", "one\n")

        served = self.ask("served")
        self.assertEqual(served["notes"], ['servers.json: "broken" is ignored: it needs a "command"'])
        self.assertEqual(
            served["servers"][0],
            {"name": "fake", "language": "fake", "extensions": [".fake"], "filenames": ["Fakefile"], "isInstalled": True, "install": ""},
        )

        files = ["proj/src/a.fake", "proj/Fakefile", "proj/src/b.md", "proj/src/gone.fake"]
        answer = self.ask("query", {"repo": self.repo, "files": files, "timeout": 30})
        self.assertEqual(answer.get("notes"), [], answer)
        self.assertEqual(sorted(answer["files"]), ["proj/Fakefile", "proj/src/a.fake", "proj/src/gone.fake"])
        found = answer["files"]["proj/src/a.fake"]
        self.assertEqual(found["tool"], "fake")
        self.assertEqual(
            found["diagnostics"],
            [
                {
                    "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 4}},
                    "severity": 2,
                    "code": "fake-rule",
                    "message": "opened as fakelang in proj",
                }
            ],
        )
        # A file matched by its name is opened as the entry's first language.
        self.assertEqual(answer["files"]["proj/Fakefile"]["diagnostics"][0]["message"], "opened as fakelang in proj")
        self.assertEqual(answer["files"]["proj/src/gone.fake"], {"tool": "fake", "diagnostics": []})
        # One server for the project the marker is in, whatever folder each file is in.
        self.assertEqual([(one["tool"], one["root"], one["files"]) for one in answer["servers"]], [("fake", "proj", 2)])

        # Asked again, the same server answers.
        again = self.ask("query", {"repo": self.repo, "files": files[:1], "timeout": 30})
        self.assertEqual(again["servers"][0]["state"], "reused")
        self.assertEqual(len(again["files"]["proj/src/a.fake"]["diagnostics"]), 1)

        place = {"repo": self.repo, "file": "proj/src/a.fake", "line": 1, "col": 1, "timeout": 30}
        symbol = self.ask("symbol", place)
        self.assertEqual((symbol["text"], symbol["tool"], symbol["notes"]), ("a fake symbol", "fake", []))
        outline = self.ask("ask", dict(place, what="outline"))
        self.assertEqual([one["name"] for one in outline["items"]], ["first"])
        # What the server does not offer is a note, not a failure.
        references = self.ask("ask", dict(place, what="references"))
        self.assertEqual(references["notes"], ["fake does not offer references"])

        status = self.ask("status")
        self.assertEqual([(one["tool"], one["root"]) for one in status["servers"]], [("fake", os.path.join(self.repo, "proj"))])

        # Disabled in the config file, the running daemon no longer has a server for the file.
        self.configure({"fake": {"extensions": [".fake"], "command": [sys.executable, FAKE], "disabled": True}})
        gone = self.ask("query", {"repo": self.repo, "files": files[:1], "timeout": 30})
        self.assertEqual(gone["files"], {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
