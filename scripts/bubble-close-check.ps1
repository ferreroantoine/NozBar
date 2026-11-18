# Vérifie qu'Échap ferme la bulle, qu'elle ait le focus ou non.
Add-Type @"
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class Ui {
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    public static void Key(ushort vk, bool up) {
        var i = new INPUT[1]; i[0].type = 1; i[0].ki.wVk = vk; i[0].ki.dwFlags = up ? 2u : 0u;
        SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    public static bool BubbleVisible() {
        uint target = (uint)Process.GetProcessesByName("nozbar")[0].Id; bool found = false;
        EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid);
            var t = new StringBuilder(256); GetWindowText(h, t, 256); RECT r; GetWindowRect(h, out r);
            // Les fenêtres techniques de Tauri (16×16) et les paramètres ne comptent pas.
            if (pid == target && IsWindowVisible(h) && r.R - r.L > 100 && t.ToString() != "Paramètres de NozBar") found = true;
            return true; }, IntPtr.Zero);
        return found;
    }
    public static bool BubbleFocused() {
        uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        return pid == (uint)Process.GetProcessesByName("nozbar")[0].Id;
    }
}
"@
$ALT = 0x12; $SPACE = 0x20; $ESC = 0x1B
"avant : visible=$([Ui]::BubbleVisible())"
[Ui]::Key($ALT, $false); [Ui]::Key($SPACE, $false); Start-Sleep -Milliseconds 80; [Ui]::Key($SPACE, $true); [Ui]::Key($ALT, $true)
Start-Sleep -Milliseconds 900
"ouverte : visible=$([Ui]::BubbleVisible()) focus=$([Ui]::BubbleFocused())"
[Ui]::Key($ESC, $false); Start-Sleep -Milliseconds 60; [Ui]::Key($ESC, $true)
Start-Sleep -Milliseconds 700
"après Échap : visible=$([Ui]::BubbleVisible())"
