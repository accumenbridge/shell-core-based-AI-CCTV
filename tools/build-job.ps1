param(
  [Parameter(Mandatory=$true)][string]$RunnerNonce,
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$WorkingDirectory,
  [Parameter(Mandatory=$true)][string]$ScriptPath,
  [Parameter(Mandatory=$true)][string]$ArgumentsJson,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [switch]$RuntimeProtocol
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
public static class QbBuildJob {
  const uint CREATE_SUSPENDED=0x00000004, CREATE_UNICODE_ENVIRONMENT=0x00000400, EXTENDED_STARTUPINFO_PRESENT=0x00080000;
  const uint STARTF_USESTDHANDLES=0x00000100, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x00002000, PROC_THREAD_ATTRIBUTE_HANDLE_LIST=0x00020002;
  const uint GENERIC_READ=0x80000000, GENERIC_WRITE=0x40000000, FILE_SHARE_READ=1, FILE_SHARE_WRITE=2, CREATE_ALWAYS=2, OPEN_EXISTING=3, FILE_ATTRIBUTE_NORMAL=0x80;
  const uint HANDLE_FLAG_INHERIT=1, WAIT_OBJECT_0=0, WAIT_TIMEOUT=258, INFINITE=0xffffffff;
  const int JobObjectExtendedLimitInformation=9, JobObjectBasicAccountingInformation=1;
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved,lpDesktop,lpTitle; public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public short wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_ACCOUNTING { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT data,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,ref BASIC_ACCOUNTING data,uint length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttrs,IntPtr threadAttrs,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool PeekNamedPipe(IntPtr pipe,IntPtr buffer,uint size,IntPtr read,out uint available,IntPtr left);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr file,byte[] buffer,uint size,out uint read,IntPtr overlapped);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr file,byte[] buffer,uint size,out uint written,IntPtr overlapped);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES attributes,uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static Exception Win(string what){return new Exception(what+" (Win32 "+Marshal.GetLastWin32Error()+")");}
  static string Quote(string s){
    if(s.Length>0 && s.IndexOfAny(new char[]{' ','\t','\n','\v','"'})<0)return s;
    var b=new StringBuilder("\"");int slashes=0;
    foreach(char c in s){if(c=='\\'){slashes++;continue;}if(c=='"'){b.Append('\\',slashes*2+1);b.Append('"');slashes=0;continue;}b.Append('\\',slashes);slashes=0;b.Append(c);}
    b.Append('\\',slashes*2);b.Append('"');return b.ToString();
  }
  static bool Active(IntPtr job,out uint active){var info=new BASIC_ACCOUNTING();if(!QueryInformationJobObject(job,JobObjectBasicAccountingInformation,ref info,(uint)Marshal.SizeOf(typeof(BASIC_ACCOUNTING)),IntPtr.Zero)){active=0;return false;}active=info.ActiveProcesses;return true;}
  static bool WaitEmpty(IntPtr job,int ms){var end=Environment.TickCount+ms;do{uint active;if(!Active(job,out active))return false;if(active==0)return true;Thread.Sleep(100);}while(unchecked(Environment.TickCount-end)<0);uint last;return Active(job,out last)&&last==0;}
  static int StopJob(IntPtr job,int code){if(!TerminateJobObject(job,(uint)code)){uint active;if(!Active(job,out active))return -2;if(active!=0)return -2;return code;}return WaitEmpty(job,10000)?code:-3;}
  static StringBuilder controlBuffer=new StringBuilder();static string CurrentCommand="";
  static int ParseBuffered(string nonce,bool runtimeProtocol){
    int newline=controlBuffer.ToString().IndexOf('\n');if(newline<0)return controlBuffer.Length>128?-2:0;
    if(newline>128)return -2;
    string line=controlBuffer.ToString(0,newline).TrimEnd('\r');controlBuffer.Remove(0,newline+1);CurrentCommand=line;
    if(!runtimeProtocol)return line=="STOP"?1:-2;
    if(line=="STOP:"+nonce)return 1;if(line=="RESUME:"+nonce)return 2;return -2;
  }
  static int Control(string nonce,bool runtimeProtocol){
    int buffered=ParseBuffered(nonce,runtimeProtocol);if(buffered!=0)return buffered;
    IntPtr input=GetStdHandle(-10);uint available=0;
    if(input==IntPtr.Zero||input==new IntPtr(-1))return -1;
    if(!PeekNamedPipe(input,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero)){int e=Marshal.GetLastWin32Error();return e==109||e==6?-1:-2;}
    if(available==0)return 0;
    byte[] bytes=new byte[Math.Min(available,256)];uint read;if(!ReadFile(input,bytes,(uint)bytes.Length,out read,IntPtr.Zero))return -2;
    controlBuffer.Append(Encoding.ASCII.GetString(bytes,0,(int)read));
    return ParseBuffered(nonce,runtimeProtocol);
  }
  static void Pump(IntPtr pipe,IntPtr log,ref long logged){
    int drained=0;while(drained<65536){uint available=0;if(!PeekNamedPipe(pipe,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero)){int e=Marshal.GetLastWin32Error();if(e==109||e==6)return;throw Win("Reading isolated build output failed");}if(available==0)return;
      byte[] bytes=new byte[Math.Min(available,8192)];uint read;if(!ReadFile(pipe,bytes,(uint)bytes.Length,out read,IntPtr.Zero))throw Win("Draining isolated build output failed");
      long remaining=1048576-logged;if(remaining>0){uint count=(uint)Math.Min((long)read,remaining),written;if(!WriteFile(log,bytes,count,out written,IntPtr.Zero)||written!=count)throw Win("Writing bounded private build log failed");logged+=written;}
      drained+=(int)read;
    }
  }
  public static int Run(string nonce,string node,string cwd,string script,string[] args,string log,bool runtimeProtocol){
    args=args??new string[0];
    IntPtr job=IntPtr.Zero,logHandle=IntPtr.Zero,nullHandle=IntPtr.Zero,inputRead=IntPtr.Zero,attributes=IntPtr.Zero,handleList=IntPtr.Zero,outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero;PROCESS_INFORMATION pi=new PROCESS_INFORMATION();bool outsideChildUncertain=false;int exit=125;bool proof=false;long logged=0;
    string stage="create-job";
    try{
      job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw Win("CreateJobObject failed");
      stage="configure-job";
      var limits=new EXTENDED_LIMIT();limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))throw Win("SetInformationJobObject failed");
      stage="open-private-log";
      logHandle=CreateFile(log,GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,IntPtr.Zero,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);if(logHandle==new IntPtr(-1))throw Win("Opening bounded private log failed");
      stage="prepare-child-handles";
      var security=new SECURITY_ATTRIBUTES();security.nLength=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));security.bInheritHandle=true;
      nullHandle=CreateFile("NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,IntPtr.Zero,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);if(nullHandle==new IntPtr(-1))throw Win("Opening child input failed");inputRead=nullHandle;
      if(!CreatePipe(out outRead,out outWrite,ref security,0)||!CreatePipe(out errRead,out errWrite,ref security,0))throw Win("Creating bounded output pipes failed");
      if(!SetHandleInformation(outRead,HANDLE_FLAG_INHERIT,0)||!SetHandleInformation(errRead,HANDLE_FLAG_INHERIT,0)||!SetHandleInformation(inputRead,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT)||
          !SetHandleInformation(outWrite,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT)||!SetHandleInformation(errWrite,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT))throw Win("Preparing isolated standard handles failed");
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);attributes=Marshal.AllocHGlobal(size);if(!InitializeProcThreadAttributeList(attributes,1,0,ref size))throw Win("Initializing child handle allowlist failed");
      handleList=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handleList,0,inputRead);Marshal.WriteIntPtr(handleList,IntPtr.Size,outWrite);Marshal.WriteIntPtr(handleList,IntPtr.Size*2,errWrite);
      if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero))throw Win("Applying child handle allowlist failed");
      var startup=new STARTUPINFOEX();startup.StartupInfo.cb=Marshal.SizeOf(typeof(STARTUPINFOEX));startup.StartupInfo.dwFlags=(int)STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=inputRead;startup.StartupInfo.hStdOutput=outWrite;startup.StartupInfo.hStdError=errWrite;startup.lpAttributeList=attributes;
      var all=new string[args.Length+1];all[0]=script;Array.Copy(args,0,all,1,args.Length);
      var command=new StringBuilder(Quote(node)+" "+String.Join(" ",Array.ConvertAll(all,Quote)).TrimEnd());
      stage="create-suspended-node";
      if(!CreateProcess(node,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT,IntPtr.Zero,cwd,ref startup,out pi))throw Win("Creating suspended build process failed");
      outsideChildUncertain=true;
      stage="assign-owned-job";
      if(!AssignProcessToJobObject(job,pi.hProcess)){
        bool terminated=TerminateProcess(pi.hProcess,126);uint wait=WaitForSingleObject(pi.hProcess,10000);uint childExit;
        outsideChildUncertain=!(terminated&&wait==WAIT_OBJECT_0&&GetExitCodeProcess(pi.hProcess,out childExit));
        throw Win("Assigning build process to its private job failed before resume");
      }
      outsideChildUncertain=false;
      stage="resume-owned-node";
      if(runtimeProtocol){
        Console.Out.WriteLine("QB_READY:"+nonce);Console.Out.Flush();stage="await-runtime-start-gate";
        bool resumed=false;
        while(!resumed){int gate=Control(nonce,true);
          if(gate==2){if(ResumeThread(pi.hThread)==0xffffffff)throw Win("Resuming private runtime supervisor failed");resumed=true;}
          else if(gate==1||gate<0){exit=StopJob(job,124);if(exit==-2||exit==-3)throw Win("Could not prove the gated runtime supervisor stopped");proof=true;return exit;}
          else if(gate!=0)throw Win("Unexpected command before runtime supervisor resume");
          if(WaitForSingleObject(pi.hProcess,0)==WAIT_OBJECT_0){uint early;if(!GetExitCodeProcess(pi.hProcess,out early))throw Win("Reading gated runtime process status failed");exit=(int)early;if(!WaitEmpty(job,10000))throw Win("Gated runtime exited without an empty owned job");proof=true;return exit;}
          Thread.Sleep(25);
        }
      }else{
        if(ResumeThread(pi.hThread)==0xffffffff){TerminateJobObject(job,126);if(!WaitEmpty(job,10000))throw Win("Could not observe suspended build process termination");throw Win("Resuming private build process failed");}
        Console.Out.WriteLine("QB_READY:"+nonce);Console.Out.Flush();
      }
      stage="monitor-owned-job";
      bool stop=false;
      while(true){
        Pump(outRead,logHandle,ref logged);Pump(errRead,logHandle,ref logged);
        int control=Control(nonce,runtimeProtocol);
        if(control==1||control<0){stop=true;exit=124;}
        else if(runtimeProtocol&&control==2){stop=true;exit=124;}
        else if(control!=0){stop=true;exit=124;}
        if(stop){exit=StopJob(job,124);if(exit==-2||exit==-3)throw Win("Could not confirm private build job termination");Pump(outRead,logHandle,ref logged);Pump(errRead,logHandle,ref logged);proof=true;break;}
        uint wait=WaitForSingleObject(pi.hProcess,100);
        if(wait==WAIT_OBJECT_0){uint childExit;if(!GetExitCodeProcess(pi.hProcess,out childExit))throw Win("Reading build exit status failed");exit=(int)childExit;
          if(!WaitEmpty(job,1000)){exit=StopJob(job,125);if(exit==-2||exit==-3)throw Win("Build descendants remained and job termination was not observed");}
          Pump(outRead,logHandle,ref logged);Pump(errRead,logHandle,ref logged);
          proof=true;break;
        }
        if(wait!=WAIT_TIMEOUT)throw Win("Waiting for private build process failed");
      }
      return exit;
    }catch(Exception e){Console.Error.WriteLine("Private build runner failed at "+stage+": "+e.Message);if(job!=IntPtr.Zero){try{TerminateJobObject(job,127);}catch{}if(WaitEmpty(job,10000)&&!outsideChildUncertain)proof=true;}exit=127;return exit;}
    finally{
      if(pi.hProcess!=IntPtr.Zero)CloseHandle(pi.hProcess);if(pi.hThread!=IntPtr.Zero)CloseHandle(pi.hThread);
      if(attributes!=IntPtr.Zero){try{DeleteProcThreadAttributeList(attributes);}catch{}Marshal.FreeHGlobal(attributes);}if(handleList!=IntPtr.Zero)Marshal.FreeHGlobal(handleList);
      if(outWrite!=IntPtr.Zero)CloseHandle(outWrite);if(errWrite!=IntPtr.Zero)CloseHandle(errWrite);
      if(outRead!=IntPtr.Zero&&logHandle!=IntPtr.Zero&&logHandle!=new IntPtr(-1)){try{Pump(outRead,logHandle,ref logged);}catch{proof=false;}}
      if(errRead!=IntPtr.Zero&&logHandle!=IntPtr.Zero&&logHandle!=new IntPtr(-1)){try{Pump(errRead,logHandle,ref logged);}catch{proof=false;}}
      if(outRead!=IntPtr.Zero)CloseHandle(outRead);if(errRead!=IntPtr.Zero)CloseHandle(errRead);
      if(logHandle!=IntPtr.Zero&&logHandle!=new IntPtr(-1))CloseHandle(logHandle);if(nullHandle!=IntPtr.Zero&&nullHandle!=new IntPtr(-1))CloseHandle(nullHandle);
      if(inputRead!=IntPtr.Zero&&inputRead!=nullHandle)CloseHandle(inputRead);
      if(job!=IntPtr.Zero){uint active;if(Active(job,out active)&&active==0&&!outsideChildUncertain)proof=true;CloseHandle(job);}
      if(proof)Console.Out.WriteLine("QB_EXIT:"+nonce+":"+exit+":EMPTY");else Console.Out.WriteLine("QB_EXIT:"+nonce+":UNKNOWN");Console.Out.Flush();
    }
  }
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
}
'@
$commandArguments = [System.Collections.Generic.List[string]]::new()
if ($ArgumentsJson) {
  $parsedArguments = ConvertFrom-Json -NoEnumerate -InputObject $ArgumentsJson
  if ($parsedArguments -isnot [array]) { throw 'Fixed build arguments must be a JSON array' }
  foreach ($argument in $parsedArguments) {
    if ($argument -isnot [string]) { throw 'Fixed build arguments must be text' }
    $commandArguments.Add($argument)
  }
}
$exitCode = [QbBuildJob]::Run($RunnerNonce,$NodeExe,$WorkingDirectory,$ScriptPath,$commandArguments.ToArray(),$LogPath,[bool]$RuntimeProtocol)
exit $exitCode
