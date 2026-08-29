using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

// WorkBuddy CDP Tool 双击启动器：进入 wb-menu.ps1 交互菜单。
// WorkBuddy 为用户级安装（%LocalAppData%），无需管理员提权。
// 源码即此文件，可用系统自带 csc 重新编译：
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /out:WorkBuddyCDPTool.exe WorkBuddyCDPTool.cs
internal static class Launcher
{
    private static int Main(string[] args)
    {
        var exePath = Assembly.GetExecutingAssembly().Location;
        var dir = Path.GetDirectoryName(exePath) ?? ".";
        var menu = Path.Combine(dir, "wb-menu.ps1");
        if (!File.Exists(menu))
        {
            Console.WriteLine("[x] wb-menu.ps1 not found. Keep this exe inside the workbuddy folder of the repo.");
            return 1;
        }

        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.Title = "WorkBuddy CDP Tool";
        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + menu + "\"",
            UseShellExecute = false,
            WorkingDirectory = dir,
        };
        using (var p = Process.Start(psi))
        {
            if (p != null) p.WaitForExit();
        }
        return 0;
    }
}
