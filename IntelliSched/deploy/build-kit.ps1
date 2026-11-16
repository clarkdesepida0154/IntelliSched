# IntelliSched: builds the deployment kits (Phase 12, decisions 1-3; Phase 12.1, decision 3: two kits).
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\build-kit.ps1 [-VersionLabel <label>] [-OutDir <folder>]
#       [-OfficeOutDir <folder>] [-HandoverDir <folder>] [-PracticeOnly]
# Output, from the same commit and version:
#   <repo>\.deploy-out\IntelliSched-Kit-<version>\         the Practice kit (data\practice.isbak): the only kit
#                                                         that goes onto borrowed laptops
#   <repo>\.deploy-out\IntelliSched-Office-Kit-<version>\  the Office kit: the same plus data\handover.isbak and
#                                                         data\handover-training.enc (from -HandoverDir, default
#                                                         .deploy-out\handover), without the practice data
# A Practice kit never holds a handover or training file: the build refuses if one is found in it.
# Never committed; never into OneDrive, Desktop or Documents.
# The runtimes are downloaded once into .deploy-out\cache\ from their official sources and checked.
# -BreakGateway is for the failed-update rollback test only: it plants a syntax error in the kit's gateway.
param(
    [string]$VersionLabel = '',
    [string]$OutDir = '',
    [switch]$BreakGateway,
    [switch]$DownloadOnly,
    [string]$OfficeOutDir = '',
    [string]$HandoverDir = '',
    [switch]$PracticeOnly
)
. (Join-Path $PSScriptRoot 'scripts\common.ps1')

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Backend = (Resolve-Path (Join-Path $Repo '..\intellisched_backend')).Path
$DeployOut = Join-Path $Repo '.deploy-out'
$Cache = Join-Path $DeployOut 'cache'
$Stage = Join-Path $DeployOut 'stage'
New-Item -ItemType Directory -Force -Path $Cache | Out-Null
Start-KitLog (Join-Path $Repo '.demo-data\logs') 'build-kit'

$NodeVersion = '24.19.0'
$PythonVersion = '3.12.10'
$MongoVersion = '7.0.24'

# ---------------------------------------------------------------- refuse synced folders
$synced = @([Environment]::GetFolderPath('MyDocuments'), [Environment]::GetFolderPath('Desktop'), $env:OneDrive) | Where-Object { $_ }
function Assert-NotSynced([string]$Folder) {
    $full = [System.IO.Path]::GetFullPath($Folder)
    foreach ($s in $synced) {
        if ($full.StartsWith(([System.IO.Path]::GetFullPath($s)).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw ('The kit is never built into ' + $s + ' (synced to OneDrive). Choose a folder under .deploy-out.')
        }
    }
}
Assert-NotSynced $DeployOut

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() }

function Get-Download([string]$Url, [string]$File) {
    $target = Join-Path $Cache $File
    if (Test-Path -LiteralPath $target) { Write-Log ('  cached: ' + $File); return $target }
    Write-Log ('  downloading ' + $Url)
    $tmp = $target + '.part'
    & curl.exe -L -f -s -S -o $tmp $Url
    if ($LASTEXITCODE -ne 0) { throw ('Download failed: ' + $Url) }
    Move-Item -LiteralPath $tmp -Destination $target -Force
    return $target
}

function Get-Text([string]$Url) {
    $out = & curl.exe -L -f -s -S $Url
    if ($LASTEXITCODE -ne 0) { throw ('Download failed: ' + $Url) }
    return ($out -join "`n")
}

$runtimes = @()

