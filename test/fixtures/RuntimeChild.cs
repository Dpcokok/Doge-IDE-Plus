// Controlled child process for JVM pipe, timeout and cancellation regressions.
using System;
using System.Text;
using System.Threading;
using System.IO;
using System.Text.RegularExpressions;

class RuntimeChild {
    static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        string executable = Path.GetFileName(Environment.GetCommandLineArgs()[0]);
        if (executable.StartsWith("clang")) {
            string source = args[Array.IndexOf(args, "-c") + 1];
            string target = args[Array.IndexOf(args, "-o") + 1];
            string code = File.ReadAllText(source);
            foreach (Match include in Regex.Matches(code, "#include\\s*\"([^\"]+)\"")) {
                string name = include.Groups[1].Value;
                if (!File.Exists(Path.Combine(Path.GetDirectoryName(source), name)) && !File.Exists(Path.Combine(Environment.CurrentDirectory, name))) {
                    Console.Error.WriteLine(source + ":1:10: error: missing header " + name);
                    return 1;
                }
            }
            File.WriteAllText(target, code);
            return 0;
        }
        if (executable.StartsWith("wasm-ld")) {
            File.WriteAllText(args[Array.IndexOf(args, "-o") + 1], "compiled module");
            return 0;
        }
        string entry = args.Length == 0 ? "" : args[args.Length - 1];
        if (entry == "slow.py") {
            Console.WriteLine("START");
            Console.Out.Flush();
            Thread.Sleep(10000);
        } else if (entry == "echo.py") {
            Console.Write(Console.In.ReadToEnd());
        } else if (entry == "interactive.py") {
            for (int i = 0; i < 2; i++) {
                Console.WriteLine("LINE:" + Console.ReadLine());
                Console.Out.Flush();
            }
        } else {
            Console.WriteLine("HELLO");
        }
        return 0;
    }
}
