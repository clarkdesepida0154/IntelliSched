# IntelliSched deployment kit: shared helpers, dot-sourced by every kit script.
# Windows PowerShell 5.1 syntax only (no ??, no ternary, no && / ||). ASCII only.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:DefaultRoot = 'C:\IntelliSched'
$script:LogFile = $null
$script:Results = New-Object System.Collections.ArrayList
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:EnDash = [string][char]0x2013

# Runs a native program (inside the script block) with its error output captured as text. In Windows
# PowerShell 5.1 a redirected stderr line would otherwise stop the script under ErrorActionPreference
# Stop. Returns the output lines; $LASTEXITCODE is the program's exit code.
function Invoke-Native([scriptblock]$Block) {
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return @(& $Block 2>&1 | ForEach-Object { [string]$_ }) } finally { $ErrorActionPreference = $eap }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

function Start-KitLog([string]$Folder, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Folder)) { New-Item -ItemType Directory -Force -Path $Folder | Out-Null }
    $stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
    $script:LogFile = Join-Path $Folder ($Name + '_' + $stamp + '.log')
    # Phase 12.2: two starts in the same second (two icon clicks) each get their own file.
    try {
        $fs = New-Object System.IO.FileStream($script:LogFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        $fs.Close()
    } catch {
        $script:LogFile = Join-Path $Folder ($Name + '_' + $stamp + '_' + $PID + '.log')
        [System.IO.File]::WriteAllText($script:LogFile, '', $script:Utf8NoBom)
    }
    Write-Log ('IntelliSched ' + $Name + ' started ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' on ' + $env:COMPUTERNAME)
}

# Moves the log into another folder (the kit's folder before the install exists, C:\IntelliSched\logs after).
function Move-KitLog([string]$Folder) {
    if (-not $script:LogFile) { return }
    if (-not (Test-Path -LiteralPath $Folder)) { New-Item -ItemType Directory -Force -Path $Folder | Out-Null }
    $target = Join-Path $Folder (Split-Path -Leaf $script:LogFile)
    if ($target -ne $script:LogFile) {
        Copy-Item -LiteralPath $script:LogFile -Destination $target -Force
        Remove-Item -LiteralPath $script:LogFile -Force -ErrorAction SilentlyContinue
        $script:LogFile = $target
    }
}

function Write-Log([string]$Message, [string]$Color = '') {
    $line = (Get-Date -Format 'HH:mm:ss') + '  ' + $Message
    if ($Color) { Write-Host $Message -ForegroundColor $Color } else { Write-Host $Message }
    if ($script:LogFile) { [System.IO.File]::AppendAllText($script:LogFile, $line + "`r`n", $script:Utf8NoBom) }
}

# One result line: PASS, WARN or FAIL.
function Add-Result([string]$Status, [string]$Name, [string]$Detail = '') {
    [void]$script:Results.Add([pscustomobject]@{ Status = $Status; Name = $Name; Detail = $Detail })
    $color = 'Green'
    if ($Status -eq 'WARN') { $color = 'Yellow' }
    if ($Status -eq 'FAIL') { $color = 'Red' }
    $text = $Status.PadRight(5) + $Name
    if ($Detail) { $text = $text + ' - ' + $Detail }
    Write-Log $text $color
}

function Show-Summary([string]$What) {
    $fails = @($script:Results | Where-Object { $_.Status -eq 'FAIL' })
    $warns = @($script:Results | Where-Object { $_.Status -eq 'WARN' })
    Write-Log ''
    if ($fails.Count -eq 0) {
        Write-Log ($What + ': PASS (' + $warns.Count + ' warning(s))') 'Green'
    } else {
        Write-Log ($What + ': FAIL') 'Red'
        foreach ($f in $fails) { Write-Log ('  - ' + $f.Name + ': ' + $f.Detail) 'Red' }
    }
    if ($script:LogFile) { Write-Log ('The log is ' + $script:LogFile) }
    return ($fails.Count -eq 0)
}

function Test-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Phase 12.2 (decision 3): IntelliSched never runs elevated. Edge started from an elevated process
# relaunches itself de-elevated and writes no PDF, so an elevated installer, updater or icon starts
# IntelliSched through a ONE-SHOT scheduled task for the daily user (LogonType Interactive, RunLevel
# Limited: the daily user's normal, non-elevated token in the session at the screen). The task runs
# start.ps1 once and is deleted right after. INTELLISCHED_FORCE_DAILY_TASK=1 makes a non-elevated
# caller use the task too (the tests prove the path that way).

# Phase 12.2: the owner and the elevation of a running process, e.g. 'PC\user, not elevated'. The
# token's elevation and integrity level (High = elevated) are read with the Windows API; a process
# this account may not open (a service) says so.
function Get-ProcessRunsAs([int]$Id) {
    if (-not ('IntelliSchedTokenInfo' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IntelliSchedTokenInfo {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr h, uint a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t, int c, IntPtr i, int l, out int r);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint n);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static int Elevation(int pid, out int integrity) {
    integrity = 0;
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return -1;
    IntPtr t;
    if (!OpenProcessToken(p, 0x0008, out t)) { CloseHandle(p); return -1; }
    IntPtr buf = Marshal.AllocHGlobal(256); int r; int res = -1;
    if (GetTokenInformation(t, 20, buf, 4, out r)) res = Marshal.ReadInt32(buf) != 0 ? 1 : 0;
    if (GetTokenInformation(t, 25, buf, 256, out r)) {
      IntPtr sid = Marshal.ReadIntPtr(buf);
      int cnt = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
      integrity = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(cnt - 1)));
    }
    Marshal.FreeHGlobal(buf); CloseHandle(t); CloseHandle(p);
    return res;
  }
}
'@
    }
    $owner = $null
    try {
        $cim = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Id)
        $o = Invoke-CimMethod -InputObject $cim -MethodName GetOwner
        if ($o.User) { $owner = $o.Domain + '\' + $o.User }
    } catch { }
    $integrity = 0
    $e = [IntelliSchedTokenInfo]::Elevation($Id, [ref]$integrity)
    $elev = 'elevation unknown (not readable from this account)'
    if ($e -eq 1 -or $integrity -ge 0x3000) { $elev = 'ELEVATED (administrator)' }
    elseif ($e -eq 0) { $elev = 'not elevated' }
    return [pscustomobject]@{ Owner = $owner; Elevated = ($e -eq 1 -or $integrity -ge 0x3000); Known = ($e -ge 0); Text = ($(if ($owner) { $owner } else { 'owner unknown' }) + ', ' + $elev) }
}

