"""Run the production Java-embedded bootstrap with the host Python interpreter."""
import json
import pathlib
import re
import subprocess
import sys
import tempfile

repo = pathlib.Path(__file__).resolve().parent.parent
source = (repo / "android/app/src/main/java/com/doge/ide/PythonRunner.java").read_text(encoding="utf-8")
syntax_exit = re.search(r"SYNTAX_EXIT\s*=\s*(\d+)", source).group(1)
block = source.split("static final String BOOT =", 1)[1].split("private final File filesDir", 1)[0]
block = block.replace("SYNTAX_EXIT", json.dumps(syntax_exit))
boot = "".join(json.loads(token) for token in re.findall(r'"(?:[^"\\]|\\.)*"', block))
failed = 0


def run(files, entry="main.py", stdin=""):
    with tempfile.TemporaryDirectory(prefix="doge-bootstrap-test-") as temp:
        root = pathlib.Path(temp)
        for name, code in files.items():
            file = root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(code, encoding="utf-8")
        (root / ".doge_boot.py").write_text(boot, encoding="utf-8")
        return subprocess.run(
            [sys.executable, "-I", "-B", "-u", ".doge_boot.py", entry],
            cwd=root, input=stdin, text=True, encoding="utf-8", capture_output=True, timeout=5,
        )


def check(name, condition):
    global failed
    print(("PASS " if condition else "FAIL ") + name)
    if not condition:
        failed += 1


result = run({"src/main.py": "import helper, common\nprint(helper.VALUE, common.VALUE)\n",
              "src/helper.py": "VALUE = 123\n", "common.py": "VALUE = 456\n"}, "src/main.py")
check("nested entry imports siblings and root modules", result.returncode == 0 and result.stdout.strip() == "123 456")
result = run({"src/main.py": "import helper\nprint(helper.VALUE)\n",
              "src/helper.py": "VALUE = 'sibling'\n", "helper.py": "VALUE = 'root'\n"}, "src/main.py")
check("entry directory has normal Python import precedence", result.returncode == 0 and result.stdout.strip() == "sibling")
result = run({"main.py": "import helper\nprint(helper.VALUE)\n", "helper.py": "VALUE = 7\n"})
check("root entry imports remain supported", result.returncode == 0 and result.stdout.strip() == "7")
result = run({"main.py": "print('should not run')\n", "unused.py": "def broken(\n"})
check("syntax errors in project files are reported before execution", result.returncode == int(syntax_exit) and "SyntaxError" in result.stderr and not result.stdout)
result = run({"src/main.py": "raise ValueError('probe')\n"}, "src/main.py")
check("runtime traceback names the nested entry", result.returncode == 1 and 'File "src/main.py", line 1' in result.stderr and "ValueError: probe" in result.stderr)
check("runtime traceback omits the bootstrap frame", ".doge_boot.py\", line" not in result.stderr)
result = run({"main.py": "import sys\nsys.exit(3)\n"})
check("explicit exit code is preserved", result.returncode == 3)
result = run({"main.py": "print(input())\n"}, stdin="hello\n")
check("stdin is preserved", result.returncode == 0 and result.stdout.strip() == "hello")
if failed:
    print(f"Python bootstrap regression: {failed} failed", file=sys.stderr)
    sys.exit(1)
print("Python bootstrap regression: all passed")
