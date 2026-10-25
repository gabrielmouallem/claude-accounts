"""Tests for ca. Run: python3 test_ca.py  (uses a throwaway config; no network, no login)."""
import json, os, subprocess, sys, tempfile, threading, time, unittest, urllib.request, importlib.util, importlib.machinery, shutil
HERE = os.path.dirname(os.path.abspath(__file__))
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
        cfg = json.load(open(os.environ["CA_CONFIG"]))
        self.assertEqual(set(cfg["accounts"]), {"work", "personal"})
        for a in cfg["accounts"].values():
            self.assertTrue({"config_dir", "desktop_user_data_dir", "docker_config_dir"} <= set(a))
            self.assertEqual(os.stat(a["config_dir"]).st_mode & 0o777, 0o700)
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
        env = ca.claude_env(acc, {"ANTHROPIC_API_KEY": "x", "PATH": "/bin"})
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], acc["config_dir"]); self.assertNotIn("ANTHROPIC_API_KEY", env)
        out = sh("env", "--shell", os.path.join(self.r1, "src")).stdout
        self.assertIn(f"export CLAUDE_CONFIG_DIR={acc['config_dir']}", out)
        self.assertIn("unset", sh("env", "--shell", TMP).stdout)

    def test_run_print_and_worktree(self):
        out = sh("run", self.r1, "--print", "--worktree", "feat-x").stdout
        self.assertIn("CLAUDE_CONFIG_DIR=", out); self.assertIn("claude --worktree feat-x", out)
        self.assertIn("claude --worktree", sh("run", self.r1, "--print", "-w").stdout)

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

    def test_login_state_existence_only(self):
        acc = ca.load()["accounts"]["personal"]
        self.assertEqual(ca.login_state(acc), "not-logged-in")
        p = os.path.join(acc["config_dir"], ".credentials.json")
        open(p, "w").write("FAKE")   # dummy file, never read by ca
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
        df = open(os.path.join(os.path.dirname(os.environ["CA_CONFIG"]), "docker", "Dockerfile")).read()
        self.assertIn("npm i -g @anthropic-ai/claude-code", df)
        self.assertIn("docker run", sh("run", self.r2, "--print").stdout)  # run honours mode=docker

    def test_desktop_cmds(self):
        mac = sh("desktop", "work", "--os", "Darwin").stdout
        self.assertIn('open -n -a "Claude"', mac); self.assertIn("--user-data-dir=", mac)
        self.assertIn("claude.exe", sh("desktop", "work", "--os", "Windows").stdout)
        self.assertIn("No official", sh("desktop", "work", "--os", "Linux").stdout)

    def test_shell_hooks(self):
        self.assertTrue(sh("shell-hook", "direnv", self.r1).stdout.startswith("export CLAUDE_CONFIG_DIR="))
        self.assertIn("add-zsh-hook chpwd", sh("shell-hook", "zsh").stdout)
        # bash hook actually switches the variable when cd-ing between repos
        hook = sh("shell-hook", "bash").stdout
        script = f'{hook}\ncd {self.r1}; _ca_hook; echo A=$CA_ACCOUNT\ncd {self.r2}/; _ca_hook; echo B=$CA_ACCOUNT\ncd /; _ca_hook; echo C=${{CA_ACCOUNT:-none}}'
        out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=os.environ).stdout
        self.assertIn("A=work", out); self.assertIn("B=personal", out); self.assertIn("C=none", out)

    def test_web_ui(self):
        port = 18765
        p = subprocess.Popen(CA + ["ui", "--port", str(port), "--no-launch"], stdout=subprocess.PIPE, text=True,
                             env=dict(os.environ, CA_NO_BROWSER="1"))
        try:
            url = p.stdout.readline().split()[-1]; token = url.split("token=")[1]
            self.assertTrue(url.startswith(f"http://127.0.0.1:{port}/"))
            self.assertIn("one account per repo", urllib.request.urlopen(url).read().decode())
            for bad in (f"http://127.0.0.1:{port}/", f"http://127.0.0.1:{port}/?token=wrong"):
                with self.assertRaises(urllib.error.HTTPError): urllib.request.urlopen(bad)
            hdr = {"X-CA-Token": token, "Content-Type": "application/json"}
            st = json.load(urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/api/state", headers=hdr)))
            self.assertEqual(len(st["repos"]), 2)
            # rebind via API
            req = urllib.request.Request(f"http://127.0.0.1:{port}/api/bind", headers=hdr, method="POST",
                data=json.dumps({"repo": self.r1, "account": "personal", "mode": "terminal"}).encode())
            self.assertTrue(json.load(urllib.request.urlopen(req))["ok"])
            self.assertEqual(ca.load()["repos"][os.path.realpath(self.r1)]["account"], "personal")
            req = urllib.request.Request(f"http://127.0.0.1:{port}/api/action", headers=hdr, method="POST",
                data=json.dumps({"action": "terminal", "repo": self.r1}).encode())
            self.assertIn("claude", json.load(urllib.request.urlopen(req))["command"])
            # wrong Host header rejected (DNS rebinding)
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/api/state", headers=dict(hdr, Host="evil.com")))
        finally:
            subprocess.run(CA + ["bind", self.r1, "work"], env=os.environ)
            p.terminate(); p.wait()

if __name__ == "__main__":
    unittest.main(verbosity=2)
