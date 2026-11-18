# Lance le banc de mesure JETABLE avec la clÃ© Gemini lue dans le Gestionnaire d'identification (jamais affichÃ©e).
param([string]$Wav = "", [int]$Runs = 3, [switch]$Probe, [switch]$Verify, [switch]$Delegation)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NozCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      var bytes = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
      return bytes;
    } finally { CredFree(p); }
  }
}
"@

$bytes = [NozCred]::Read("gemini_api_key.NozBar")
if (-not $bytes) { throw "ClÃ© introuvable dans le Gestionnaire d'identification" }
# keyring stocke en UTF-8 ou en UTF-16 selon la version : un octet nul en position 1 trahit l'UTF-16.
$key = if ($bytes.Length -gt 1 -and $bytes[1] -eq 0) { [Text.Encoding]::Unicode.GetString($bytes) } else { [Text.Encoding]::UTF8.GetString($bytes) }
$env:GEMINI_API_KEY = $key.Trim()

if ($Delegation) { node (Join-Path $PSScriptRoot "verify-delegation.mjs"); return }
if ($Verify) { node (Join-Path $PSScriptRoot "verify-assistant.mjs") $Wav; return }
if ($Probe) { node (Join-Path $PSScriptRoot "probe-gemini.mjs"); return }
$script = Join-Path $PSScriptRoot "bench-gemini.mjs"
if ($Wav) { node $script $Wav $Runs } else { node $script "" $Runs }
