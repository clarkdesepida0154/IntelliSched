# IntelliSched: UNINSTALL.bat (Phase 12, decision 7). Removes exactly what install-manifest.json lists:
# the scheduled task, the shortcuts, the database service, and the install folder. The backups in
# Documents stay unless DELETE BACKUPS is typed. The Visual C++ runtime stays (other programs share it).
#   uninstall.ps1 [-Portable -Root <folder>] [-Yes] [-DeleteBackups]
# -Yes and -DeleteBackups answer the two questions (the portable tests only).
param(
    [switch]$Portable,
    [string]$Root = '',
    [switch]$Yes,
    [switch]$DeleteBackups
)
. (Join-Path $PSScriptRoot 'common.ps1')
$Kit = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Root) { $Root = $script:DefaultRoot }
if (($Yes -or $DeleteBackups) -and -not $Portable) { Write-Host '-Yes and -DeleteBackups are for the portable tests only.'; exit 2 }
Unblock-KitFiles $Kit
$logDir = Join-Path $Kit 'logs'
if ($Kit.StartsWith(([System.IO.Path]::GetFullPath($Root)).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $logDir = Join-Path $env:TEMP 'IntelliSched-logs' }
Start-KitLog $logDir 'uninstall'

if (-not $Portable -and -not (Test-Elevated)) { Add-Result 'FAIL' 'Administrator' 'Right-click and choose Run as administrator.'; [void](Show-Summary 'UNINSTALL'); exit 1 }
$manifestFile = Join-Path $Root 'install-manifest.json'
if (-not (Test-Path -LiteralPath $manifestFile)) {
    if (Test-Path -LiteralPath $Root) { Add-Result 'FAIL' 'Install record' ($Root + ' has no install-manifest.json, so it was not made by INSTALL.bat. Nothing was removed.') }
    else { Add-Result 'PASS' 'Install record' 'IntelliSched is not installed on this PC; nothing to remove.' }
    [void](Show-Summary 'UNINSTALL'); exit 0
}
$m = Read-Json $manifestFile
if ([bool]$m.portable -ne [bool]$Portable) { Add-Result 'FAIL' 'Install record' 'This install was made in the other mode (portable or not). Nothing was removed.'; [void](Show-Summary 'UNINSTALL'); exit 1 }

if (-not $Yes) {
    $a = Read-Host 'Type REMOVE to uninstall IntelliSched from this computer'
    if ($a -cne 'REMOVE') { Write-Log 'Nothing was removed.'; exit 0 }
}
$dropBackups = [bool]$DeleteBackups
if (-not $Portable) {
    Write-Host ('The backups in ' + $m.backupFolder + ' are KEPT unless you type DELETE BACKUPS.')
    $b = Read-Host 'Press Enter to keep them, or type DELETE BACKUPS'
    $dropBackups = ($b -ceq 'DELETE BACKUPS')
}

# 1. Stop everything of this install (the database too).
$stop = Join-Path $Root 'scripts\stop.ps1'
if (Test-Path -LiteralPath $stop) { & $stop -Root $Root -Database -Quiet | Out-Null }
foreach ($p in (Get-InstallProcesses $Root)) { try { Stop-Process -Id $p.ProcessId -Force } catch { } }

# 2. The task, the shortcuts, the service.
if ($m.task) {
    try { Unregister-ScheduledTask -TaskName $m.task -Confirm:$false -ErrorAction Stop; Write-Log ('Removed the scheduled task ' + $m.task) } catch { Write-Log ('The scheduled task ' + $m.task + ' was not found') }
}
foreach ($s in @($m.shortcuts)) {
    if ($s -and (Test-Path -LiteralPath $s)) { Remove-Item -LiteralPath $s -Force; Write-Log ('Removed ' + $s) }
}
if ($m.service) {
    $svc = Get-Service -Name $m.service -ErrorAction SilentlyContinue
    if ($svc) {
        if ($svc.Status -ne 'Stopped') { Stop-Service -Name $m.service -Force -ErrorAction SilentlyContinue }
        $mongod = Join-Path $Root 'runtime\mongodb\bin\mongod.exe'
        if (Test-Path -LiteralPath $mongod) { $null = Invoke-Native { & $mongod --remove --serviceName $m.service } }
        if (Get-Service -Name $m.service -ErrorAction SilentlyContinue) { & sc.exe delete $m.service | Out-Null }
        Write-Log ('Removed the service ' + $m.service)
    }
}

# 3. The folders the installer made (the install folder last).
$backupFolder = $m.backupFolder
foreach ($f in @($m.folders | Sort-Object { $_.Length } -Descending)) {
    if (-not $f -or -not (Test-Path -LiteralPath $f)) { continue }
    Start-Sleep -Milliseconds 500
    $null = Invoke-Native { & icacls.exe $f /reset /T /C /Q }
    # A program that was just stopped can hold its files for a few seconds: try for up to 30 s.
    for ($i = 0; $i -lt 15; $i++) {
        try { Remove-Item -LiteralPath $f -Recurse -Force -ErrorAction Stop } catch { }
        if (-not (Test-Path -LiteralPath $f)) { break }
        Start-Sleep -Seconds 2
    }
    Write-Log ('Removed ' + $f)
}
if ($dropBackups -and $backupFolder -and (Test-Path -LiteralPath $backupFolder)) {
    Remove-Item -LiteralPath $backupFolder -Recurse -Force
    Write-Log ('Deleted the backups in ' + $backupFolder)
} elseif ($backupFolder) {
    Write-Log ('The backups were kept in ' + $backupFolder)
}

# 4. The check: nothing of the install is left.
if ($m.service) {
    if (Get-Service -Name $m.service -ErrorAction SilentlyContinue) { Add-Result 'FAIL' 'Service removed' $m.service } else { Add-Result 'PASS' 'Service removed' $m.service }
}
if ($m.task) {
    if (Get-ScheduledTask -TaskName $m.task -ErrorAction SilentlyContinue) { Add-Result 'FAIL' 'Task removed' $m.task } else { Add-Result 'PASS' 'Task removed' $m.task }
}
$leftLinks = @(@($m.shortcuts) | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
if ($leftLinks.Count) { Add-Result 'FAIL' 'Shortcuts removed' ($leftLinks -join ', ') } else { Add-Result 'PASS' 'Shortcuts removed' ([string]@($m.shortcuts).Count + ' shortcut(s)') }
$leftDirs = @(@($m.folders) | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
if ($leftDirs.Count) { Add-Result 'FAIL' 'Folders removed' ($leftDirs -join ', ') } else { Add-Result 'PASS' 'Folders removed' (@($m.folders) -join ', ') }
$leftProcs = @(Get-InstallProcesses $Root)
if ($leftProcs.Count) { Add-Result 'FAIL' 'Processes stopped' ([string]$leftProcs.Count + ' still running') } else { Add-Result 'PASS' 'Processes stopped' 'none left' }
$ok = Show-Summary 'UNINSTALL'
if ($ok) { exit 0 } else { exit 1 }
