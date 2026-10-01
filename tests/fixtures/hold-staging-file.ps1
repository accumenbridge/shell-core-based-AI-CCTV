param(
  [Parameter(Mandatory=$true)][string]$Path,
  [ValidateRange(100, 20000)][int]$TimeoutMilliseconds = 20000
)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class RegistryFixturePipe {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, uint size, IntPtr read, out uint available, IntPtr left);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadFile(IntPtr file, byte[] buffer, uint count, out uint read, IntPtr overlapped);

  public static bool ReadGo(int timeoutMilliseconds, out string error) {
    error = null;
    IntPtr pipe = GetStdHandle(-10);
    if (pipe == IntPtr.Zero || pipe == new IntPtr(-1)) { error = "Standard input is unavailable."; return false; }
    var bytes = new List<byte>();
    var timer = Stopwatch.StartNew();
    while (timer.ElapsedMilliseconds < timeoutMilliseconds) {
      uint available;
      if (!PeekNamedPipe(pipe, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero)) {
        error = "Could not inspect fixture input (Win32 " + Marshal.GetLastWin32Error() + ").";
        return false;
      }
      if (available == 0) { Thread.Sleep(25); continue; }
      byte[] one = new byte[1]; uint read;
      if (!ReadFile(pipe, one, 1, out read, IntPtr.Zero) || read != 1) {
        error = "Could not read fixture input (Win32 " + Marshal.GetLastWin32Error() + ").";
        return false;
      }
      if (one[0] == 10) {
        if (bytes.Count > 0 && bytes[bytes.Count - 1] == 13) bytes.RemoveAt(bytes.Count - 1);
        if (Encoding.ASCII.GetString(bytes.ToArray()) == "GO") return true;
        error = "Fixture input did not contain the expected release signal.";
        return false;
      }
      if (bytes.Count >= 128) { error = "Fixture input exceeded its bounded line length."; return false; }
      bytes.Add(one[0]);
    }
    error = "Timed out waiting for the bounded fixture release signal.";
    return false;
  }
}
'@
$stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
$released = $false
$failure = $null
try {
  [Console]::Out.WriteLine('LOCKED')
  [Console]::Out.Flush()
  $inputError = $null
  if (-not [RegistryFixturePipe]::ReadGo($TimeoutMilliseconds, [ref]$inputError)) { $failure = $inputError }
} catch {
  $failure = $_.Exception.Message
} finally {
  try {
    $stream.Dispose()
    $released = $true
  } catch {
    $failure = "Could not dispose the held fixture file: $($_.Exception.Message)"
  }
}

if ($released) {
  [Console]::Out.WriteLine('RELEASED')
  [Console]::Out.Flush()
} else {
  [Console]::Error.WriteLine('The held fixture file was not positively released.')
}

if ($failure) {
  [Console]::Error.WriteLine($failure)
  exit 2
}
