# IntelliSched: CHECK.bat and the Start menu's "IntelliSched - Check" (Phase 12, decision 7).
# The install preflight, then (if installed) the service and task, the ports, both health routes, the
# last 50 lines of each log, the disk, and the last backup. Writes IntelliSched-Check_<computer>_<date>.txt
# to the Desktop with no secret, password or rating, the user folder shown as %USERPROFILE%.
#   check.ps1 [-Root <folder>] [-OutFolder <folder>] [-Pause]
param(
    [string]$Root = '',
    [string]$OutFolder = '',
    [switch]$Pause
)
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Root) {
    $here = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    if (Test-Path -LiteralPath (Join-Path $here 'install-manifest.json')) { $Root = $here } else { $Root = $script:DefaultRoot }
}
if (-not $OutFolder) { $OutFolder = [Environment]::GetFolderPath('Desktop') }
$Kit = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Unblock-KitFiles (Join-Path $Kit 'scripts')
if (Test-Path -LiteralPath (Join-Path $Root 'logs')) { Start-KitLog (Join-Path $Root 'logs') 'check' } else { Start-KitLog (Join-Path $env:TEMP 'IntelliSched-logs') 'check' }

$m = $null
if (Test-Path -LiteralPath (Join-Path $Root 'install-manifest.json')) { $m = Read-Json (Join-Path $Root 'install-manifest.json') }
Invoke-Preflight 'check' $Root -Portable:([bool]($m -and $m.portable))

