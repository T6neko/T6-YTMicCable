param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][double]$Volume  # 0-100
)

$ErrorActionPreference = 'Stop'
# NOTE: [Math]::Min(1, ...) / [Math]::Max(0, ...) would silently pick the
# int overload here (since 1 and 0 are int literals) and truncate the
# fractional volume to 0 - use plain conditionals instead.
[double]$level = $Volume / 100.0
if ($level -lt 0) { $level = 0.0 }
if ($level -gt 1) { $level = 1.0 }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ComImport]
class MMDeviceEnumeratorComObject { }

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
interface IMMDeviceCollection
{
    int GetCount(out int count);
    int Item(int i, out IMMDevice dev);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
interface IMMDevice
{
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
interface IAudioSessionManager2
{
    int NotImpl1(); // GetAudioSessionControl
    int NotImpl2(); // GetSimpleAudioVolume
    int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
interface IAudioSessionEnumerator
{
    int GetCount(out int SessionCount);
    int GetSession(int SessionCount, out IAudioSessionControl2 Session);
}

[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
interface IAudioSessionControl2
{
    int NotImpl1();  // GetState
    int NotImpl2();  // GetDisplayName
    int NotImpl3();  // SetDisplayName
    int NotImpl4();  // GetIconPath
    int NotImpl5();  // SetIconPath
    int NotImpl6();  // GetGroupingParam
    int NotImpl7();  // SetGroupingParam
    int NotImpl8();  // RegisterAudioSessionNotification
    int NotImpl9();  // UnregisterAudioSessionNotification
    int NotImpl10(); // GetSessionIdentifier
    int NotImpl11(); // GetSessionInstanceIdentifier
    int GetProcessId(out uint pid);
}

[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
interface ISimpleAudioVolume
{
    int SetMasterVolume(float fLevel, ref Guid EventContext);
    int GetMasterVolume(out float pfLevel);
    int SetMute(bool bMute, ref Guid EventContext);
    int GetMute(out bool pbMute);
}

public class VolumeHelper
{
    // The target process may be outputting to any playback device (e.g. a
    // per-app override sends ffplay to "CABLE Input" while the system
    // default is the user's speakers) - its audio session only exists on
    // whichever device it's actually using, so every active render device
    // must be searched rather than just the default one.
    public static string SetVolumeForProcess(int pid, float level)
    {
        var enumeratorObj = new MMDeviceEnumeratorComObject();
        var deviceEnumerator = (IMMDeviceEnumerator)enumeratorObj;

        IMMDeviceCollection devices;
        int hr = deviceEnumerator.EnumAudioEndpoints(0, 1, out devices); // eRender, DEVICE_STATE_ACTIVE
        if (hr != 0) return "ERR_EnumAudioEndpoints_" + hr;
        int deviceCount;
        devices.GetCount(out deviceCount);

        int totalSessions = 0;
        for (int d = 0; d < deviceCount; d++)
        {
            IMMDevice device;
            devices.Item(d, out device);

            Guid iid = typeof(IAudioSessionManager2).GUID;
            object obj;
            if (device.Activate(ref iid, 23, IntPtr.Zero, out obj) != 0) continue; // CLSCTX_ALL
            var sessionManager = (IAudioSessionManager2)obj;

            IAudioSessionEnumerator sessionEnumerator;
            sessionManager.GetSessionEnumerator(out sessionEnumerator);
            int count;
            sessionEnumerator.GetCount(out count);
            totalSessions += count;

            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl2 session;
                sessionEnumerator.GetSession(i, out session);
                uint sessionPid;
                session.GetProcessId(out sessionPid);
                if (sessionPid == (uint)pid)
                {
                    var simpleVolume = (ISimpleAudioVolume)session;
                    Guid guid = Guid.Empty;
                    int setHr = simpleVolume.SetMasterVolume(level, ref guid);
                    float readBack;
                    simpleVolume.GetMasterVolume(out readBack);
                    return "OK hr=" + setHr + " readback=" + readBack;
                }
            }
        }
        return "SESSION_NOT_FOUND(devices=" + deviceCount + " totalSessions=" + totalSessions + ")";
    }
}
"@

$result = [VolumeHelper]::SetVolumeForProcess($ProcessId, $level)
Write-Output $result
