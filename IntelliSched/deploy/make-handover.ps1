# IntelliSched: the office handover (Phase 12.1, decision 1). MAKE-HANDOVER.bat runs it on the team's
# laptop only when the real data changed after the Office kit was made. One run:
#   1. npm run defense:backup (read only), and shows where the backup went;
#   2. npm run defense:restore -- --from <it> --into intellisched_handover_test (a throwaway copy);
#   3-7. deploy\make-handover.js on that copy: keeps exactly one account (the real Dean), gives it a
#      starting password it must change, writes handover.isbak and handover-training.enc encrypted with
#      the handover password into .deploy-out\handover\, writes .deploy-out\OFFICE-PASSWORDS.txt, drops
#      the throwaway copy, prints the counts and the SHA-256;
#   8. copies both files into the newest Office kit's data\ folder (never into a Practice kit).
# The user types his own handover password twice (8+ characters, not "intellisched") and chooses
# whether to keep the Dean's starting password of the last OFFICE-PASSWORDS.txt.
#   make-handover.ps1                         the user's run (MAKE-HANDOVER.bat)
#   make-handover.ps1 -Generate               no questions: both passwords generated (the first run)
#   make-handover.ps1 -FromBackup <folder> -OutDir <dir> -PasswordsFile <file> -TrainingFile <csv> [-Kit <office kit>]
#                                             the tests: a practice-copy backup instead of step 1
param(
    [string]$FromBackup = '',
    [string]$OutDir = '',
    [string]$PasswordsFile = '',
    [string]$TrainingFile = '',
    [string]$Kit = '',
    [switch]$Generate,
    [switch]$NoKitCopy,
    [string]$LogJson = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\common.ps1')
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DeployOut = Join-Path $Repo '.deploy-out'
Start-KitLog (Join-Path $Repo '.demo-data\logs') 'make-handover'
if ($FromBackup -and (-not $OutDir -or -not $PasswordsFile -or -not $TrainingFile)) {
    Write-Log 'A test run (-FromBackup) names its own -OutDir, -PasswordsFile and -TrainingFile.' 'Red'; exit 2
}
if (-not $OutDir) { $OutDir = Join-Path $DeployOut 'handover' }
if (-not $PasswordsFile) { $PasswordsFile = Join-Path $DeployOut 'OFFICE-PASSWORDS.txt' }
if (-not $TrainingFile) { $TrainingFile = Join-Path $Repo 'docs\ml\private\dataset_full.csv' }
if (-not $LogJson) { $LogJson = Join-Path $Repo '.demo-data\logs\make-handover.json' }

function Invoke-NodeWithSecret([string[]]$NodeArgs, [string]$Secret) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'node.exe'
    $psi.Arguments = (($NodeArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $script:Utf8NoBom
    $psi.StandardErrorEncoding = $script:Utf8NoBom
    $psi.WorkingDirectory = $Repo
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    [void]$p.Start()
    $raw = [System.Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($script:Utf8NoBom.GetBytes($Secret)) + "`n")
    $p.StandardInput.BaseStream.Write($raw, 0, $raw.Length)
    $p.StandardInput.BaseStream.Flush()
    $p.StandardInput.Close()
    $errTask = $p.StandardError.ReadToEndAsync()
    while (-not $p.StandardOutput.EndOfStream) { $line = $p.StandardOutput.ReadLine(); if ($null -ne $line) { Write-Log $line } }
    $p.WaitForExit()
    foreach ($l in ($errTask.Result -split "`r?`n")) { if ($l.Trim()) { Write-Log $l 'Red' } }
    return $p.ExitCode
}

# ---------------------------------------------------------------- the passwords
$secret = @{}
if (-not $Generate -and -not $FromBackup) {
    Write-Host ''
    Write-Host 'Choose the handover password: INSTALL.bat on the office PC asks for it.'
    while ($true) {
        $a = ConvertFrom-SecureText (Read-Host 'Handover password (8 or more characters)' -AsSecureString)
        $b = ConvertFrom-SecureText (Read-Host 'The same password again' -AsSecureString)
        if ($a.Length -lt 8) { Write-Host 'Use at least 8 characters.' -ForegroundColor Yellow; continue }
        if ($a.ToLower() -eq 'intellisched') { Write-Host 'Choose a password other than "intellisched".' -ForegroundColor Yellow; continue }
        if ($a -cne $b) { Write-Host 'The two passwords are not the same.' -ForegroundColor Yellow; continue }
        break
    }
    $secret.handoverPassword = $a
    if (Test-Path -LiteralPath $PasswordsFile) {
        $old = [System.IO.File]::ReadAllText($PasswordsFile)
        if ($old -match "(?m)^The Dean's starting password: (\S+)\s*$") {
            $keep = Read-Host "Keep the Dean's starting password from the last OFFICE-PASSWORDS.txt? (Y/N)"
            if ($keep -match '^[Yy]') { $secret.deanPassword = $matches[1] }
        }
    }
}

Push-Location $Repo
$code = 1
try {
    # ------------------------------------------------------------ 1. back up (read only)
    if ($FromBackup) {
        $folder = (Resolve-Path -LiteralPath $FromBackup).Path
        Write-Log ('Step 1: skipped (-FromBackup ' + $folder + ')') 'Yellow'
    } else {
        Write-Log 'Step 1: backing up the defense database (npm run defense:backup, read only)'
        $before = @(Get-ChildItem -LiteralPath (Join-Path $Repo '.demo-data\backups') -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
        & npm.cmd run defense:backup
        if ($LASTEXITCODE -ne 0) { throw 'npm run defense:backup failed (is a demo or the defense running? Stop it first).' }
        $made = Get-ChildItem -LiteralPath (Join-Path $Repo '.demo-data\backups') -Directory -Filter 'defense-*' | Where-Object { ($before -notcontains $_.FullName) -and $_.Name -notmatch 'before-restore' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $made) { throw 'The new defense backup folder was not found.' }
        $folder = $made.FullName
        Write-Log ('  the backup is in ' + $folder) 'Green'
    }
    $bm = Read-Json (Join-Path $folder 'manifest.json')
    $sourceDb = [string]$bm.database
    if ($FromBackup -and $sourceDb -match 'defense') { throw 'A test run takes a backup of the practice copy only, never a defense backup.' }

    # ------------------------------------------------------------ 2. the throwaway copy
    Write-Log 'Step 2: copying it into intellisched_handover_test (a throwaway copy)'
    & npm.cmd run defense:restore -- --from $folder --into intellisched_handover_test --yes
    if ($LASTEXITCODE -ne 0) { throw 'The copy into intellisched_handover_test failed.' }

    # ------------------------------------------------------------ 3-7.
    $nodeArgs = @((Join-Path $PSScriptRoot 'make-handover.js'), '--source-db', $sourceDb, '--out', $OutDir, '--passwords', $PasswordsFile, '--training', $TrainingFile, '--log-json', $LogJson)
    $code = Invoke-NodeWithSecret $nodeArgs (ConvertTo-Json -Compress $secret)
    $secret = $null
    if ($code -eq 4) { throw 'No real Dean account was found. Nothing was written.' }
    if ($code -ne 0) { throw 'Writing the handover failed (see above).' }

    # ------------------------------------------------------------ 8. into the Office kit
    if (-not $NoKitCopy) {
        if (-not $Kit) {
            $newest = Get-ChildItem -LiteralPath $DeployOut -Directory -Filter 'IntelliSched-Office-Kit-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($newest) { $Kit = $newest.FullName }
        }
        if ($Kit) {
            $km = Read-Json (Join-Path $Kit 'kit-manifest.json')
            if ($km.kind -ne 'office') { throw ('Refused: ' + $Kit + ' is not an Office kit. Handover files never go into a Practice kit.') }
            $files = @($km.files)
            foreach ($n in @('handover.isbak', 'handover-training.enc')) {
                Copy-Item -LiteralPath (Join-Path $OutDir $n) -Destination (Join-Path $Kit ('data\' + $n)) -Force
                $rel = 'data\' + $n
                $item = Get-Item -LiteralPath (Join-Path $Kit $rel)
                $entry = [ordered]@{ path = $rel; size = $item.Length; sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLower() }
                $files = @($files | Where-Object { $_.path -ne $rel }) + @($entry)
            }
            $km.files = $files
            Write-Json (Join-Path $Kit 'kit-manifest.json') $km
            Write-Log ('Step 8: copied into ' + $Kit + '\data') 'Green'
        } else {
            Write-Log 'Step 8: no Office kit yet; build-kit.ps1 takes the files from .deploy-out\handover.' 'Yellow'
        }
    }
    Write-Log ''
    Write-Log 'Done. Print OFFICE-PASSWORDS.txt and keep it apart from the USB sticks; copy the Office kit to two USB sticks.' 'Green'
    $code = 0
} catch {
    Write-Log ('FAIL: ' + $_.Exception.Message) 'Red'
    if ($code -ne 4) { $code = 1 }
} finally {
    Pop-Location
}
Write-Log ('The log is ' + $script:LogFile)
exit $code