# The account signed in at this PC's screen, or $null when nobody is.
function Get-ConsoleUser {
    try { $u = (Get-CimInstance Win32_ComputerSystem).UserName; if ($u) { return [string]$u } } catch { }
    return $null
}

function Test-SameAccount([string]$A, [string]$B) {
    if (-not $A -or -not $B) { return $false }
    if ($A -ieq $B) { return $true }
    try {
        $sa = (New-Object Security.Principal.NTAccount($A)).Translate([Security.Principal.SecurityIdentifier]).Value
        $sb = (New-Object Security.Principal.NTAccount($B)).Translate([Security.Principal.SecurityIdentifier]).Value
        return ($sa -eq $sb)
    } catch { return $false }
}

# Runs start.ps1 once as the daily user, non-elevated. Returns 'started', 'failed' or 'not-signed-in'.
function Start-ViaDailyUserTask([string]$Root, [string]$DailyUser, [switch]$Open) {
    $console = Get-ConsoleUser
    if (-not (Test-SameAccount $console $DailyUser)) {
        Write-Log ('The daily user ' + $DailyUser + ' is not signed in at this screen' + $(if ($console) { ' (' + $console + ' is)' } else { '' }) + ', so IntelliSched was not started.') 'Yellow'
        return 'not-signed-in'
    }
    $name = 'IntelliSched-start-once-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $startPs = Join-Path $Root 'scripts\start.ps1'
    $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $startPs + '" -Root "' + $Root + '" -Quiet'
    if ($Open) { $arg = $arg + ' -Open' }
    $result = 'failed'
    try {
        $action = New-ScheduledTaskAction -Execute $ps -Argument $arg -WorkingDirectory $Root
        $principal = New-ScheduledTaskPrincipal -UserId $DailyUser -LogonType Interactive -RunLevel Limited
        # Priority 4 = normal. A task's default (7) runs it and every process it starts below normal, with
        # low memory and I/O priority: under load their memory is trimmed and they starve (measured on
        # this laptop: a working set of 1.5-4 MB, the model and the PDF browser past every time limit).
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -Priority 4
        Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Description 'IntelliSched: starts IntelliSched once as the daily user (deleted right after).' -ErrorAction Stop | Out-Null
        $before = (Get-Date).AddSeconds(-2)
        Start-ScheduledTask -TaskName $name -ErrorAction Stop
        Write-Log ('Starting IntelliSched as ' + $DailyUser + ' (not as administrator), through a one-time task')
        # start.ps1 waits up to 45 s for the database and 90 s for the services (20 min while closing).
        $deadline = (Get-Date).AddMinutes(25)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 1
            $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
            if (-not $t) { break }
            $info = $t | Get-ScheduledTaskInfo
            if ($t.State -ne 'Running' -and $info.LastRunTime -ge $before -and $info.LastTaskResult -ne 267009) {
                if ($info.LastTaskResult -eq 0) { $result = 'started' } else { Write-Log ('start.ps1 ended with code ' + $info.LastTaskResult) 'Yellow' }
                break
            }
        }
    } catch {
        Write-Log ('The one-time start task failed: ' + $_.Exception.Message) 'Yellow'
    } finally {
        try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop } catch { }
    }
    return $result
}