# ---------------------------------------------------------------- 1. the runtimes
Write-Log 'Runtimes'
# Node.js: the official zip, checked against SHASUMS256.txt.
$nodeName = 'node-v' + $NodeVersion + '-win-x64'
$nodeUrl = 'https://nodejs.org/dist/v' + $NodeVersion + '/' + $nodeName + '.zip'
$nodeZip = Get-Download $nodeUrl ($nodeName + '.zip')
$nodeSums = Get-Text ('https://nodejs.org/dist/v' + $NodeVersion + '/SHASUMS256.txt')
$nodeExpected = (($nodeSums -split "`n") | Where-Object { $_ -match (' ' + [regex]::Escape($nodeName + '.zip') + '$') } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
$nodeSha = Get-Sha256 $nodeZip
if ($nodeSha -ne $nodeExpected) { throw 'The Node.js zip does not match the official SHA-256.' }
Write-Log ('  Node.js ' + $NodeVersion + ' SHA-256 matches SHASUMS256.txt')
$runtimes += [ordered]@{ name = 'Node.js'; version = $NodeVersion; url = $nodeUrl; sha256 = $nodeSha; verifiedAgainst = 'https://nodejs.org/dist/v' + $NodeVersion + '/SHASUMS256.txt' }

# Python: the official CPython NuGet package (a portable full CPython), checked against the NuGet catalog's SHA-512.
$pyUrl = 'https://api.nuget.org/v3-flatcontainer/python/' + $PythonVersion + '/python.' + $PythonVersion + '.nupkg'
$pyPkg = Get-Download $pyUrl ('python.' + $PythonVersion + '.nupkg')
$pyReg = Get-Text ('https://api.nuget.org/v3/registration5-semver1/python/' + $PythonVersion + '.json') | ConvertFrom-Json
$pyCatalog = Get-Text $pyReg.catalogEntry | ConvertFrom-Json
$sha512 = [System.Security.Cryptography.SHA512]::Create()
$stream = [System.IO.File]::OpenRead($pyPkg)
try { $pyHash512 = [Convert]::ToBase64String($sha512.ComputeHash($stream)) } finally { $stream.Close() }
if ($pyCatalog.packageHashAlgorithm -ne 'SHA512' -or $pyCatalog.packageHash -ne $pyHash512) { throw 'The Python package does not match the NuGet catalog hash.' }
if ($pyCatalog.authors -notmatch 'Python') { throw ('Unexpected Python package author: ' + $pyCatalog.authors) }
$pySha = Get-Sha256 $pyPkg
Write-Log ('  Python ' + $PythonVersion + ' (NuGet, ' + $pyCatalog.authors + ') SHA-512 matches the NuGet catalog')
$runtimes += [ordered]@{ name = 'Python (CPython NuGet package)'; version = $PythonVersion; url = $pyUrl; sha256 = $pySha; verifiedAgainst = $pyReg.catalogEntry + ' (packageHash, SHA-512)'; publisher = $pyCatalog.authors }

# MongoDB Community: the official zip, checked against its .sha256 file.
$mongoFile = 'mongodb-windows-x86_64-' + $MongoVersion + '.zip'
$mongoUrl = 'https://fastdl.mongodb.org/windows/' + $mongoFile
$mongoZip = Get-Download $mongoUrl $mongoFile
$mongoExpected = ((Get-Text ($mongoUrl + '.sha256')) -split '\s+')[0].ToLower()
$mongoSha = Get-Sha256 $mongoZip
if ($mongoSha -ne $mongoExpected) { throw 'The MongoDB zip does not match the official SHA-256.' }
Write-Log ('  MongoDB ' + $MongoVersion + ' SHA-256 matches the official .sha256')
$runtimes += [ordered]@{ name = 'MongoDB Community Server'; version = $MongoVersion; url = $mongoUrl; sha256 = $mongoSha; verifiedAgainst = $mongoUrl + '.sha256' }

# Visual C++ 2015-2022 x64: no published checksum; the Authenticode signature must be valid and Microsoft's.
$vcUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
$vcExe = Get-Download $vcUrl 'vc_redist.x64.exe'
$sig = Get-AuthenticodeSignature -LiteralPath $vcExe
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'vc_redist.x64.exe is not validly signed by Microsoft.' }
$vcVersion = (Get-Item -LiteralPath $vcExe).VersionInfo.ProductVersion
$vcSha = Get-Sha256 $vcExe
Write-Log ('  Visual C++ runtime ' + $vcVersion + ' signed by Microsoft')
$runtimes += [ordered]@{ name = 'Microsoft Visual C++ 2015-2022 Redistributable (x64)'; version = $vcVersion; url = $vcUrl; sha256 = $vcSha; verifiedAgainst = 'Authenticode signature: ' + $sig.SignerCertificate.Subject }

