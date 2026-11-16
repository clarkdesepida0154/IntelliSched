# IntelliSched: INSTALL.bat (Phase 12, decision 7). Installs the kit into C:\IntelliSched.
#   install.ps1                                   the real install (administrator)
#   install.ps1 -Portable -Root <folder> [-Mode practice|office] [-BackupFile <f>] [-BackupFolder <f>] [-Unattended] [-NoBrowser]
#     the test install (decision 10): mongod as a child process, no service, task, shortcuts or VC++,
#     ports above 27090 / 5890 / 8890. -Unattended takes the backup password from the environment
#     variable INTELLISCHED_TEST_BACKUP_PASSWORD (tests only).
param(
    [switch]$Portable,
    [string]$Root = '',
    [ValidateSet('', 'practice', 'office')][string]$Mode = '',
    [string]$BackupFile = '',
    [string]$BackupFolder = '',
    [switch]$Unattended,
    [switch]$NoBrowser
)
. (Join-Path $PSScriptRoot 'common.ps1')

$Kit = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Root) { $Root = $script:DefaultRoot }
if ($Unattended -and -not $Portable) { Write-Host 'Unattended is for the portable test install only.'; exit 2 }
$DbName = 'intellisched'
$ReplSet = 'rs-intellisched'

Unblock-KitFiles $Kit
Start-KitLog (Join-Path $Kit 'logs') 'install'
$kitManifest = Read-Json (Join-Path $Kit 'kit-manifest.json')
# Phase 12.1 (decision 3): an Office kit installs the office's data only (no Practice mode); a Practice
# kit never holds the handover.
$officeKit = ($kitManifest.kind -eq 'office')
Write-Log ('IntelliSched ' + $(if ($officeKit) { 'Office' } else { 'Practice' }) + ' kit ' + $kitManifest.version + ' -> ' + $Root)
if ($Portable) { Write-Log 'Portable test install (no service, task, shortcuts or VC++ runtime)' 'Yellow' }

function Stop-Install([string]$Why) {
    Add-Result 'FAIL' 'Install' $Why
    if (Test-Path -LiteralPath (Join-Path $Root 'install-manifest.json')) {
        Write-Log 'Run UNINSTALL.bat to remove what was installed, then run INSTALL.bat again.' 'Yellow'
    }
    [void](Show-Summary 'INSTALL')
    exit 1
}

# ---------------------------------------------------------------- 1. preflight
Write-Log 'Step 1: checking this PC'
Invoke-Preflight 'install' $Root -Portable:$Portable
if (@($script:Results | Where-Object { $_.Status -eq 'FAIL' }).Count) { [void](Show-Summary 'INSTALL'); exit 1 }
$pendingWarn = @($script:Results | Where-Object { $_.Name -eq 'Pending restart' -and $_.Status -eq 'WARN' }).Count
if ($pendingWarn -and -not $Unattended) {
    $a = Read-Host 'Windows is waiting for a restart. Continue anyway? (Y/N)'
    if ($a -notmatch '^[Yy]') { Write-Log 'Stopped: restart the PC, then run INSTALL.bat again.'; exit 1 }
}