# Starts IntelliSched as the daily user: through the one-time task when this process is elevated (or
# the tests ask for it), else start.ps1 directly. Returns 'started', 'failed' or 'not-signed-in'.
function Start-IntelliSched([string]$Root, [string]$DailyUser, [switch]$Open) {
    if ((Test-Elevated) -or $env:INTELLISCHED_FORCE_DAILY_TASK -eq '1') {
        return (Start-ViaDailyUserTask $Root $DailyUser -Open:$Open)
    }
    & (Join-Path $Root 'scripts\start.ps1') -Root $Root -Quiet -Open:$Open | Out-Null
    if ($LASTEXITCODE -eq 0) { return 'started' }
    return 'failed'
}

# Removes the "downloaded from the internet" mark from the kit's own files.
function Unblock-KitFiles([string]$Folder) {
    try {
        Get-ChildItem -LiteralPath $Folder -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
            try { Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue } catch { }
        }
    } catch { }
}

# A random secret of letters and digits from the system's cryptographic generator.
function New-Secret([int]$Length = 48) {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] ($Length * 2)
    $rng.GetBytes($bytes)
    $sb = New-Object System.Text.StringBuilder
    $i = 0
    while ($sb.Length -lt $Length) {
        $b = $bytes[$i % $bytes.Length]
        if ($b -lt (256 - (256 % $chars.Length))) { [void]$sb.Append($chars[$b % $chars.Length]) }
        $i++
        if ($i -ge $bytes.Length) { $rng.GetBytes($bytes); $i = 0 }
    }
    return $sb.ToString()
}

# The ports something already listens on (any address).
function Get-ListeningPorts {
    $props = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
    return @($props.GetActiveTcpListeners() | ForEach-Object { $_.Port })
}

function Find-FreePort([int]$From, [int]$To, [int[]]$Avoid = @()) {
    $busy = Get-ListeningPorts
    for ($p = $From; $p -le $To; $p++) {
        if (($busy -notcontains $p) -and ($Avoid -notcontains $p)) { return $p }
    }
    throw ('No free port between ' + $From + ' and ' + $To + '.')
}

function Read-EnvFile([string]$Path) {
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($line in [System.IO.File]::ReadAllLines($Path, $script:Utf8NoBom)) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $i = $line.IndexOf('=')
        $map[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1)
    }
    return $map
}

function Read-Json([string]$Path) {
    return ([System.IO.File]::ReadAllText($Path, $script:Utf8NoBom) | ConvertFrom-Json)
}

function Write-Json([string]$Path, $Object) {
    Write-Utf8NoBom $Path (($Object | ConvertTo-Json -Depth 8) + "`r`n")
}

# The antivirus message, named after the blocked file.
function Get-AvMessage([string]$File, [string]$Root) {
    return ('Your antivirus blocked ' + $File + '. Allow ' + $Root + ' in it, then run INSTALL.bat again.')
}

# The files a working install must have; a missing one right after extraction is almost always an
# antivirus quarantine. Returns the first missing file or $null.
function Find-MissingRuntimeFile([string]$Root) {
    $must = @(
        'runtime\node\node.exe',
        'runtime\python\python.exe',
        'runtime\mongodb\bin\mongod.exe',
        'app\server\src\app.js',
        'app\backend\main.py',
        'app\client\index.html'
    )
    foreach ($rel in $must) {
        $full = Join-Path $Root $rel
        if (-not (Test-Path -LiteralPath $full)) { return $full }
    }
    return $null
}