# Extracted once into the cache.
$nodeDir = Join-Path $Cache $nodeName
if (-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) { Expand-Payload $nodeZip $Cache }
$pyDir = Join-Path $Cache ('python-' + $PythonVersion)
if (-not (Test-Path -LiteralPath (Join-Path $pyDir 'tools\python.exe'))) {
    $pyZip = Join-Path $Cache ('python.' + $PythonVersion + '.zip')
    Copy-Item -LiteralPath $pyPkg -Destination $pyZip -Force
    Expand-Archive -LiteralPath $pyZip -DestinationPath $pyDir -Force
    Remove-Item -LiteralPath $pyZip -Force
}
$pyExe = Join-Path $pyDir 'tools\python.exe'
$null = Invoke-Native { & $pyExe -I -m pip --version }
if ($LASTEXITCODE -ne 0) {
    Write-Log '  pip is missing in the Python package: python -m ensurepip'
    $null = Invoke-Native { & $pyExe -I -m ensurepip --default-pip }
    if ($LASTEXITCODE -ne 0) { throw 'ensurepip failed.' }
}
$mongoDir = Join-Path $Cache ('mongodb-' + $MongoVersion)
if (-not (Test-Path -LiteralPath (Join-Path $mongoDir 'bin\mongod.exe'))) {
    $top = (& tar.exe -tf $mongoZip | Select-Object -First 1).Split('/')[0]
    $tmpX = Join-Path $Cache 'mongo-x'
    New-Item -ItemType Directory -Force -Path $tmpX | Out-Null
    Push-Location $Cache
    try { $null = Invoke-Native { & tar.exe -xf $mongoFile -C 'mongo-x' ($top + '/bin/mongod.exe') ($top + '/LICENSE-Community.txt') ($top + '/THIRD-PARTY-NOTICES') ($top + '/README') } } finally { Pop-Location }
    New-Item -ItemType Directory -Force -Path (Join-Path $mongoDir 'bin') | Out-Null
    Copy-Item -LiteralPath (Join-Path $tmpX ($top + '\bin\mongod.exe')) -Destination (Join-Path $mongoDir 'bin\mongod.exe')
    foreach ($f in @('LICENSE-Community.txt', 'THIRD-PARTY-NOTICES', 'README')) {
        $src = Join-Path $tmpX ($top + '\' + $f)
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $mongoDir }
    }
    Remove-Item -LiteralPath $tmpX -Recurse -Force
}

# ---------------------------------------------------------------- 2. the Python wheels
Write-Log 'Python wheels'
$reqFile = Join-Path $PSScriptRoot 'kit-requirements.txt'
$reqHash = (Get-Sha256 $reqFile).Substring(0, 12)
$wheelDir = Join-Path $Cache ('wheels-cp312-' + $reqHash)
if (-not (Test-Path -LiteralPath $wheelDir) -or -not (Get-ChildItem -LiteralPath $wheelDir -Filter *.whl)) {
    New-Item -ItemType Directory -Force -Path $wheelDir | Out-Null
    $dl = Invoke-Native { & $pyExe -I -m pip download -r $reqFile -d $wheelDir --only-binary=:all: --platform win_amd64 --python-version 3.12 --implementation cp --abi cp312 --disable-pip-version-check }
    $dlCode = $LASTEXITCODE
    $dl | ForEach-Object { if ($_ -match 'Saved|ERROR') { Write-Log ('  ' + $_) } }
    if ($dlCode -ne 0) { Remove-Item -LiteralPath $wheelDir -Recurse -Force; throw 'pip download failed.' }
}
$wheels = @(Get-ChildItem -LiteralPath $wheelDir -Filter *.whl | Sort-Object Name)
Write-Log ('  ' + $wheels.Count + ' wheels')

if ($DownloadOnly) { Write-Log 'Download only: done.'; exit 0 }

