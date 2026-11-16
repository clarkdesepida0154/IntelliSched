# IntelliSched: stops the supervisor and its two services (decision 6). Only processes whose program
# lies under the install folder are touched; any other node.exe or python.exe is left alone.
#   stop.ps1 [-Root <install folder>] [-Database] [-NoBackup] [-KeepDatabase] [-DatabaseOnly] [-Notify] [-Quiet]
# Phase 12.1 (decision 4): "Stop IntelliSched" (the Start menu, with -Database -Notify) closes it at
# once the way the idle shutdown does: the supervisor stops the services, makes the closing backup when
# data changed since the last backup, and stops the database. -NoBackup skips that backup and
# -KeepDatabase leaves the database running (the updater, which makes its own backup).
# -Database also stops the database when no supervisor runs: the Windows service (the daily user may),
# or the portable mongod. -DatabaseOnly stops only the database (the supervisor's last step).
param(
    [string]$Root = '',
    [switch]$Database,
    [switch]$NoBackup,
    [switch]$KeepDatabase,
    [switch]$DatabaseOnly,
    [switch]$Notify,
    [switch]$Quiet
)
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
Start-KitLog (Join-Path $Root 'logs') 'stop'
$m = $null
if (Test-Path -LiteralPath (Join-Path $Root 'install-manifest.json')) { $m = Read-Json (Join-Path $Root 'install-manifest.json') }
$run = Join-Path $Root 'run'

function Stop-Database {
    if ($m -and -not $m.portable -and $m.service) {
        $svc = Get-Service -Name $m.service -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') {
            try { Stop-Service -Name $m.service -Force -ErrorAction Stop; Write-Log 'Stopped the database service' }
            catch { Write-Log ('The database service could not be stopped: ' + $_.Exception.Message) 'Yellow' }
        }
    } else {
        foreach ($p in (Get-InstallProcesses $Root | Where-Object { $_.Name -eq 'mongod.exe' })) {
            try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Log ('Stopped the database (pid ' + $p.ProcessId + ')') } catch { }
        }
        Remove-Item -LiteralPath (Join-Path $run 'mongod.pid') -Force -ErrorAction SilentlyContinue
    }
}

if ($DatabaseOnly) { Stop-Database; exit 0 }

# Ask the supervisor to close IntelliSched, then wait while it backs up (a large readable copy can take
# a few minutes).
$pidFile = Join-Path $run 'supervisor.pid'
$supervised = $false
if (Test-Path -LiteralPath $pidFile) {
    $supPid = 0
    try { $supPid = [int]([System.IO.File]::ReadAllText($pidFile).Trim()) } catch { }
    if ($supPid -and (Get-InstallProcesses $Root | Where-Object { $_.ProcessId -eq $supPid })) {
        $supervised = $true
        $words = @('stop')
        if ($NoBackup) { $words += 'nobackup' }
        if ($KeepDatabase) { $words += 'keepdb' }
        Write-Utf8NoBom (Join-Path $run 'stop.request') ($words -join ' ')
        if (-not $NoBackup) { Write-Log 'Closing IntelliSched (with the closing backup if anything changed)...' }
        $deadline = (Get-Date).AddMinutes(20)
        # (Phase 12.2: until the file goes, or the supervisor itself is gone - a killed one leaves it.)
        while ((Test-Path -LiteralPath $pidFile) -and ((Get-Date) -lt $deadline)) {
            Start-Sleep -Milliseconds 500
            if (-not (Get-Process -Id $supPid -ErrorAction SilentlyContinue)) { break }
        }
    }
}

# Whatever of this install still runs (never mongod here).
foreach ($p in (Get-InstallProcesses $Root | Where-Object { $_.Name -ne 'mongod.exe' })) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Log ('Stopped ' + $p.Name + ' (pid ' + $p.ProcessId + ')') } catch { }
}
Remove-Item -LiteralPath (Join-Path $run 'stop.request'), $pidFile -Force -ErrorAction SilentlyContinue
# Phase 12.2: a PDF browser the gateway left behind (its profile is this install's run\browser-profile).
$profileDir = Join-Path $run 'browser-profile'
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { ("" + $_.CommandLine).IndexOf($profileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 })) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Log ('Stopped the PDF browser ' + $p.Name + ' (pid ' + $p.ProcessId + ')') } catch { }
}

if ($Database -and -not $KeepDatabase) { Stop-Database }

$still = @(Get-InstallProcesses $Root | Where-Object { ($Database -and -not $KeepDatabase) -or $_.Name -ne 'mongod.exe' })
$ok = ($still.Count -eq 0)
if ($ok) { Write-Log 'IntelliSched is stopped.' 'Green' }
else { Write-Log ('Still running: ' + (($still | ForEach-Object { $_.Name + ' ' + $_.ProcessId }) -join ', ')) 'Red' }
if ($Notify -and -not $Quiet) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        if ($ok) { $text = 'IntelliSched is closed. It was backed up if anything changed.' }
        else { $text = "IntelliSched could not be closed completely. Run 'IntelliSched " + $script:EnDash + " Check' and send the report." }
        [void][System.Windows.Forms.MessageBox]::Show($text, 'IntelliSched', 'OK', 'Information')
    } catch { }
}
if ($ok) { exit 0 }
exit 1