# Runs one of the kit's Node scripts with the private Node. Output goes to the log; the exit code is returned.
# A secret (the backup password) is passed on standard input as base64 of its UTF-8 bytes, never on the
# command line and never in a file.
function Invoke-KitNode([string]$Root, [string]$Script, [string[]]$Arguments = @(), [string]$Secret = $null) {
    $node = Join-Path $Root 'runtime\node\node.exe'
    $scriptPath = Join-Path $Root ('scripts\' + $Script)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $quoted = @('"' + $scriptPath + '"', '--root', ('"' + $Root + '"'))
    foreach ($a in $Arguments) { $quoted += ('"' + ($a -replace '"', '\"') + '"') }
    $psi.Arguments = ($quoted -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.StandardOutputEncoding = $script:Utf8NoBom
    $psi.StandardErrorEncoding = $script:Utf8NoBom
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $Root
    foreach ($k in @('NODE_OPTIONS', 'NODE_PATH')) { if ($psi.EnvironmentVariables.ContainsKey($k)) { $psi.EnvironmentVariables.Remove($k) } }
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    try {
        [void]$p.Start()
    } catch {
        throw (Get-AvMessage $node $Root)
    }
    if ($Secret) {
        # Raw ASCII bytes on the stream itself (the writer could add a byte-order mark).
        $b64 = [Convert]::ToBase64String($script:Utf8NoBom.GetBytes($Secret))
        $raw = [System.Text.Encoding]::ASCII.GetBytes($b64 + "`n")
        $p.StandardInput.BaseStream.Write($raw, 0, $raw.Length)
        $p.StandardInput.BaseStream.Flush()
    }
    $p.StandardInput.Close()
    $errTask = $p.StandardError.ReadToEndAsync()
    while (-not $p.StandardOutput.EndOfStream) {
        $line = $p.StandardOutput.ReadLine()
        if ($line -ne $null) { Write-Log ('    ' + $line) }
    }
    $p.WaitForExit()
    $err = $errTask.Result
    if ($err) { foreach ($l in ($err -split "`r?`n")) { if ($l.Trim()) { Write-Log ('    ' + $l) } } }
    return $p.ExitCode
}

# SecureString -> plain text, only for handing it to Invoke-KitNode.
function ConvertFrom-SecureText([System.Security.SecureString]$Secure) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# The Windows account signed in at the screen ("DOMAIN\name"), else the current account.
function Get-ScreenUser {
    try {
        $u = (Get-CimInstance Win32_ComputerSystem).UserName
        if ($u) { return $u }
    } catch { }
    return ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
}

# The Documents folder of an account: the current account's own; else the "Personal" folder in that
# user's loaded registry hive; else <profile path>\Documents.
function Get-UserDocuments([string]$Account) {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($Account -ieq $current) { return [Environment]::GetFolderPath('MyDocuments') }
    $sid = $null
    try { $sid = (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { }
    if ($sid) {
        $key = 'Registry::HKEY_USERS\' + $sid + '\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
        try {
            $raw = (Get-ItemProperty -LiteralPath $key -Name Personal -ErrorAction Stop).Personal
            if ($raw) {
                $profileDir = (Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid)).ProfileImagePath
                return ($raw -replace '%USERPROFILE%', $profileDir)
            }
        } catch { }
        try {
            $profileDir = (Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid) -ErrorAction Stop).ProfileImagePath
            if ($profileDir) { return (Join-Path $profileDir 'Documents') }
        } catch { }
    }
    return $null
}

# The checks INSTALL, UPDATE and CHECK share. $Mode: install | update | check.
function Invoke-Preflight([string]$Mode, [string]$Root, [switch]$Portable) {
    $os = Get-CimInstance Win32_OperatingSystem
    $build = [int]$os.BuildNumber
    $is64 = [Environment]::Is64BitOperatingSystem
    # Phase 12.1 (decision 7): 64-bit Windows 10 1809 (build 17763) or newer, or Windows 11. Windows 8
    # and 8.1 can't run MongoDB 7, Node 24 or current Edge (and Microsoft ended their support in 2023).
    $needs = 'It needs Windows 10 or 11 (64-bit).'
    if ($is64 -and $build -ge 17763) { Add-Result 'PASS' 'Windows' ($os.Caption + ' build ' + $build + ', 64-bit') }
    elseif ($build -lt 10240) {
        $old = 'This Windows'
        if ($build -ge 9600) { $old = 'Windows 8.1' } elseif ($build -ge 9200) { $old = 'Windows 8' } elseif ($build -ge 7600) { $old = 'Windows 7' }
        Add-Result 'FAIL' 'Windows' ($old + " can't run IntelliSched. " + $needs)
    }
    elseif (-not $is64) { Add-Result 'FAIL' 'Windows' ("32-bit Windows can't run IntelliSched. " + $needs) }
    else { Add-Result 'FAIL' 'Windows' ('This Windows 10 is too old (build ' + $build + '). Update Windows to version 1809 or newer.') }

    # Memory: 4 GB recommended, 2 GB minimum.
    $ramGb = [math]::Round(([double]$os.TotalVisibleMemorySize * 1KB) / 1GB, 1)
    if ($ramGb -ge 3.8) { Add-Result 'PASS' 'Memory' ($ramGb.ToString() + ' GB') }
    elseif ($ramGb -ge 1.8) { Add-Result 'WARN' 'Memory' ($ramGb.ToString() + ' GB. Under 4 GB RAM: close other programs while generating.') }
    else { Add-Result 'FAIL' 'Memory' ('Only ' + $ramGb + ' GB. IntelliSched needs at least 2 GB of memory (4 GB recommended).') }

    if ($Portable) { Add-Result 'PASS' 'Administrator' 'not needed for the portable test install' }
    elseif (Test-Elevated) { Add-Result 'PASS' 'Administrator' 'running as administrator' }
    elseif ($Mode -eq 'check') { Add-Result 'WARN' 'Administrator' 'not running as administrator (INSTALL, UPDATE and UNINSTALL need it)' }
    else { Add-Result 'FAIL' 'Administrator' 'Right-click and choose Run as administrator.' }

    $drive = (Split-Path -Qualifier $Root).TrimEnd(':')
    $free = (Get-PSDrive -Name $drive).Free
    $gb = [math]::Round($free / 1GB, 1)
    if ($free -ge 3GB) { Add-Result 'PASS' 'Disk space' ($gb.ToString() + ' GB free on ' + $drive + ':') }
    elseif ($Mode -eq 'check') { Add-Result 'WARN' 'Disk space' ('Only ' + $gb + ' GB free on ' + $drive + ':. Backups need room: free some space.') }
    else { Add-Result 'FAIL' 'Disk space' ('Only ' + $gb + ' GB free on ' + $drive + ':. Free at least 3 GB, then try again.') }

    $ps = $PSVersionTable.PSVersion
    if ($ps.Major -ge 5 -and ($ps.Major -gt 5 -or $ps.Minor -ge 1)) { Add-Result 'PASS' 'PowerShell' $ps.ToString() }
    else { Add-Result 'FAIL' 'PowerShell' ('PowerShell 5.1 or newer is needed; this PC has ' + $ps) }

    $installed = Test-Path -LiteralPath (Join-Path $Root 'install-manifest.json')
    if ($Mode -eq 'install') {
        if ($installed) { Add-Result 'FAIL' 'Not installed yet' 'Already installed. Use UPDATE.bat, or UNINSTALL.bat first.' }
        else { Add-Result 'PASS' 'Not installed yet' $Root }
    } elseif ($Mode -eq 'update') {
        if ($installed) { Add-Result 'PASS' 'Installed' $Root }
        else { Add-Result 'FAIL' 'Installed' 'IntelliSched is not installed on this PC. Use INSTALL.bat.' }
    } else {
        if ($installed) { Add-Result 'PASS' 'Installed' $Root } else { Add-Result 'WARN' 'Installed' 'IntelliSched is not installed on this PC' }
    }

    $pending = $false
    foreach ($k in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
                     'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')) {
        if (Test-Path $k) { $pending = $true }
    }
    if ($pending) { Add-Result 'WARN' 'Pending restart' 'Windows is waiting for a restart. Restarting first is safer.' }
    else { Add-Result 'PASS' 'Pending restart' 'none' }

    $browser = Find-PdfBrowser
    if ($browser) { Add-Result 'PASS' 'Edge or Chrome' $browser }
    else { Add-Result 'WARN' 'Edge or Chrome' 'Neither Edge nor Chrome was found: PDF export will not work; Word export will.' }

    $cfa = $null
    try { $cfa = (Get-MpPreference -ErrorAction Stop).EnableControlledFolderAccess } catch { }
    if ($cfa -eq 1) { Add-Result 'WARN' 'Controlled Folder Access' 'is ON: Windows may block backups into Documents. Allow C:\IntelliSched\runtime\node\node.exe in Windows Security if a backup fails.' }
    else { Add-Result 'PASS' 'Controlled Folder Access' 'off' }
}

function Find-PdfBrowser {
    $bases = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA) | Where-Object { $_ }
    foreach ($b in $bases) {
        foreach ($rel in @('Microsoft\Edge\Application\msedge.exe', 'Google\Chrome\Application\chrome.exe')) {
            $p = Join-Path $b $rel
            if (Test-Path -LiteralPath $p) { return $p }
        }
    }
    return $null
}

