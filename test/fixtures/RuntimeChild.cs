// Controlled child process for JVM pipe, timeout and cancellation regressions.
using System;
using System.Text;
using System.Threading;

class RuntimeChild {
    static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
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