# ---------------------------------------------------------------- 3. version and folders
$pkg = Read-Json (Join-Path $Repo 'server\package.json')
$commit = (& git -C $Repo rev-parse --short HEAD).Trim()
$version = $pkg.version + '-' + $commit
if ($VersionLabel) { $version = $VersionLabel }
if (-not $OutDir) { $OutDir = Join-Path $DeployOut ('IntelliSched-Kit-' + $version) }
Assert-NotSynced $OutDir
Write-Log ('Kit ' + $version + ' -> ' + $OutDir)
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage, $OutDir | Out-Null

# ---------------------------------------------------------------- 4. the app
Write-Log 'The web client (npm run build, relative /api)'
$oldVite = $env:VITE_API_BASE_URL
$env:VITE_API_BASE_URL = '/api'
# Phase 13 (decision 2): no fixed term in the build. The page opens on the user's last term, else the newest
# term with a schedule version, else the year in progress by the Academic calendar setting.
Remove-Item Env:VITE_DEFAULT_ACADEMIC_YEAR, Env:VITE_DEFAULT_SEMESTER -ErrorAction SilentlyContinue
Push-Location (Join-Path $Repo 'client')
try {
    $out = Invoke-Native { & npm.cmd run build -- --outDir (Join-Path $Stage 'app\client') --emptyOutDir }
    if ($LASTEXITCODE -ne 0) { throw 'The client build failed.' }
} finally { Pop-Location; $env:VITE_API_BASE_URL = $oldVite; Remove-Item Env:VITE_DEFAULT_ACADEMIC_YEAR, Env:VITE_DEFAULT_SEMESTER -ErrorAction SilentlyContinue }
$bundle = (Get-ChildItem -LiteralPath (Join-Path $Stage 'app\client\assets') -Filter *.js | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) }) -join "`n"
if ($bundle -match 'localhost:5000') { throw 'The client build still calls localhost:5000.' }

Write-Log 'The gateway (production dependencies only)'
$serverStage = Join-Path $Stage 'app\server'
Copy-Tree (Join-Path $Repo 'server\src') (Join-Path $serverStage 'src')
Copy-Item -LiteralPath (Join-Path $Repo 'server\package.json'), (Join-Path $Repo 'server\package-lock.json') -Destination $serverStage
$lockHash = (Get-Sha256 (Join-Path $Repo 'server\package-lock.json')).Substring(0, 12)
$modulesCache = Join-Path $Cache ('server-modules-' + $lockHash)
if (-not (Test-Path -LiteralPath (Join-Path $modulesCache 'node_modules\express'))) {
    New-Item -ItemType Directory -Force -Path $modulesCache | Out-Null
    Copy-Item -LiteralPath (Join-Path $Repo 'server\package.json'), (Join-Path $Repo 'server\package-lock.json') -Destination $modulesCache
    Push-Location $modulesCache
    $env:MONGOMS_DISABLE_POSTINSTALL = '1'
    try {
        $out = Invoke-Native { & npm.cmd ci --omit=dev --no-audit --no-fund }
        if ($LASTEXITCODE -ne 0) { throw 'npm ci --omit=dev failed.' }
    } finally { Pop-Location }
}
Copy-Tree (Join-Path $modulesCache 'node_modules') (Join-Path $serverStage 'node_modules')
if (Test-Path -LiteralPath (Join-Path $serverStage 'node_modules\mongodb-memory-server-core')) { throw 'A test-only package reached the kit.' }
# What the gateway reads outside server\: the GA settings and last year's transcribed classes.
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'app\shared'), (Join-Path $Stage 'app\docs\data') | Out-Null
Copy-Item -LiteralPath (Join-Path $Repo 'shared\ga-settings.json') -Destination (Join-Path $Stage 'app\shared')
Copy-Item -LiteralPath (Join-Path $Repo 'docs\data\past_class_blocks.csv') -Destination (Join-Path $Stage 'app\docs\data')
if ($BreakGateway) {
    Write-Log 'TEST ONLY: planting a syntax error in the gateway (the failed-update rollback test)' 'Yellow'
    [System.IO.File]::AppendAllText((Join-Path $serverStage 'src\app.js'), "`n)this is a deliberately broken gateway(`n")
}