# Copies a folder with robocopy: exit codes 0-7 are success, 8 and above failure.
function Copy-Tree([string]$From, [string]$To, [string[]]$Extra = @()) {
    if (-not (Test-Path -LiteralPath $To)) { New-Item -ItemType Directory -Force -Path $To | Out-Null }
    $rcArgs = @($From, $To, '/E', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') + $Extra
    & robocopy.exe @rcArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw ('Copying ' + $From + ' to ' + $To + ' failed (robocopy ' + $LASTEXITCODE + ').') }
}

# Extracts a zip with Windows' tar.exe; falls back to Expand-Archive.
function Expand-Payload([string]$Zip, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Destination)) { New-Item -ItemType Directory -Force -Path $Destination | Out-Null }
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    $ok = $false
    if (Test-Path -LiteralPath $tar) {
        $here = Get-Location
        try {
            Set-Location -LiteralPath (Split-Path -Parent $Zip)
            $null = Invoke-Native { & $tar -xf (Split-Path -Leaf $Zip) -C $Destination }
            $ok = ($LASTEXITCODE -eq 0)
        } catch { $ok = $false } finally { Set-Location $here }
        if ($ok) { Write-Log '  extracted with tar.exe' }
    }
    if (-not $ok) {
        Write-Log '  tar.exe could not extract it; using Expand-Archive (slower)'
        Expand-Archive -LiteralPath $Zip -DestinationPath $Destination -Force
    }
}

