# IntelliSched: UPDATE.bat (Phase 12, decision 7), run from a NEWER kit. Keeps config\, data\, logs\
# and the System settings; makes a full backup first; puts the old version back if anything fails.
#   update.ps1 [-Portable -Root <folder>] [-NoBrowser]
param(
    [switch]$Portable,
    [string]$Root = '',
    [switch]$NoBrowser
)
. (Join-Path $PSScriptRoot 'common.ps1')
$Kit = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Root) { $Root = $script:DefaultRoot }
Unblock-KitFiles $Kit
if (Test-Path -LiteralPath (Join-Path $Root 'logs')) { Start-KitLog (Join-Path $Root 'logs') 'update' } else { Start-KitLog (Join-Path $Kit 'logs') 'update' }
$kitManifest = Read-Json (Join-Path $Kit 'kit-manifest.json')

# ---------------------------------------------------------------- 1. preflight
Invoke-Preflight 'update' $Root -Portable:$Portable
if (@($script:Results | Where-Object { $_.Status -eq 'FAIL' }).Count) { [void](Show-Summary 'UPDATE'); exit 1 }
$manifestFile = Join-Path $Root 'install-manifest.json'
$m = Read-Json $manifestFile
if ($m.version -eq $kitManifest.version) {
    Add-Result 'FAIL' 'Version' ('IntelliSched ' + $m.version + ' is already installed; this kit is the same version.')
    [void](Show-Summary 'UPDATE'); exit 1
}
Add-Result 'PASS' 'Version' ($m.version + ' -> ' + $kitManifest.version)

# ---------------------------------------------------------------- 2. stop, back up
# Phase 12.1: the kit's own stop.ps1 (it works with an older install's supervisor too): no closing
# backup (the update makes its own next) and the database keeps running for it.
$kitStop = Join-Path $PSScriptRoot 'stop.ps1'
Write-Log 'Step 2: stopping IntelliSched and making a full backup'
& $kitStop -Root $Root -NoBackup -KeepDatabase -Quiet | Out-Null
if ((Invoke-KitNode $Root 'backup-cli.js' @('--reason', ('before the update to ' + $kitManifest.version))) -ne 0) {
    Add-Result 'FAIL' 'Backup' 'The backup before the update could not be made, so nothing was changed.'
    [void](Start-IntelliSched $Root ([string]$m.dailyUser))
    [void](Show-Summary 'UPDATE'); exit 1
}
Add-Result 'PASS' 'Backup' 'full backup made in the backup folder'
# The record counts now, for the self-test after the update (the app is stopped, so they stay).
if ((Invoke-KitNode $Root 'counts-cli.js') -ne 0) { Write-Log 'The record counts could not be read; the self-test will compare with the restored backup.' 'Yellow' }

# ---------------------------------------------------------------- 3-4. previous\, the new files
Write-Log 'Step 3: keeping the current version in previous\'
$prev = Join-Path $Root 'previous'
if (Test-Path -LiteralPath $prev) { Remove-Item -LiteralPath $prev -Recurse -Force }
New-Item -ItemType Directory -Force -Path $prev | Out-Null
$staging = Join-Path $Root '.update-staging'
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }

$changedRuntimes = @()
foreach ($r in $kitManifest.runtimes) {
    $old = $m.runtimes | Where-Object { $_.name -eq $r.name } | Select-Object -First 1
    if (-not $old -or $old.version -ne $r.version) { $changedRuntimes += $r.name }
}
$runtimeDirs = @{ 'Node.js' = 'node'; 'Python (CPython NuGet package)' = 'python'; 'MongoDB Community Server' = 'mongodb' }
$moveRuntimes = @($changedRuntimes | ForEach-Object { $runtimeDirs[$_] } | Where-Object { $_ })
if ($moveRuntimes -contains 'mongodb') { & $kitStop -Root $Root -Database -NoBackup -Quiet | Out-Null }

