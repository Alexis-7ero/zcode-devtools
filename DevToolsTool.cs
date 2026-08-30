using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

// DevTools Tool 双击启动器：进入 app-menu.ps1 统一菜单（ZCode + WorkBuddy）。
// ZCode 装在 Program Files 需要管理员权限，因此启动即请求提权（WorkBuddy 不受影响）。
// 源码即此文件，可用系统自带 csc 重新编译：
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /out:DevToolsTool.exe DevToolsTool.cs
internal static class Launcher
{
    private static int Main(string[] args)
    {
        var exePath = Assembly.GetExecutingAssembly().Location;
        var dir = Path.GetDirectoryName(exePath) ?? ".";
        var menu = Path.Combine(dir, "app-menu.ps1");
        if (!File.Exists(menu))
        {
            Console.WriteLine("[x] app-menu.ps1 not found. Keep this exe at the repo root.");
            return 1;
        }

        var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var principal = new System.Security.Principal.WindowsPrincipal(identity);
        var isAdmin = principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);

        if (!isAdmin)
        {
            var self = new ProcessStartInfo(exePath)
            {
                UseShellExecute = true,
                Verb = "runas",
                WorkingDirectory = dir,
            };
            try
            {
                var p = Process.Start(self);
                if (p != null) p.WaitForExit();
                return 0;
            }
            catch (Exception)
            {
                Console.WriteLine("[x] elevation canceled. Run as administrator to patch ZCode (WorkBuddy works without it).");
                return 1;
            }
        }

        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.Title = "DevTools Tool (ZCode / WorkBuddy)";
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
