# Simule des appuis maintenus sur Alt+Espace (push-to-talk) pour reproduire les problèmes de relâchement.
# Usage : powershell -File scripts/ptt-sim.ps1 -HoldMs 500,1000,3000
param([int[]]$HoldMs = @(500, 1000, 3000), [switch]$Repeat, [switch]$AltFirst)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Keys {
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    public static void Key(ushort vk, bool up) {
        var i = new INPUT[1];
        i[0].type = 1; i[0].ki.wVk = vk; i[0].ki.dwFlags = up ? 2u : 0u;
        SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@

$ALT = 0x12; $SPACE = 0x20
foreach ($hold in $HoldMs) {
    "--- appui de $hold ms ---"
    [Keys]::Key($ALT, $false); Start-Sleep -Milliseconds 30
    [Keys]::Key($SPACE, $false)
    $start = Get-Date
    while (((Get-Date) - $start).TotalMilliseconds -lt $hold) {
        Start-Sleep -Milliseconds 33
        # Répétition automatique du clavier : Espace « redescend » sans avoir été relâché.
        if ($Repeat -and ((Get-Date) - $start).TotalMilliseconds -gt 500) { [Keys]::Key($SPACE, $false) }
    }
    if ($AltFirst) { [Keys]::Key($ALT, $true); Start-Sleep -Milliseconds 40; [Keys]::Key($SPACE, $true) }
    else { [Keys]::Key($SPACE, $true); Start-Sleep -Milliseconds 40; [Keys]::Key($ALT, $true) }
    Start-Sleep -Milliseconds 2500
}