# ---------------------------------------------------------------- 2. the mode and the backup
if ($officeKit) {
    if ($Mode -eq 'practice') { Stop-Install 'This is the Office kit: it installs the office data only. Use the Practice kit for practice.' }
    $Mode = 'office'
}
if (-not $Mode) {
    Write-Host ''
    Write-Host '1 = Practice (practice data, for testing on any laptop)'
    Write-Host "2 = Office (the Dean's real data)"
    $choice = Read-Host 'Choose 1 or 2'
    if ($choice -eq '1') { $Mode = 'practice' } elseif ($choice -eq '2') { $Mode = 'office' } else { Stop-Install 'Choose 1 (Practice) or 2 (Office).' }
}
if (-not $BackupFile) {
    if ($Mode -eq 'practice') { $BackupFile = Join-Path $Kit 'data\practice.isbak' }
    else {
        $default = Join-Path $Kit 'data\handover.isbak'
        # Phase 12.1: the Office kit carries it; ask for a path only when it is missing.
        if (Test-Path -LiteralPath $default) { $BackupFile = $default }
    }
    if (-not $BackupFile) {
        $default = Join-Path $Kit 'data\handover.isbak'
        $prompt = 'Path of the handover backup (.isbak)'
        if (Test-Path -LiteralPath $default) { $prompt = $prompt + ' [Enter = ' + $default + ']' }
        $typed = Read-Host $prompt
        if ($typed) { $BackupFile = $typed.Trim('"') } else { $BackupFile = $default }
    }
}
if (-not (Test-Path -LiteralPath $BackupFile)) { Stop-Install ('The backup file was not found: ' + $BackupFile) }
$BackupFile = (Resolve-Path -LiteralPath $BackupFile).Path
Add-Result 'PASS' 'Mode' ($Mode + ', backup ' + (Split-Path -Leaf $BackupFile))
$passwordPrompt = "The backup's password"
if ($officeKit) { $passwordPrompt = 'The handover password (on the OFFICE-PASSWORDS.txt paper)' }
if ($Unattended) { $backupPassword = $env:INTELLISCHED_TEST_BACKUP_PASSWORD }
else { $backupPassword = ConvertFrom-SecureText (Read-Host $passwordPrompt -AsSecureString) }
$trainingFile = Join-Path $Kit 'data\handover-training.enc'
$withTraining = ($Mode -eq 'office') -and (Test-Path -LiteralPath $trainingFile)
if (-not $backupPassword) { Stop-Install 'No backup password was typed.' }

