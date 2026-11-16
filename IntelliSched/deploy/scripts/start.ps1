# IntelliSched: starts the installed system (decision 6). Run by the desktop and Start-menu icons with
# -Open. Phase 12.1 (decision 4): there is no task at log on; IntelliSched runs only while it is used.
# A second click while it runs only opens the browser; a click while it is closing waits for that to
# finish; services left running by a killed supervisor are stopped and started again under a new one
# (whose lock file allows only one).
#   start.ps1 [-Open] [-Root <install folder>] [-Quiet]
# 1. the database runs; 2. the supervisor runs (hidden) unless the gateway already answers;
# 3. waits up to 90 s for the gateway and the Python service; 4. -Open opens the page in the default
# browser; 5. otherwise a small message box says what to do (-Quiet: no box, exit code 1).
param(
    [switch]$Open,
    [string]$Root = '',
    [switch]$Quiet
)
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$manifestFile = Join-Path $Root 'install-manifest.json'

function Show-StartFailure([string]$Text) {
    Write-Log $Text 'Red'
    if ($Quiet) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show($Text, 'IntelliSched', 'OK', 'Warning')
    } catch { }
}

Start-KitLog (Join-Path $Root 'logs') 'start'
if (-not (Test-Path -LiteralPath $manifestFile)) {
    Show-StartFailure 'IntelliSched is not installed on this computer.'
    exit 1
}
$m = Read-Json $manifestFile
$gwPort = [int]$m.ports.gateway
$pyPort = [int]$m.ports.python
$mongoPort = [int]$m.ports.mongodb
$checkName = 'IntelliSched ' + $script:EnDash + ' Check'
$failText = "IntelliSched could not start. Run '" + $checkName + "' and send the report."

$missing = Find-MissingRuntimeFile $Root
if ($missing) { Show-StartFailure (Get-AvMessage $missing $Root); exit 1 }

# Phase 12.2 (decision 3): never start the services elevated. Run as administrator (an installer, an
# updater, or "Run as administrator" on the icon), this script starts itself again as the daily user,
# non-elevated, through a one-time task, and does nothing else.
if (Test-Elevated) {
    Write-Log 'This was started as administrator; IntelliSched runs as the daily user instead' 'Yellow'
    $r = Start-ViaDailyUserTask $Root ([string]$m.dailyUser) -Open:$Open
    if ($r -eq 'started') { Write-Log ('IntelliSched is running on http://localhost:' + $gwPort + '/') 'Green'; exit 0 }
    if ($r -eq 'not-signed-in') { Show-StartFailure 'Open IntelliSched from the desktop icon to start it.'; exit 1 }
    Show-StartFailure $failText; exit 1
}
$dbFailText = "The database didn't start. Run " + $checkName + ' and send the report.'
$pidFile = Join-Path $Root 'run\supervisor.pid'
function Get-LiveSupervisor {
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    $old = 0
    try { $old = [int]([System.IO.File]::ReadAllText($pidFile).Trim()) } catch { return $null }
    return (Get-InstallProcesses $Root | Where-Object { $_.ProcessId -eq $old } | Select-Object -First 1)
}

# 0. IntelliSched is closing (the idle shutdown or Stop, with its closing backup): wait for it.
if ((Test-Path -LiteralPath (Join-Path $Root 'run\closing')) -and (Get-LiveSupervisor)) {
    Write-Log 'IntelliSched is closing; waiting for its closing backup to finish'
    $deadline = (Get-Date).AddMinutes(20)
    while ((Get-LiveSupervisor) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Seconds 1 }
}

# 1. The database.
if ($m.portable) {
    if ((Get-ListeningPorts) -notcontains $mongoPort) {
        $mongod = Join-Path $Root 'runtime\mongodb\bin\mongod.exe'
        $cfg = Join-Path $Root 'config\mongod.cfg'
        try {
            $p = Start-Process -FilePath $mongod -ArgumentList @('--config', ('"' + $cfg + '"')) -WindowStyle Hidden -PassThru
            Write-Utf8NoBom (Join-Path $Root 'run\mongod.pid') ([string]$p.Id)
            Write-Log ('Started the database (portable, pid ' + $p.Id + ')')
        } catch {
            Show-StartFailure (Get-AvMessage $mongod $Root); exit 1
        }
    }
} else {
    $svc = Get-Service -Name $m.service -ErrorAction SilentlyContinue
    if (-not $svc) { Show-StartFailure ('The database service ' + $m.service + ' is missing. ' + $failText); exit 1 }
    if ($svc.Status -ne 'Running') {
        try { Start-Service -Name $m.service; Write-Log 'Started the database service' }
        catch { Write-Log ('The database service could not be started: ' + $_.Exception.Message) 'Yellow' }
    }
}
$deadline = (Get-Date).AddSeconds(45)
while (((Get-ListeningPorts) -notcontains $mongoPort) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 500 }
if ((Get-ListeningPorts) -notcontains $mongoPort) {
    # A power cut leaves mongod.lock behind; MongoDB's journal recovers on its own, so this is rare.
    Show-StartFailure $dbFailText; exit 1
}

# 2. The supervisor, unless one of this install runs (its lock file allows only one). Services left
#    running without a supervisor (it was killed) are stopped first, so the new one owns them.
$supervisor = Get-LiveSupervisor
if (-not $supervisor) {
    # (A supervisor another click is starting this very moment is never touched: it sorts itself out by
    # its lock file.)
    $recent = (Get-Date).AddSeconds(-20)
    $orphans = @(Get-InstallProcesses $Root | Where-Object { $_.Name -ne 'mongod.exe' -and ("" + $_.CommandLine) -notmatch 'supervisor\.js' -and $_.CreationDate -lt $recent })
    foreach ($p in $orphans) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Log ('Stopped ' + $p.Name + ' left running without a supervisor (pid ' + $p.ProcessId + ')') } catch { }
    }
    $running = $false
    if (-not $running) {
        $node = Join-Path $Root 'runtime\node\node.exe'
        $sup = Join-Path $Root 'scripts\supervisor.js'
        try {
            $p = Start-Process -FilePath $node -ArgumentList @(('"' + $sup + '"'), '--root', ('"' + $Root + '"')) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
            Write-Log ('Started the supervisor (pid ' + $p.Id + ')')
        } catch {
            Show-StartFailure (Get-AvMessage $node $Root); exit 1
        }
    }
}

# 3. Up to 90 s for both services.
$deadline = (Get-Date).AddSeconds(90)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    $h = Get-GatewayHealth $gwPort
    if ($h -and $h.status -eq 'Operational' -and $h.services.python.status -eq 'Online') { $healthy = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $healthy) { Show-StartFailure $failText; exit 1 }
Write-Log ('IntelliSched is running on http://localhost:' + $gwPort + '/') 'Green'

# 4. The page.
if ($Open) { Start-Process ('http://localhost:' + $gwPort + '/') }
exit 0
