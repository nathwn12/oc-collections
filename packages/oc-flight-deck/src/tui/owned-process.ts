import { join } from "node:path";

// Windows has no Node Job Object API. This in-process PowerShell helper uses
// only process/job handles; it never opens credentials or alternate tokens.
// The server is born suspended and cannot run before assignment to our job.
const supervisor = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class FlightDeckOwned {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorking, MaxWorking; public uint Active;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread; public uint Pid, Tid;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateJobObjectW(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder command, IntPtr ps, IntPtr ts,
    bool inherit, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Require(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var text = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { text.Append('\\', slashes * 2 + 1); text.Append(c); }
      else { text.Append('\\', slashes); text.Append(c); }
      slashes = 0;
    }
    text.Append('\\', slashes * 2); return text.Append('"').ToString();
  }
  public static int Run(string executable, string[] args, uint ownerPid) {
    IntPtr owner = IntPtr.Zero, job = IntPtr.Zero;
    ProcessInfo child = new ProcessInfo();
    try {
      owner = OpenProcess(0x00101000, false, ownerPid);
      Require(owner != IntPtr.Zero);
      long ownerCreated, ownCreated, ignored1, ignored2, ignored3;
      Require(GetProcessTimes(owner, out ownerCreated, out ignored1, out ignored2, out ignored3));
      Require(GetProcessTimes(GetCurrentProcess(), out ownCreated, out ignored1, out ignored2, out ignored3));
      // Refuse a recycled owner PID, and hold its identity handle thereafter.
      if (ownerCreated > ownCreated || WaitForSingleObject(owner, 0) != 258) return 1;
      job = CreateJobObjectW(IntPtr.Zero, null);
      Require(job != IntPtr.Zero);
      var limits = new Limits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
      Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))));
      var startup = new Startup(); startup.Size = (uint)Marshal.SizeOf(typeof(Startup));
      startup.Flags = 0x100; // STARTF_USESTDHANDLES.
      startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      foreach (IntPtr handle in new [] { startup.Input, startup.Output, startup.Error })
        Require(SetHandleInformation(handle, 1, 1));
      var command = new StringBuilder(Quote(executable));
      foreach (string arg in args) command.Append(" ").Append(Quote(arg));
      Require(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
        0x08000004, IntPtr.Zero, null, ref startup, out child)); // NO_WINDOW | SUSPENDED.
      if (!AssignProcessToJobObject(job, child.Process)) {
        // The uncontained child is still suspended. Terminate its exact handle.
        TerminateProcess(child.Process, 1); WaitForSingleObject(child.Process, 5000);
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      Require(ResumeThread(child.Thread) != UInt32.MaxValue);
      uint ready = WaitForMultipleObjects(2, new [] { child.Process, owner }, false, UInt32.MaxValue);
      if (ready != 0) {
        TerminateJobObject(job, 1); WaitForSingleObject(child.Process, 5000); return 1;
      }
      uint code; Require(GetExitCodeProcess(child.Process, out code));
      return (int)code;
    } finally {
      // Closing our non-inherited handle kills every remaining descendant,
      // including detached children, on normal exit, timeout or helper crash.
      if (job != IntPtr.Zero) CloseHandle(job);
      if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
      if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
      if (owner != IntPtr.Zero) CloseHandle(owner);
    }
  }
}
`;

/** Start a private native process enclosed in an owned Windows job. */
export function ownedProcess(command: string, args: string[], ownerPid = process.pid): { command: string; args: string[] } {
  const encoded = (value: string) => Buffer.from(value).toString("base64");
  const decode = (value: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(value)}'))`;
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${supervisor}\n'@\n` +
    `$command=${decode(command)}\n$argsList=${decode(JSON.stringify(args))}|ConvertFrom-Json\n` +
    `exit [FlightDeckOwned]::Run($command,[string[]]$argsList,${ownerPid})`;
  return {
    command: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}
