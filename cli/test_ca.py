"""Tests for ca. Run: python3 test_ca.py  (uses a throwaway config; no network, no login)."""
import json, os, shlex, subprocess, sys, tempfile, unittest, importlib.util, importlib.machinery, shutil
HERE = os.path.dirname(os.path.abspath(__file__))
WIN = os.name == "nt"
def read(p):
    with open(p, encoding="utf-8") as f: return f.read()
def write(p, text):
    with open(p, "w", encoding="utf-8") as f: f.write(text)
NAMES = json.loads(read(os.path.join(HERE, "..", "test", "fixtures", "account-names.json")))
TMP = tempfile.mkdtemp(prefix="ca-test-")
os.environ["CA_CONFIG"] = os.path.join(TMP, "cfg", "config.json")
loader = importlib.machinery.SourceFileLoader("ca", os.path.join(HERE, "ca"))
spec = importlib.util.spec_from_loader("ca", loader); ca = importlib.util.module_from_spec(spec); loader.exec_module(ca)
CA = [sys.executable, os.path.join(HERE, "ca")]

def sh(*args, **kw):
    return subprocess.run(CA + list(args), capture_output=True, text=True, env=os.environ, **kw)

class T(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.r1 = os.path.join(TMP, "repo-work"); cls.r2 = os.path.join(TMP, "repo-personal")
        for r in (cls.r1, cls.r2):
            os.makedirs(r); subprocess.run(["git", "init", "-q", r])
        assert sh("add-account", "work").returncode == 0
        assert sh("add-account", "personal").returncode == 0
        assert sh("bind", cls.r1, "work").returncode == 0
        assert sh("bind", cls.r2, "personal", "--mode", "docker").returncode == 0

    def test_config_shape(self):
        cfg = json.loads(read(os.environ["CA_CONFIG"]))
        self.assertEqual(set(cfg["accounts"]), {"work", "personal"})
        for a in cfg["accounts"].values():
            self.assertTrue({"config_dir", "desktop_user_data_dir", "docker_config_dir"} <= set(a))
            if not WIN: self.assertEqual(os.stat(a["config_dir"]).st_mode & 0o777, 0o700)
        self.assertEqual(cfg["repos"][os.path.realpath(self.r1)], {"account": "work", "mode": "terminal"})
        self.assertEqual(cfg["repos"][os.path.realpath(self.r2)]["mode"], "docker")

    def test_bind_errors(self):
        self.assertNotEqual(sh("bind", self.r1, "nope").returncode, 0)
        self.assertNotEqual(sh("bind", "/does/not/exist", "work").returncode, 0)
        self.assertNotEqual(sh("add-account", "bad/name").returncode, 0)

    def test_find_repo_subdir(self):
        sub = os.path.join(self.r1, "src", "deep"); os.makedirs(sub, exist_ok=True)
        r, b = ca.find_repo(ca.load(), sub)
        self.assertEqual(r, os.path.realpath(self.r1)); self.assertEqual(b["account"], "work")
        self.assertEqual(ca.find_repo(ca.load(), TMP), (None, None))

    def test_env_construction(self):
        acc = ca.load()["accounts"]["work"]
        # any spelling of the key goes, since Windows ignores case in names
        env = ca.claude_env(acc, {"ANTHROPIC_API_KEY": "x", "anthropic_api_key": "y", "Claude_Config_Dir": "/old", "PATH": "/bin"})
        self.assertEqual(env, {"CLAUDE_CONFIG_DIR": acc["config_dir"], "PATH": "/bin"})
        out = sh("env", "--shell", os.path.join(self.r1, "src")).stdout
        self.assertIn(f"export CLAUDE_CONFIG_DIR={shlex.quote(acc['config_dir'])}", out)   # shell text: C:\... comes quoted
        self.assertIn("unset", sh("env", "--shell", TMP).stdout)

    def test_run_print_and_worktree(self):
        out = sh("run", self.r1, "--print", "--worktree", "feat-x").stdout
        self.assertIn("CLAUDE_CONFIG_DIR=", out); self.assertIn("claude --worktree feat-x", out)
        self.assertIn("claude --worktree", sh("run", self.r1, "--print", "-w").stdout)
        r = sh("run", self.r1, "--print", "-w", "x&calc")   # the app's rule for worktree names
        self.assertNotEqual(r.returncode, 0); self.assertIn("invalid worktree name", r.stderr)

    def test_program_never_from_the_current_folder(self):
        # A repository could hold its own claude, and a PATH entry that isn't absolute ("." or "") means the current folder.
        name = "claude.cmd" if WIN else "claude"
        found, planted = os.path.join(TMP, "bin"), os.path.join(TMP, "planted")
        for d in (found, planted):
            os.makedirs(d, exist_ok=True); write(os.path.join(d, name), "@exit /b 0\r\n" if WIN else "#!/bin/sh\n")
            os.chmod(os.path.join(d, name), 0o755)
        cwd, path = os.getcwd(), os.environ["PATH"]
        try:
            os.chdir(planted)
            os.environ["PATH"] = os.pathsep.join([".", "", found])
            self.assertEqual(os.path.normcase(ca.program("claude")), os.path.normcase(os.path.join(found, name)))
            os.environ["PATH"] = os.pathsep.join([".", ""])
            self.assertIsNone(ca.program("claude"))
        finally:
            os.chdir(cwd); os.environ["PATH"] = path

    def test_windows_child_env(self):
        # npm's claude.cmd runs node by name, so cmd must not look in the current folder, which can be the repository
        system, ca.SYSTEM = ca.SYSTEM, "Windows"
        try:
            env = ca.child_env({"Path": "C:\\bin;.;\\tools", "X": "1"})
            self.assertEqual(env, {"Path": "C:\\bin", "X": "1", "NoDefaultCurrentDirectoryInExePath": "1"})
        finally:
            ca.SYSTEM = system
        if not WIN: self.assertEqual(ca.child_env({"PATH": ".:/bin"}), {"PATH": ".:/bin"})   # elsewhere, as given

    def test_cmd_shim_arguments(self):
        # Windows runs a .cmd or .bat through cmd, which reads these as syntax even inside quotes
        system, ca.SYSTEM = ca.SYSTEM, "Windows"
        try:
            ca.check_cmd_args("C:\\npm\\claude.cmd", ["--model", "opus", "fix the bug", "a/b.c"])
            ca.check_cmd_args("C:\\bin\\claude.exe", ["a&b"])   # an .exe reads its own arguments
            for bad in ("a&b", "100%", "x^y", '"q"', "(x)", "a|b", "<x", "!x!", "a\nb"):
                with self.assertRaises(SystemExit, msg=bad): ca.check_cmd_args("C:\\npm\\claude.CMD", [bad])
        finally:
            ca.SYSTEM = system

    def test_run_real_claude_version(self):
        if not shutil.which("claude"): self.skipTest("claude not installed")
        r = sh("run", self.r1, "--", "--version", timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr); self.assertIn("Claude Code", r.stdout)
        self.assertIn("account 'work'", r.stderr)
        # the CLI really used the per-account dir (it creates .claude.json there)
        self.assertTrue(os.path.exists(os.path.join(ca.load()["accounts"]["work"]["config_dir"], ".claude.json")))

    def test_auth_status_isolated(self):
        if not shutil.which("claude"): self.skipTest("claude not installed")
        line = ca.deep_status(ca.load()["accounts"]["work"])
        self.assertIn("Not logged in", line)

    @unittest.skipIf(WIN, "POSIX file modes")
    def test_login_state_existence_only(self):
        acc = ca.load()["accounts"]["personal"]
        self.assertEqual(ca.login_state(acc), "not-logged-in")
        p = os.path.join(acc["config_dir"], ".credentials.json")
        write(p, "FAKE")             # dummy file, never read by ca
        os.chmod(p, 0)               # unreadable: proves ca only stats it
        try: self.assertEqual(ca.login_state(acc), "logged-in")
        finally: os.chmod(p, 0o600); os.remove(p)

    def test_docker_cmds(self):
        out = sh("docker-run", self.r2, "--print").stdout
        acc = ca.load()["accounts"]["personal"]
        self.assertIn("docker build -t claude-code-ca:latest", out)
        self.assertIn(f"{acc['docker_config_dir']}:/home/node/.claude", out)
        self.assertIn(f"{os.path.realpath(self.r2)}:/workspace", out)
        self.assertIn("container run --rm -it", out)
        df = read(os.path.join(os.path.dirname(os.environ["CA_CONFIG"]), "docker", "Dockerfile"))
        self.assertIn("npm i -g @anthropic-ai/claude-code", df)
        self.assertIn("docker run", sh("run", self.r2, "--print").stdout)  # run honours mode=docker

    def test_desktop_cmds(self):
        mac = sh("desktop", "work", "--os", "Darwin").stdout
        self.assertIn('open -n -a "Claude"', mac); self.assertIn("--user-data-dir=", mac)
        self.assertIn("claude.exe", sh("desktop", "work", "--os", "Windows").stdout)
        self.assertIn("No official", sh("desktop", "work", "--os", "Linux").stdout)

    @unittest.skipIf(WIN, "the hooks are for zsh and bash")
    def test_shell_hooks(self):
        self.assertTrue(sh("shell-hook", "direnv", self.r1).stdout.startswith("export CLAUDE_CONFIG_DIR="))
        self.assertIn("add-zsh-hook chpwd", sh("shell-hook", "zsh").stdout)
        # bash hook actually switches the variable when cd-ing between repos
        hook = sh("shell-hook", "bash").stdout
        script = f'{hook}\ncd {self.r1}; _ca_hook; echo A=$CA_ACCOUNT\ncd {self.r2}/; _ca_hook; echo B=$CA_ACCOUNT\ncd /; _ca_hook; echo C=${{CA_ACCOUNT:-none}}'
        out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=os.environ).stdout
        self.assertIn("A=work", out); self.assertIn("B=personal", out); self.assertIn("C=none", out)

    def test_account_names(self):
        for n in NAMES["valid"]: self.assertTrue(ca.valid_account_name(n), n)
        for n in NAMES["invalid"]: self.assertFalse(ca.valid_account_name(n), n)
        r = sh("add-account", "WORK")   # folders ignore case on macOS and Windows: it would share the "work" login
        self.assertNotEqual(r.returncode, 0); self.assertIn("'work' already exists", r.stderr)
        self.assertNotEqual(sh("add-account", "../escape").returncode, 0)

    @unittest.skipIf(WIN, "POSIX file modes")
    def test_config_private(self):
        tmp = os.environ["CA_CONFIG"] + ".tmp"
        write(tmp, "stale"); os.chmod(tmp, 0o644)   # a leftover temp file keeps its mode under O_CREAT
        ca.save(ca.load())
        self.assertEqual(os.stat(os.environ["CA_CONFIG"]).st_mode & 0o777, 0o600)

    def test_config_utf8(self):
        r = os.path.join(TMP, "Área de Trabalho"); os.makedirs(r)
        self.assertEqual(sh("bind", r, "work").returncode, 0)
        raw = read(os.environ["CA_CONFIG"])
        self.assertIn("Área de Trabalho", raw)   # written as text, like the app writes it
        self.assertIn(os.path.realpath(r), ca.load()["repos"])
        sh("unbind", r)

    def test_missing_account(self):
        cfg = ca.load(); r = os.path.realpath(self.r1)
        cfg["repos"][r] = {"account": "gone", "mode": "terminal"}; ca.save(cfg)
        try:
            out = sh("env", self.r1)
            self.assertEqual(out.returncode, 1); self.assertIn("'gone' is not configured", out.stderr)
            self.assertNotIn("Traceback", out.stderr)
            self.assertEqual(sh("env", "--shell", self.r1).stdout, sh("env", "--shell", TMP).stdout)   # the hook never fails
            self.assertNotIn("Traceback", sh("run", self.r1, "--print").stderr)
        finally:
            self.assertEqual(sh("bind", self.r1, "work").returncode, 0)

    def test_docker_run_passes_claude_args(self):
        self.assertIn(f"{ca.IMAGE} claude --version", sh("run", self.r2, "--print", "--", "--version").stdout)
        self.assertIn(f"{ca.IMAGE} claude --worktree", sh("run", self.r2, "--print", "-w").stdout)
        self.assertIn(f"{ca.IMAGE} claude --worktree feat-x --model opus",
                      sh("docker-run", self.r2, "--print", "-w", "feat-x", "--", "--model", "opus").stdout)

    @unittest.skipIf(WIN, "the hooks are for zsh and bash")
    def test_shell_hook_keeps_your_config_dir(self):
        hook = sh("shell-hook", "bash").stdout
        script = (f"{hook}\nexport CLAUDE_CONFIG_DIR=/outer\ncd {TMP}; _ca_hook; echo 0=$CLAUDE_CONFIG_DIR\n"
                  f"cd {self.r1}; _ca_hook; echo 1=$CA_ACCOUNT\ncd {TMP}; _ca_hook; echo 2=$CLAUDE_CONFIG_DIR")
        out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=dict(os.environ, PATH=os.environ["PATH"])).stdout
        self.assertEqual(out.split(), ["0=/outer", "1=work", "2=/outer"])

    def test_win_quote(self):
        for arg, want in (("C:\\R&D", '"C:\\R&D"'), ("plain", "plain"), ("100%", '"100%"'), ("", '""'), ("a b\\", '"a b\\\\"')):
            self.assertEqual(ca.win_quote(arg), want)
        with self.assertRaises(SystemExit): ca.win_quote('say "hi" & calc')   # a quote inside would end the quoting

    def test_no_web_ui(self):
        self.assertNotEqual(sh("ui").returncode, 0)   # the app replaced it; ca opens no ports

if __name__ == "__main__":
    unittest.main(verbosity=2)