# Everything secret in the settings files is replaced before anything is written.
$secrets = @()
foreach ($f in @('server.env', 'backend.env')) {
    try { foreach ($v in (Read-EnvFile (Join-Path $Root ('config\' + $f))).Values) { if ($v.Length -ge 12) { $secrets += $v } } } catch { }
}
function Hide([string]$Text) {
    if ($null -eq $Text) { return '' }
    foreach ($s in $secrets) { $Text = $Text.Replace($s, '<hidden>') }
    $Text = [regex]::Replace($Text, 'mongodb(\+srv)?://[^@\s/]+@', 'mongodb://<hidden>@')
    $Text = [regex]::Replace($Text, '(?i)(password|pwd|secret|api[_-]?key|token)(["'']?\s*[:=]\s*)["'']?[^\s"'',}]+', '$1$2<hidden>')
    $Text = [regex]::Replace($Text, '(?i)(evalScore|eval_rating|rating|average)(["'']?\s*[:=]\s*)[0-9.]+', '$1$2<hidden>')
    if ($env:USERPROFILE) { $Text = $Text.Replace($env:USERPROFILE, '%USERPROFILE%') }
    return $Text
}

$extra = @()
if ($m) {
    $extra += ('Version: ' + $m.version + '   Mode: ' + $m.mode + '   Installed: ' + $m.installedAt + $(if ($m.portable) { '   (portable test install)' } else { '' }))
    $extra += ('Installed for (the daily user): ' + $m.dailyUser)
    Add-Result 'PASS' 'Installed for' $m.dailyUser
    # Phase 12.1 (decision 4): IntelliSched runs only while it is used, so "not running" is normal.
    if (-not $m.portable) {
        $svc = Get-Service -Name $m.service -ErrorAction SilentlyContinue
        if ($svc) {
            $st = 'PASS'; if ("$($svc.StartType)" -ne 'Manual') { $st = 'WARN' }
            Add-Result $st 'Database service' ($m.service + ' ' + $svc.Status + ', starts ' + $svc.StartType + $(if ($st -eq 'WARN') { ' (should be Manual: run UPDATE.bat)' } else { ' (by IntelliSched)' }))
        } else { Add-Result 'FAIL' 'Database service' ($m.service + ' is missing. Run INSTALL.bat again after UNINSTALL.bat.') }
        $oldTask = Get-ScheduledTask -TaskName 'IntelliSched' -ErrorAction SilentlyContinue
        if ($oldTask) { Add-Result 'WARN' 'Task at log on' 'the old task still exists: run UPDATE.bat' } else { Add-Result 'PASS' 'Task at log on' 'none (starts from the icon)' }
    }
    $private = Join-Path $Root 'private'
    if ((Test-Path -LiteralPath $private) -and @(Get-ChildItem -LiteralPath $private -File -ErrorAction SilentlyContinue).Count) { Add-Result 'PASS' 'Retrain data' 'present' }
    else { Add-Result 'PASS' 'Retrain data' 'not present' }
    $listening = Get-ListeningPorts
    $running = $listening -contains [int]$m.ports.gateway
    if (-not $running) { Add-Result 'PASS' 'Running' 'not running now (it starts from the IntelliSched icon and closes itself when unused)' }
    foreach ($k in @('mongodb', 'gateway', 'python')) {
        $port = [int]$m.ports.$k
        if ($listening -contains $port) { Add-Result 'PASS' ('Port ' + $k) ([string]$port + ' listening') }
        elseif ($running) { Add-Result 'FAIL' ('Port ' + $k) ([string]$port + ' not listening while the web server runs') }
    }
    $h = $null
    if ($running) { $h = Get-GatewayHealth ([int]$m.ports.gateway) }
    if (-not $running) { }
    elseif ($h) {
        Add-Result $(if ($h.status -eq 'Operational') { 'PASS' } else { 'FAIL' }) 'Web server health' ($h.status + ', database ' + $h.services.mongo.status)
        Add-Result $(if ($h.services.python.status -eq 'Online') { 'PASS' } else { 'FAIL' }) 'Scheduling service health' $h.services.python.status
    } else { Add-Result 'FAIL' 'Web server health' 'no answer' }
    # Phase 12.2 (decision 3): who the running processes run as (never as administrator).
    if ($running) {
        if ($h -and $null -ne $h.elevated) {
            Add-Result $(if ($h.elevated -eq $false) { 'PASS' } else { 'FAIL' }) 'Web server elevation' $(if ($h.elevated -eq $false) { 'not elevated (its health route)' } else { 'runs as administrator: stop it, then start it from the desktop icon' })
        }
        foreach ($p in @(Get-InstallProcesses $Root | Where-Object { $_.Name -ne 'mongod.exe' -or $m.portable })) {
            $role = $p.Name
            if (("" + $p.CommandLine) -match 'supervisor\.js') { $role = 'supervisor' } elseif (("" + $p.CommandLine) -match 'app\.js') { $role = 'web server' } elseif ($p.Name -eq 'python.exe') { $role = 'scheduling service' } elseif ($p.Name -eq 'mongod.exe') { $role = 'database' }
            $ra = Get-ProcessRunsAs ([int]$p.ProcessId)
            $st = 'PASS'
            if ($ra.Elevated) { $st = 'FAIL' } elseif ($ra.Owner -and $m.dailyUser -and -not (Test-SameAccount $ra.Owner ([string]$m.dailyUser))) { $st = 'WARN' }
            Add-Result $st ('Runs as (' + $role + ')') ('pid ' + $p.ProcessId + ': ' + $ra.Text)
        }
    }
    if ($running) {
        try {
            $pyh = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $m.ports.python + '/api/health') -TimeoutSec 5
            Add-Result 'PASS' 'Python service health route' ('answers (' + $pyh.StatusCode + ')')
        } catch { Add-Result 'FAIL' 'Python service health route' 'no answer' }
    }

    # The last backup in the backup folder.
    $folder = $m.backupFolder
    if ($folder -and (Test-Path -LiteralPath $folder)) {
        $last = Get-ChildItem -LiteralPath $folder -Filter 'IntelliSched-backup_*.isbak' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($last) {
            $age = ((Get-Date) - $last.LastWriteTime).TotalDays
            $st = 'PASS'; if ($age -gt 3) { $st = 'WARN' }
            Add-Result $st 'Last backup' ($last.Name + ', ' + $last.LastWriteTime.ToString('yyyy-MM-dd HH:mm') + ', ' + [math]::Round($last.Length / 1KB) + ' KB')
        } else { Add-Result 'WARN' 'Last backup' 'no backup in the backup folder yet' }
    } else { Add-Result 'WARN' 'Last backup' 'the backup folder is missing' }
    $sup = Join-Path $Root 'logs\supervisor.log'
    if ((Test-Path -LiteralPath $sup) -and (Select-String -LiteralPath $sup -Pattern 'not starting it again' -Quiet)) {
        Add-Result 'WARN' 'Supervisor' 'a service stopped 5 times in 10 minutes at some point (see its log below)'
    }
}

# The report.
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$file = Join-Path $OutFolder ('IntelliSched-Check_' + $env:COMPUTERNAME + '_' + $stamp + '.txt')
$lines = @('IntelliSched check', ('Date: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')), ('Computer: ' + $env:COMPUTERNAME), ('Folder: ' + $Root)) + $extra + @('', 'Results:')
foreach ($r in $script:Results) { $lines += ('  ' + $r.Status.PadRight(5) + $r.Name + $(if ($r.Detail) { ' - ' + $r.Detail } else { '' })) }
if ($m) {
    foreach ($log in @('server.log', 'backend.log', 'supervisor.log', 'mongod.log')) {
        $p = Join-Path $Root ('logs\' + $log)
        $lines += ''
        $lines += ('----- last 50 lines of logs\' + $log + ' -----')
        if (Test-Path -LiteralPath $p) { $lines += @(Get-Content -LiteralPath $p -Tail 50 -Encoding UTF8 -ErrorAction SilentlyContinue) } else { $lines += '(no file)' }
    }
}
$text = Hide (($lines | ForEach-Object { [string]$_ }) -join "`r`n")
Write-Utf8NoBom $file ($text + "`r`n")
$ok = Show-Summary 'CHECK'
if ($OutFolder -eq [Environment]::GetFolderPath('Desktop')) { Write-Log ('The report is on the Desktop: ' + (Split-Path -Leaf $file)) 'Cyan' } else { Write-Log ('The report is ' + $file) 'Cyan' }
if ($Pause) { Read-Host 'Press Enter to close' | Out-Null }
if ($ok) { exit 0 } else { exit 1 }