# Gateway health: $true when /api/health answers.
function Test-GatewayHealth([int]$Port) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $Port + '/api/health') -TimeoutSec 5
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Get-GatewayHealth([int]$Port) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $Port + '/api/health') -TimeoutSec 8
        return ($r.Content | ConvertFrom-Json)
    } catch { return $null }
}

# The processes of this install: their executable lies under $Root (never another node.exe or python.exe).
function Get-InstallProcesses([string]$Root) {
    $prefix = ([System.IO.Path]::GetFullPath($Root)).TrimEnd('\') + '\'
    $names = @('node.exe', 'python.exe', 'mongod.exe')
    return @(Get-CimInstance Win32_Process | Where-Object {
        ($names -contains $_.Name) -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
}

# Phase 12.1 (decision 4): the shortcuts (install and update make the same set). No task at log on:
# IntelliSched starts only from these icons. "Stop IntelliSched" closes it at once (backup first when
# anything changed).
function Get-KitShortcuts([string]$Root, [string]$Desktop, [string]$Menu) {
    $startArgs = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'scripts\start.ps1') + '" -Open'
    return @(
        @{ Path = (Join-Path $Desktop 'IntelliSched.lnk'); Args = $startArgs; Style = 7 },
        @{ Path = (Join-Path $Menu 'IntelliSched.lnk'); Args = $startArgs; Style = 7 },
        @{ Path = (Join-Path $Menu ('IntelliSched ' + $script:EnDash + ' Check.lnk')); Args = ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'scripts\check.ps1') + '" -Pause'); Style = 1 },
        @{ Path = (Join-Path $Menu 'Stop IntelliSched.lnk'); Args = ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'scripts\stop.ps1') + '" -Database -Notify'); Style = 7 }
    )
}

# Phase 12.1 (decision 3): a Practice kit never holds a handover, training or passwords file.
function Assert-NoHandover([string]$Folder) {
    $found = @(Get-ChildItem -LiteralPath $Folder -Recurse -File | Where-Object { $_.Name -match '^handover' -or $_.Name -match 'OFFICE-PASSWORDS' })
    if ($found.Count) { throw ('Refused: a Practice kit must never hold a handover or training file (' + (($found | ForEach-Object { $_.Name }) -join ', ') + ').') }
}