# ---------------------------------------------------------------- 3. the daily user, the files
if ($Portable) { $dailyUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
else {
    $dailyUser = Get-ScreenUser
    $typed = Read-Host ('IntelliSched will run for ' + $dailyUser + '. Press Enter, or type another local account name')
    if ($typed) { $dailyUser = $typed.Trim() }
    try { [void](New-Object Security.Principal.NTAccount($dailyUser)).Translate([Security.Principal.SecurityIdentifier]) }
    catch { Stop-Install ('There is no Windows account named ' + $dailyUser + '.') }
}
Add-Result 'PASS' 'Daily user' $dailyUser
if (-not $BackupFolder) {
    $docs = Get-UserDocuments $dailyUser
    if (-not $docs) { Stop-Install ('The Documents folder of ' + $dailyUser + ' could not be found.') }
    $BackupFolder = Join-Path $docs 'IntelliSched Backups'
}

$manifest = [ordered]@{
    app = 'IntelliSched'; version = $kitManifest.version; mode = $Mode; portable = [bool]$Portable
    root = $Root; installedAt = (Get-Date).ToString('o'); dailyUser = $dailyUser
    backupFolder = $BackupFolder; dbName = $DbName
    ports = [ordered]@{ mongodb = 0; gateway = 0; python = 0 }
    service = $null; task = $null; shortcuts = @(); folders = @($Root); vcRedistInstalled = $false
    runtimes = @($kitManifest.runtimes | ForEach-Object { [ordered]@{ name = $_.name; version = $_.version } })
}
function Save-Manifest { Write-Json (Join-Path $Root 'install-manifest.json') $manifest }

Write-Log 'Step 3: copying the files'
New-Item -ItemType Directory -Force -Path $Root | Out-Null
Save-Manifest
try {
    Expand-Payload (Join-Path $Kit 'payload.zip') $Root
    Copy-Tree (Join-Path $Kit 'scripts') (Join-Path $Root 'scripts')
    foreach ($d in @('config', 'data\db', 'logs', 'run')) { New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null }
} catch { Stop-Install ('The files could not be copied: ' + $_.Exception.Message) }
$missing = Find-MissingRuntimeFile $Root
if ($missing) { Stop-Install (Get-AvMessage $missing $Root) }
Move-KitLog (Join-Path $Root 'logs')
Add-Result 'PASS' 'Files' ('extracted to ' + $Root)

# ---------------------------------------------------------------- 4. Visual C++ runtime
if (-not $Portable) {
    $vc = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
    if ($vc -and $vc.Installed -eq 1 -and [int]$vc.Minor -ge 40) { Add-Result 'PASS' 'Visual C++ runtime' ('already installed (' + $vc.Version + ')') }
    else {
        Write-Log 'Step 4: installing the Visual C++ runtime'
        $p = Start-Process -FilePath (Join-Path $Root 'runtime\vcredist\vc_redist.x64.exe') -ArgumentList '/install /quiet /norestart' -Wait -PassThru
        if (@(0, 1638, 3010) -contains $p.ExitCode) { $manifest.vcRedistInstalled = $true; Save-Manifest; Add-Result 'PASS' 'Visual C++ runtime' ('installed (code ' + $p.ExitCode + ')') }
        else { Stop-Install ('The Visual C++ runtime could not be installed (code ' + $p.ExitCode + ').') }
    }
}

# ---------------------------------------------------------------- 5. the Python packages, offline
Write-Log 'Step 5: installing the Python packages (offline)'
$py = Join-Path $Root 'runtime\python\python.exe'
$env:PYTHONNOUSERSITE = '1'
foreach ($k in @('PYTHONPATH', 'PYTHONHOME', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_CONFIG_FILE')) { Remove-Item -Path ('Env:' + $k) -ErrorAction SilentlyContinue }
$pipOut = Invoke-Native { & $py -s -m pip install --no-index --find-links (Join-Path $Root 'wheels') -r (Join-Path $Root 'app\backend\requirements.txt') --no-warn-script-location --disable-pip-version-check }
$pipCode = $LASTEXITCODE
foreach ($l in $pipOut) { if ("$l" -match 'Successfully|ERROR|error') { Write-Log ('    ' + $l) } }
if ($pipCode -ne 0) { Stop-Install 'The Python packages could not be installed (see the log).' }
$imp = Invoke-Native { & $py -s -c "import fastapi, uvicorn, pymongo, sklearn, pandas, numpy, scipy, joblib; print('ok')" }
if ("$imp" -notmatch 'ok') { Stop-Install ((Get-AvMessage (Join-Path $Root 'runtime\python') $Root) + ' (a Python package could not be loaded)') }
Remove-Item -LiteralPath (Join-Path $Root 'wheels') -Recurse -Force -ErrorAction SilentlyContinue
Add-Result 'PASS' 'Python packages' 'installed offline'

# ---------------------------------------------------------------- 6. config, secrets, MongoDB
Write-Log 'Step 6: settings and the database'
if ($Portable) {
    $mongoPort = Find-FreePort 27091 27099
    $gwPort = Find-FreePort 5891 5899
    $pyPort = Find-FreePort 8891 8899
} else {
    $mongoPort = Find-FreePort 27027 27099
    $gwPort = Find-FreePort 5880 5889
    $pyPort = Find-FreePort 8880 8889
}
$manifest.ports.mongodb = $mongoPort; $manifest.ports.gateway = $gwPort; $manifest.ports.python = $pyPort
Save-Manifest

$dbPassword = New-Secret 32
$apiKey = New-Secret 48
$uri = 'mongodb://intellisched_app:' + $dbPassword + '@127.0.0.1:' + $mongoPort + '/' + $DbName + '?authSource=admin&replicaSet=' + $ReplSet
$modelFile = Join-Path $Root 'app\models\intellisched_gbdt_engine.joblib'
$serverEnvText = @(
    '# IntelliSched gateway settings, written by the installer. Keep this file private.',
    'NODE_ENV=production',
    'HOST=127.0.0.1',
    ('PORT=' + $gwPort),
    ('CLIENT_URL=http://localhost:' + $gwPort),
    ('CLIENT_DIST_DIR=' + (Join-Path $Root 'app\client')),
    ('MONGODB_URI=' + $uri),
    ('JWT_SECRET=' + (New-Secret 64)),
    ('PYTHON_ML_SERVICE_URL=http://127.0.0.1:' + $pyPort),
    ('PYTHON_ML_API_KEY=' + $apiKey),
    ('INTELLISCHED_MODEL_PATH=' + $modelFile)
) -join "`r`n"
$backendEnvText = @(
    '# IntelliSched Python service settings, written by the installer. Keep this file private.',
    ('MONGO_URI=' + $uri),
    'HOST=127.0.0.1',
    ('PORT=' + $pyPort),
    ('ADMIN_API_KEY=' + $apiKey),
    ('ALLOWED_ORIGINS=http://localhost:' + $gwPort),
    ('ML_MODEL_PATH=' + $modelFile)
)
# Phase 12.1 (decision 3): Retrain reads the office's training records from private\.
if ($withTraining) { $backendEnvText += ('ML_DATASET=' + (Join-Path $Root 'private\dataset_full.csv')) }
$backendEnvText = $backendEnvText -join "`r`n"
$cfgDir = Join-Path $Root 'config'
Write-Utf8NoBom (Join-Path $cfgDir 'server.env') ($serverEnvText + "`r`n")
Write-Utf8NoBom (Join-Path $cfgDir 'backend.env') ($backendEnvText + "`r`n")
Write-Utf8NoBom (Join-Path $cfgDir 'mongo.keyfile') (New-Secret 512)
function YamlPath([string]$p) { return ("'" + ($p -replace "'", "''") + "'") }
$mongoCfg = @(
    'systemLog:',
    '  destination: file',
    ('  path: ' + (YamlPath (Join-Path $Root 'logs\mongod.log'))),
    '  logAppend: true',
    'net:',
    '  bindIp: 127.0.0.1',
    ('  port: ' + $mongoPort),
    'storage:',
    ('  dbPath: ' + (YamlPath (Join-Path $Root 'data\db'))),
    '  wiredTiger:',
    '    engineConfig:',
    '      cacheSizeGB: 0.25',
    'security:',
    '  authorization: enabled',
    ('  keyFile: ' + (YamlPath (Join-Path $cfgDir 'mongo.keyfile'))),
    'replication:',
    ('  replSetName: ' + $ReplSet)
) -join "`r`n"
Write-Utf8NoBom (Join-Path $cfgDir 'mongod.cfg') ($mongoCfg + "`r`n")
$dbPassword = $null; $apiKey = $null

# config\ for Administrators, SYSTEM and the daily user only (inheritance off). The daily user also
# gets Modify on the rest of the install (logs, run, the model files).
$userAcl = 'R'
if ($Portable) { $userAcl = 'M' }
# Only the folders the services write (a grant on the whole folder walks every runtime file: minutes).
foreach ($d in @('logs', 'run', 'data', 'app\models')) { & icacls.exe (Join-Path $Root $d) /grant ($dailyUser + ':(OI)(CI)M') /Q | Out-Null }
& icacls.exe $cfgDir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' ($dailyUser + ':(OI)(CI)' + $userAcl) /Q | Out-Null
if ($LASTEXITCODE -ne 0) { Stop-Install 'The settings folder could not be locked (icacls).' }
Add-Result 'PASS' 'Settings' ('config written (UTF-8, no BOM), ports database ' + $mongoPort + ', web ' + $gwPort + ', service ' + $pyPort)

$mongod = Join-Path $Root 'runtime\mongodb\bin\mongod.exe'
$cfgFile = Join-Path $cfgDir 'mongod.cfg'
if ($Portable) {
    try {
        $p = Start-Process -FilePath $mongod -ArgumentList @('--config', ('"' + $cfgFile + '"')) -WindowStyle Hidden -PassThru
        Write-Utf8NoBom (Join-Path $Root 'run\mongod.pid') ([string]$p.Id)
    } catch { Stop-Install (Get-AvMessage $mongod $Root) }
} else {
    $out = Invoke-Native { & $mongod --config $cfgFile --install --serviceName IntelliSchedMongoDB --serviceDisplayName 'IntelliSched Database' }
    $manifest.service = 'IntelliSchedMongoDB'; Save-Manifest
    if (-not (Get-Service -Name IntelliSchedMongoDB -ErrorAction SilentlyContinue)) { Stop-Install ('The database service could not be registered: ' + ($out -join ' ')) }
    # Phase 12.1 (decision 4): Manual. IntelliSched runs only while it is used: start.ps1 starts the
    # database, the supervisor stops it when IntelliSched closes.
    Set-Service -Name IntelliSchedMongoDB -StartupType Manual
    & sc.exe failure IntelliSchedMongoDB reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
    # The daily user may start and stop the database service (start.ps1 runs as that user).
    $sid = (New-Object Security.Principal.NTAccount($dailyUser)).Translate([Security.Principal.SecurityIdentifier]).Value
    $sddl = ((& sc.exe sdshow IntelliSchedMongoDB) -join '').Trim()
    if ($sddl -match '^(D:.*?)(S:.*)?$' -and $sddl -notmatch [regex]::Escape($sid)) {
        $newSddl = $matches[1] + '(A;;CCLCSWRPWPDTLOCRRC;;;' + $sid + ')' + $matches[2]
        & sc.exe sdset IntelliSchedMongoDB $newSddl | Out-Null
    }
    try { Start-Service -Name IntelliSchedMongoDB } catch { Stop-Install ('The database service did not start: ' + $_.Exception.Message + ' (see ' + (Join-Path $Root 'logs\mongod.log') + ')') }
}
$deadline = (Get-Date).AddSeconds(60)
while (((Get-ListeningPorts) -notcontains $mongoPort) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 500 }
if ((Get-ListeningPorts) -notcontains $mongoPort) { Stop-Install ('The database did not start (see ' + (Join-Path $Root 'logs\mongod.log') + ').') }
Add-Result 'PASS' 'Database' ('MongoDB on 127.0.0.1:' + $mongoPort)

# ---------------------------------------------------------------- 7. the database user
Write-Log 'Step 7: the database user'
if ((Invoke-KitNode $Root 'create-db-user.js') -ne 0) { Stop-Install 'The database user could not be made (see the log).' }
Add-Result 'PASS' 'Database user' 'intellisched_app'

# ---------------------------------------------------------------- 8-9. restore, System settings
Write-Log 'Step 8: restoring the backup (this takes a minute)'
if (-not (Test-Path -LiteralPath $BackupFolder)) { New-Item -ItemType Directory -Force -Path $BackupFolder | Out-Null }
if (-not $Portable) { & icacls.exe $BackupFolder /grant ($dailyUser + ':(OI)(CI)M') /Q | Out-Null }
$code = Invoke-KitNode $Root 'restore-cli.js' @('--file', $BackupFile, '--backup-folder', $BackupFolder) $backupPassword
if ($code -eq 3) { Stop-Install 'The backup could not be opened: check the password and the file.' }
if ($code -ne 0) { Stop-Install 'The backup could not be restored (see the log).' }
Add-Result 'PASS' 'Restore' (Split-Path -Leaf $BackupFile)

# Phase 12.1 (decision 3): the Retrain data into private\, locked to Administrators, SYSTEM and the
# daily user (the Python service runs as that user).
if ($withTraining) {
    Write-Log 'Step 8b: the Retrain data'
    $private = Join-Path $Root 'private'
    New-Item -ItemType Directory -Force -Path $private | Out-Null
    & icacls.exe $private /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' ($dailyUser + ':(OI)(CI)M') /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Install 'The private folder could not be locked (icacls).' }
    $code = Invoke-KitNode $Root 'training-cli.js' @('--file', $trainingFile) $backupPassword
    if ($code -ne 0) { Stop-Install 'The Retrain data could not be opened: check the handover password.' }
    Add-Result 'PASS' 'Retrain data' 'in private\ (Administrators, SYSTEM and the daily user only)'
}
$backupPassword = $null
Add-Result 'PASS' 'System settings' ('backups to ' + $BackupFolder + ', daily, keep 30')

# ---------------------------------------------------------------- 10. shortcuts, start
# Phase 12.1 (decision 4): no scheduled task. IntelliSched starts only from the desktop or Start-menu
# icon, closes itself after the System setting's minutes without use (default 60), and "Stop
# IntelliSched" closes it at once; both back up first when anything changed.
if (-not $Portable) {
    Write-Log 'Step 10: the shortcuts'
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $startPs = Join-Path $Root 'scripts\start.ps1'
    $shell = New-Object -ComObject WScript.Shell
    $icon = Join-Path $Root 'scripts\intellisched.ico'
    $desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
    $menu = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'IntelliSched'
    New-Item -ItemType Directory -Force -Path $menu | Out-Null
    $manifest.folders = @($Root, $menu)
    $links = Get-KitShortcuts $Root $desktop $menu
    $made = @()
    foreach ($l in $links) {
        $s = $shell.CreateShortcut($l.Path)
        $s.TargetPath = $ps; $s.Arguments = $l.Args; $s.WorkingDirectory = $Root; $s.IconLocation = $icon + ',0'; $s.WindowStyle = $l.Style
        $s.Save()
        $made += $l.Path
    }
    $manifest.shortcuts = $made; Save-Manifest
    Add-Result 'PASS' 'Shortcuts' 'desktop icon; Start menu: IntelliSched, IntelliSched - Check, Stop IntelliSched (no task at log on)'
}

# Phase 12.2 (decision 3): as the daily user, never elevated (a one-time task when this is elevated).
Write-Log 'Step 10: starting IntelliSched'
$started = Start-IntelliSched $Root $dailyUser
$notStarted = ($started -eq 'not-signed-in')
if ($started -eq 'failed') { Stop-Install 'IntelliSched did not start within 90 seconds (see logs\server.log and logs\backend.log).' }
if ($notStarted) { Add-Result 'WARN' 'Start' ('not started: ' + $dailyUser + ' is not signed in at this screen. Open IntelliSched from the desktop icon to start it.') }
else { Add-Result 'PASS' 'Start' ('http://localhost:' + $gwPort + '/ as ' + $dailyUser) }

# ---------------------------------------------------------------- 11. self-test
Write-Log 'Step 11: self-test'
if ($notStarted) { Add-Result 'WARN' 'Self-test' 'skipped, because IntelliSched was not started' }
else {
    $stCode = Invoke-KitNode $Root 'selftest.js'
    if ($stCode -eq 0) { Add-Result 'PASS' 'Self-test' 'every line passed' } else { Add-Result 'FAIL' 'Self-test' 'see the lines above and logs\selftest.json' }
}

# ---------------------------------------------------------------- 12. the report
$self = $null
try { $self = Read-Json (Join-Path $Root 'logs\selftest.json') } catch { }
$report = @(
    'IntelliSched install report',
    ('Date: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')),
    ('Computer: ' + $env:COMPUTERNAME),
    ('Version: ' + $kitManifest.version),
    ('Mode: ' + $Mode + $(if ($Portable) { ' (portable test install)' } else { '' })),
    ('Folder: ' + $Root),
    ('Daily user: ' + $dailyUser),
    ('Backup folder: ' + ($BackupFolder -replace [regex]::Escape($env:USERPROFILE), '%USERPROFILE%')),
    ('Ports: web ' + $gwPort + ', service ' + $pyPort + ', database ' + $mongoPort + ' (127.0.0.1 only)'),
    ('Runtimes: ' + (($kitManifest.runtimes | ForEach-Object { $_.name + ' ' + $_.version }) -join '; ')),
    '',
    'Steps:'
)
foreach ($r in $script:Results) { $report += ('  ' + $r.Status.PadRight(5) + $r.Name + $(if ($r.Detail) { ' - ' + $r.Detail } else { '' })) }
if ($self) {
    $report += ''
    $report += 'Self-test:'
    foreach ($r in $self.results) { $report += ('  ' + $r.status.PadRight(5) + $r.name + ' - ' + $r.detail) }
}
Write-Utf8NoBom (Join-Path $Root 'logs\install-report.txt') (($report -join "`r`n") + "`r`n")

$okAll = Show-Summary 'INSTALL'
Write-Log ('The install report is ' + (Join-Path $Root 'logs\install-report.txt'))
if ($okAll) {
    Write-Host ''
    if ($Mode -eq 'practice') {
        $signIn = Join-Path $Kit 'PRACTICE-SIGN-IN.txt'
        Write-Host 'Practice sign-in (also in PRACTICE-SIGN-IN.txt in the kit):' -ForegroundColor Cyan
        if (Test-Path -LiteralPath $signIn) { Get-Content -LiteralPath $signIn | ForEach-Object { Write-Host ('  ' + $_) } }
    } else {
        $arrow = [string][char]0x2192
        Write-Host ('Sign in as the Dean with the starting password from OFFICE-PASSWORDS.txt. Then change your password, and open Administration ' + $arrow + ' System to change the backup password.') -ForegroundColor Cyan
    }
    if ($notStarted) { Write-Host 'Open IntelliSched from the desktop icon to start it.' -ForegroundColor Yellow; exit 0 }
    Write-Host ('Open IntelliSched from the desktop icon, or http://localhost:' + $gwPort + '/')
    if (-not $NoBrowser) { Start-Process ('http://localhost:' + $gwPort + '/') }
    exit 0
}
exit 1