Write-Log 'The Python service'
$backendStage = Join-Path $Stage 'app\backend'
New-Item -ItemType Directory -Force -Path (Join-Path $backendStage 'ml') | Out-Null
foreach ($f in @('main.py', 'config.py', 'constraints.py', 'database.py', 'engine1_nlp.py', 'engine2_gbdt.py', 'engine3_ga.py', 'engine4_retrainer.py', 'ga_jobs.py')) {
    Copy-Item -LiteralPath (Join-Path $Backend $f) -Destination $backendStage
}
foreach ($f in @('__init__.py', 'features.py', 'model.py', 'serving.py')) {
    Copy-Item -LiteralPath (Join-Path $Backend ('ml\' + $f)) -Destination (Join-Path $backendStage 'ml')
}
Copy-Item -LiteralPath $reqFile -Destination (Join-Path $backendStage 'requirements.txt')

Write-Log 'The model'
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'app\models') | Out-Null
foreach ($f in @('intellisched_gbdt_engine.joblib', 'intellisched_gbdt_engine.meta.json')) {
    Copy-Item -LiteralPath (Join-Path $Backend $f) -Destination (Join-Path $Stage 'app\models')
}

Write-Log 'The runtimes'
Copy-Tree $nodeDir (Join-Path $Stage 'runtime\node')
Copy-Tree (Join-Path $pyDir 'tools') (Join-Path $Stage 'runtime\python')
Copy-Tree $mongoDir (Join-Path $Stage 'runtime\mongodb')
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'runtime\vcredist') | Out-Null
Copy-Item -LiteralPath $vcExe -Destination (Join-Path $Stage 'runtime\vcredist')
Copy-Tree $wheelDir (Join-Path $Stage 'wheels')

Write-Utf8NoBom (Join-Path $Stage 'app\VERSION.txt') ($version + "`r`n")
# Phase 12.1 (decision 8): the build date, which the gateway's clock check reads.
Write-Json (Join-Path $Stage 'app\server\build-info.json') ([ordered]@{ version = $version; commit = $commit; builtAt = (Get-Date).ToString('o') })

# ---------------------------------------------------------------- 5. the payload and the kit's own files
Write-Log 'payload.zip'
$payload = Join-Path $OutDir 'payload.zip'
Push-Location $Stage
try {
    $out = Invoke-Native { & tar.exe -a -c -f 'payload.zip' app runtime wheels }
    if ($LASTEXITCODE -ne 0) { throw 'tar could not make payload.zip.' }
} finally { Pop-Location }
Move-Item -LiteralPath (Join-Path $Stage 'payload.zip') -Destination $payload

Copy-Tree (Join-Path $PSScriptRoot 'scripts') (Join-Path $OutDir 'scripts')
foreach ($f in @('INSTALL.bat', 'UPDATE.bat', 'UNINSTALL.bat', 'CHECK.bat', 'README-FIRST.txt', 'INSTALL-DAY-CHECKLIST.md', 'OFFICE-GUIDE.md')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination $OutDir
}

# The icon: the CCS logo as a 256 px PNG inside an .ico.
Add-Type -AssemblyName System.Drawing
$logo = [System.Drawing.Image]::FromFile((Join-Path $Repo 'client\public\ccs-logo.png'))
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::White)
$g.DrawImage($logo, 0, 0, 256, 256)
$g.Dispose(); $logo.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
$png = $ms.ToArray()
$ico = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($ico)
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)
$w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)
$w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$png.Length); $w.Write([UInt32]22)
$w.Write($png); $w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $OutDir 'scripts\intellisched.ico'), $ico.ToArray())

# The practice data (deploy\build-practice-data.js writes it into .deploy-out\cache\practice\).
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'data') | Out-Null
$practiceDir = Join-Path $Cache 'practice'
if (Test-Path -LiteralPath (Join-Path $practiceDir 'practice.isbak')) {
    Copy-Item -LiteralPath (Join-Path $practiceDir 'practice.isbak') -Destination (Join-Path $OutDir 'data')
    Copy-Item -LiteralPath (Join-Path $practiceDir 'PRACTICE-SIGN-IN.txt') -Destination $OutDir
} else {
    Write-Log 'WARNING: no practice data yet (run deploy\build-practice-data.js); the kit has no data\practice.isbak' 'Yellow'
}

