using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

// ZCode DevTools 双击启动器：提权后进入 cdp-menu.ps1 交互菜单
// 源码即此文件，可用系统自带 csc 重新编译：
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /out:ZCodeCDPTool.exe launcher.cs
internal static class Launcher
{
    private static int Main(string[] args)
    {
        var exePath = Assembly.GetExecutingAssembly().Location;
        var dir = Path.GetDirectoryName(exePath) ?? ".";
        var menu = Path.Combine(dir, "cdp-menu.ps1");
        if (!File.Exists(menu))
        {
            Console.WriteLine("[x] 缺少 cdp-menu.ps1，请将本程序与补丁仓库 windows 目录放在一起。");
            return 1;
        }

        var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var principal = new System.Security.Principal.WindowsPrincipal(identity);
        var isAdmin = principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);

        if (!isAdmin)
        {
            // 触发 UAC，提权重启自身；提权后的实例负责启动菜单
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
                Console.WriteLine("[x] 已取消提权。请以管理员身份重新运行。");
                return 1;
            }
        }

        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.Title = "ZCode DevTools";
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