$moved = @()
function Restore-Previous {
    Write-Log 'Putting the old version back' 'Yellow'
    & $kitStop -Root $Root -NoBackup -KeepDatabase -Quiet | Out-Null
    foreach ($rel in $moved) {
        $cur = Join-Path $Root $rel
        if (Test-Path -LiteralPath $cur) { Remove-Item -LiteralPath $cur -Recurse -Force }
        Move-Item -LiteralPath (Join-Path $prev $rel) -Destination $cur
    }
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $prev -Recurse -Force -ErrorAction SilentlyContinue
    # The old version's own start.ps1 (1.0.1 or earlier) does not know about elevation: an elevated
    # updater starts it as the daily user through the kit's one-time task.
    $back = Start-IntelliSched $Root ([string]$m.dailyUser)
    if ($back -eq 'started') { Write-Log 'The update failed and the old version was restored.' 'Yellow' }
    elseif ($back -eq 'not-signed-in') { Write-Log 'The update failed and the old version was restored. Open IntelliSched from the desktop icon to start it.' 'Yellow' }
    else { Write-Log 'The update failed; the old version was put back but did not start. Run CHECK.bat and send the report.' 'Red' }
}

try {
    Expand-Payload (Join-Path $Kit 'payload.zip') $staging
    if (-not (Test-Path -LiteralPath (Join-Path $staging 'app\server\src\app.js'))) { throw (Get-AvMessage (Join-Path $staging 'app\server\src\app.js') $Root) }
    $parts = @('app', 'scripts') + @($moveRuntimes | ForEach-Object { 'runtime\' + $_ })
    New-Item -ItemType Directory -Force -Path (Join-Path $prev 'runtime') | Out-Null
    foreach ($rel in $parts) {
        $cur = Join-Path $Root $rel
        if (Test-Path -LiteralPath $cur) { Move-Item -LiteralPath $cur -Destination (Join-Path $prev $rel); $moved += $rel }
    }
    Move-Item -LiteralPath (Join-Path $staging 'app') -Destination (Join-Path $Root 'app')
    foreach ($rt in $moveRuntimes) { Move-Item -LiteralPath (Join-Path $staging ('runtime\' + $rt)) -Destination (Join-Path $Root ('runtime\' + $rt)) }
    Copy-Tree (Join-Path $Kit 'scripts') (Join-Path $Root 'scripts')
    if ($moved -notcontains 'app') { $moved += 'app' }
    if ($moved -notcontains 'scripts') { $moved += 'scripts' }
    # The model in use stays (Engine 4 may have retrained it): app\models comes from previous\.
    $oldModels = Join-Path $prev 'app\models'
    if (Test-Path -LiteralPath $oldModels) { Copy-Tree $oldModels (Join-Path $Root 'app\models') }
    $missing = Find-MissingRuntimeFile $Root
    if ($missing) { throw (Get-AvMessage $missing $Root) }

    Write-Log 'Step 4: the Python packages (offline)'
    $env:PYTHONNOUSERSITE = '1'
    $py = Join-Path $Root 'runtime\python\python.exe'
    $pipOut = Invoke-Native { & $py -s -m pip install --no-index --find-links (Join-Path $staging 'wheels') -r (Join-Path $Root 'app\backend\requirements.txt') --no-warn-script-location --disable-pip-version-check }
    if ($LASTEXITCODE -ne 0) { foreach ($l in $pipOut) { Write-Log ('    ' + $l) }; throw 'The Python packages could not be installed.' }
    Remove-Item -LiteralPath $staging -Recurse -Force
    Add-Result 'PASS' 'New files' ('app, scripts' + $(if ($moveRuntimes.Count) { ', runtime ' + ($moveRuntimes -join ', ') } else { '' }))

    # ------------------------------------------------------------ 5. settings: add only what is missing
    $cfg = Join-Path $Root 'config'
    $serverEnv = Read-EnvFile (Join-Path $cfg 'server.env')
    $need = [ordered]@{ 'CLIENT_DIST_DIR' = (Join-Path $Root 'app\client'); 'HOST' = '127.0.0.1'; 'NODE_ENV' = 'production'; 'INTELLISCHED_MODEL_PATH' = (Join-Path $Root 'app\models\intellisched_gbdt_engine.joblib') }
    $add = @()
    foreach ($k in $need.Keys) { if (-not $serverEnv.ContainsKey($k)) { $add += ($k + '=' + $need[$k]) } }
    if ($add.Count) {
        $text = [System.IO.File]::ReadAllText((Join-Path $cfg 'server.env'), $script:Utf8NoBom).TrimEnd() + "`r`n" + ($add -join "`r`n") + "`r`n"
        Write-Utf8NoBom (Join-Path $cfg 'server.env') $text
        Write-Log ('Added settings: ' + (($add | ForEach-Object { ($_ -split '=')[0] }) -join ', '))
    }
    Add-Result 'PASS' 'Settings' 'kept (no secret regenerated)'

    # ------------------------------------------------------------ 5b. Phase 12.1: runs only while in use
    # The task at log on (1.0.0) is removed, the database service becomes Manual, and the shortcuts are
    # made again (with "Stop IntelliSched").
    if (-not $Portable) {
        if ($m.task -and (Get-ScheduledTask -TaskName $m.task -ErrorAction SilentlyContinue)) {
            Unregister-ScheduledTask -TaskName $m.task -Confirm:$false
            Write-Log ('Removed the task at log on (' + $m.task + ')')
        }
        if ($m.service -and (Get-Service -Name $m.service -ErrorAction SilentlyContinue)) {
            Set-Service -Name $m.service -StartupType Manual
            Write-Log 'The database service starts by hand now (Manual)'
        }
        $desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
        $menu = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'IntelliSched'
        New-Item -ItemType Directory -Force -Path $menu | Out-Null
        foreach ($old in @($m.shortcuts)) { if ($old -and (Test-Path -LiteralPath $old)) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue } }
        $shell = New-Object -ComObject WScript.Shell
        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $made = @()
        foreach ($l in (Get-KitShortcuts $Root $desktop $menu)) {
            $sc = $shell.CreateShortcut($l.Path)
            $sc.TargetPath = $ps; $sc.Arguments = $l.Args; $sc.WorkingDirectory = $Root; $sc.IconLocation = (Join-Path $Root 'scripts\intellisched.ico') + ',0'; $sc.WindowStyle = $l.Style
            $sc.Save()
            $made += $l.Path
        }
        $m.shortcuts = $made
    }
    $m.task = $null
    Add-Result 'PASS' 'Runs only while in use' 'no task at log on; the database service is Manual; Stop IntelliSched in the Start menu'

    # ------------------------------------------------------------ 6. start, self-test
    Write-Log 'Step 6: starting and the self-test'
    # Phase 12.2 (decision 3): as the daily user, never elevated (a one-time task when this is elevated).
    $started = Start-IntelliSched $Root ([string]$m.dailyUser)
    if ($started -eq 'failed') { throw 'The new version did not start within 90 seconds.' }
    if ($started -eq 'not-signed-in') {
        Add-Result 'WARN' 'Self-test' ('skipped: ' + $m.dailyUser + ' is not signed in at this screen. Open IntelliSched from the desktop icon to start it.')
    } else {
        $code = Invoke-KitNode $Root 'selftest.js' @('--counts', (Join-Path $Root 'data\update-counts.json'))
        if ($code -ne 0) { throw 'The self-test of the new version failed.' }
    }
} catch {
    Add-Result 'FAIL' 'Update' $_.Exception.Message
    Restore-Previous
    [void](Show-Summary 'UPDATE')
    exit 1
}

$m.version = $kitManifest.version
$m.runtimes = @($kitManifest.runtimes | ForEach-Object { [ordered]@{ name = $_.name; version = $_.version } })
$m | Add-Member -NotePropertyName updatedAt -NotePropertyValue (Get-Date).ToString('o') -Force
Write-Json $manifestFile $m
Remove-Item -LiteralPath $prev -Recurse -Force -ErrorAction SilentlyContinue
if ($started -ne 'not-signed-in') { Add-Result 'PASS' 'Self-test' 'every line passed' }
$ok = Show-Summary 'UPDATE'
if ($ok -and $started -eq 'not-signed-in') { Write-Host 'Open IntelliSched from the desktop icon to start it.' -ForegroundColor Yellow }
elseif ($ok -and -not $NoBrowser) { Start-Process ('http://localhost:' + $m.ports.gateway + '/') }
if ($ok) { exit 0 } else { exit 1 }