# ---------------------------------------------------------------- 6. the Office kit, kit-manifest.json
function Write-KitManifest([string]$Folder, [string]$Kind) {
    $files = @()
    foreach ($f in (Get-ChildItem -LiteralPath $Folder -Recurse -File)) {
        $rel = $f.FullName.Substring($Folder.Length + 1)
        $files += [ordered]@{ path = $rel; size = $f.Length; sha256 = (Get-Sha256 $f.FullName) }
    }
    $total = [long]0
    foreach ($f in $files) { $total += [long]$f.size }
    $manifest = [ordered]@{
        app = 'IntelliSched'
        kind = $Kind
        version = $version
        gatewayVersion = $pkg.version
        commit = $commit
        builtAt = (Get-Date).ToString('o')
        runtimes = $runtimes
        pythonPackages = [ordered]@{
            requirements = 'app\backend\requirements.txt (deploy\kit-requirements.txt)'
            wheels = @($wheels | ForEach-Object { [ordered]@{ file = $_.Name; sha256 = (Get-Sha256 $_.FullName) } })
            leftOut = @('matplotlib (ml/train_eval.py only)', 'shap (evaluation only)', 'pytest, httpx (tests only)', 'python-docx (evaluation only)', 'openpyxl (listed in requirements.txt, never imported by the service)')
            numpyNote = 'numpy 2.5.3 as in the service .venv: requirements.txt pins 1.26.4, which cannot load the model (docs/SETUP_LAPTOP.md)'
        }
        files = $files
        totalBytes = $total
    }
    Write-Json (Join-Path $Folder 'kit-manifest.json') $manifest
    return $total
}

# The Office kit: a copy of the kit, without the practice data, with the handover and training files.
$officeMade = $false
if (-not $PracticeOnly) {
    if (-not $HandoverDir) { $HandoverDir = Join-Path $DeployOut 'handover' }
    $hIsbak = Join-Path $HandoverDir 'handover.isbak'
    $hEnc = Join-Path $HandoverDir 'handover-training.enc'
    if ((Test-Path -LiteralPath $hIsbak) -and (Test-Path -LiteralPath $hEnc)) {
        if (-not $OfficeOutDir) { $OfficeOutDir = Join-Path $DeployOut ('IntelliSched-Office-Kit-' + $version) }
        Assert-NotSynced $OfficeOutDir
        if (Test-Path -LiteralPath $OfficeOutDir) { Remove-Item -LiteralPath $OfficeOutDir -Recurse -Force }
        Write-Log ('Office kit -> ' + $OfficeOutDir)
        Copy-Tree $OutDir $OfficeOutDir
        Remove-Item -LiteralPath (Join-Path $OfficeOutDir 'data\practice.isbak'), (Join-Path $OfficeOutDir 'PRACTICE-SIGN-IN.txt') -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path (Join-Path $OfficeOutDir 'data') | Out-Null
        Copy-Item -LiteralPath $hIsbak, $hEnc -Destination (Join-Path $OfficeOutDir 'data')
        $officeTotal = Write-KitManifest $OfficeOutDir 'office'
        $officeMade = $true
    } else {
        Write-Log ('WARNING: no handover in ' + $HandoverDir + ' (deploy\make-handover.ps1 makes it); only the Practice kit was built' ) 'Yellow'
    }
}

Assert-NoHandover $OutDir
$total = Write-KitManifest $OutDir 'practice'
Remove-Item -LiteralPath $Stage -Recurse -Force
Write-Log ('Practice kit ready: ' + $OutDir + ' (' + [math]::Round($total / 1MB) + ' MB)') 'Green'
if ($officeMade) { Write-Log ('Office kit ready: ' + $OfficeOutDir + ' (' + [math]::Round($officeTotal / 1MB) + ' MB)') 'Green' }
