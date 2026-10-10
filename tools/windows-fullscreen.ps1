param([int]$OwnerProcessId, [switch]$Once)
$ErrorActionPreference = 'Stop'
# SHQueryUserNotificationState approach from microsoft/PowerToys (MIT), game_mode.h.
# Also compare the foreground DWM frame to its monitor for borderless games.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DeskPetFullscreen {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  static DeskPetFullscreen() { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor,Work; public uint Flags; }
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h,int attr,out RECT r,int size);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr h,ref MONITORINFO m);
  public static bool Read(int owner) {
    int state; if(SHQueryUserNotificationState(out state)==0 && (state==3 || state==4)) return true;
    IntPtr h=GetForegroundWindow(); if(h==IntPtr.Zero) return false;
    uint pid; GetWindowThreadProcessId(h,out pid); if(pid==owner) return false;
    // A maximized work window can cover the monitor with an auto-hidden taskbar.
    if(IsZoomed(h)) return false;
    var cls=new StringBuilder(128); GetClassName(h,cls,128);
    if(cls.ToString()=="Progman" || cls.ToString()=="WorkerW" || cls.ToString()=="Shell_TrayWnd") return false;
    RECT r; if(DwmGetWindowAttribute(h,9,out r,Marshal.SizeOf(typeof(RECT)))!=0 && !GetWindowRect(h,out r)) return false;
    var m=new MONITORINFO(); m.Size=Marshal.SizeOf(typeof(MONITORINFO));
    if(!GetMonitorInfo(MonitorFromWindow(h,2),ref m)) return false;
    return Math.Abs(r.L-m.Monitor.L)<=2 && Math.Abs(r.T-m.Monitor.T)<=2 && Math.Abs(r.R-m.Monitor.R)<=2 && Math.Abs(r.B-m.Monitor.B)<=2;
  }
}
'@
do {
  if ($OwnerProcessId -gt 0 -and -not (Get-Process -Id $OwnerProcessId -ErrorAction SilentlyContinue)) { break }
  if ([DeskPetFullscreen]::Read($OwnerProcessId)) { [Console]::WriteLine('true') } else { [Console]::WriteLine('false') }
  if ($Once) { break }
  Start-Sleep -Milliseconds 2000
} while ($true)
