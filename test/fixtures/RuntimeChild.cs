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
        if (executable.StartsWith("clangd")) return LanguageServer();
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
        } else if (entry == "error.py") {
            Console.Error.WriteLine("PROBLEM");
            return 3;
        } else {
            Console.WriteLine("HELLO");
        }
        return 0;
    }

    static string HeaderLine(Stream input) {
        StringBuilder text = new StringBuilder();
        int value;
        while ((value = input.ReadByte()) != -1) {
            if (value == '\n') break;
            if (value != '\r') text.Append((char)value);
        }
        return value == -1 && text.Length == 0 ? null : text.ToString();
    }

    static int LanguageServer() {
        Stream input = Console.OpenStandardInput(), output = Console.OpenStandardOutput();
        while (true) {
            string line;
            int length = -1;
            while ((line = HeaderLine(input)) != null && line != "") {
                if (line.StartsWith("Content-Length:")) length = int.Parse(line.Substring(15));
            }
            if (line == null) return 0;
            if (length < 0) return 1;
            byte[] payload = new byte[length];
            int offset = 0;
            while (offset < length) {
                int read = input.Read(payload, offset, length - offset);
                if (read == 0) return 1;
                offset += read;
            }
            string message = Encoding.UTF8.GetString(payload);
            Match id = Regex.Match(message, "\"id\":(\\d+)");
            if (!id.Success) continue;
            string result = "{}";
            if (message.Contains("textDocument/completion")) result = "[{\"label\":\"candidate\"}]";
            if (message.Contains("textDocument/definition")) result = "[{\"uri\":\"file:///main.c\",\"range\":{\"start\":{\"line\":0,\"character\":0},\"end\":{\"line\":0,\"character\":1}}}]";
            if (message.Contains("textDocument/diagnostic")) result = "{\"kind\":\"full\",\"items\":[]}";
            byte[] body = Encoding.UTF8.GetBytes("{\"jsonrpc\":\"2.0\",\"id\":" + id.Groups[1].Value + ",\"result\":" + result + "}");
            byte[] header = Encoding.ASCII.GetBytes("Content-Length: " + body.Length + "\r\n\r\n");
            output.Write(header, 0, header.Length);
            output.Write(body, 0, body.Length);
            output.Flush();
        }
    }
}
