# IntelliSched: sets a new password for one account (administrator only; "the Dean forgot his password").
#   Right-click PowerShell -> Run as administrator, then:
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\IntelliSched\scripts\reset-password.ps1
# Lists the accounts (name, e-mail, role, status), asks which one, asks the new password twice (hidden),
# and sets it with the gateway's own hashing. An Audit Trail row records it. No hash is ever printed.
param([string]$Root = '')
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$m = $null
if (Test-Path -LiteralPath (Join-Path $Root 'install-manifest.json')) { $m = Read-Json (Join-Path $Root 'install-manifest.json') }
if (-not $m) { Write-Host 'IntelliSched is not installed here.'; exit 1 }
if (-not $m.portable -and -not (Test-Elevated)) { Write-Host 'Right-click PowerShell and choose Run as administrator, then run this again.'; exit 1 }
Start-KitLog (Join-Path $Root 'logs') 'reset-password'

Write-Log 'The accounts:'
$node = Join-Path $Root 'runtime\node\node.exe'
$lines = & $node (Join-Path $Root 'scripts\reset-password.js') --root $Root --list
if ($LASTEXITCODE -ne 0) { Write-Log 'The accounts could not be read. Is IntelliSched'' database running? Run CHECK.bat.' 'Red'; exit 1 }
$rows = @()
foreach ($l in $lines) {
    $f = $l -split "`t"
    if ($f.Count -ge 5) { $rows += [pscustomobject]@{ N = $f[0]; Name = $f[1]; Email = $f[2]; Role = $f[3]; Status = $f[4] } }
}
$rows | Format-Table -AutoSize | Out-String | Write-Host
$pick = Read-Host 'Number of the account'
$row = $rows | Where-Object { $_.N -eq $pick } | Select-Object -First 1
if (-not $row) { Write-Log 'No such number; nothing was changed.'; exit 1 }
$a = ConvertFrom-SecureText (Read-Host ('New password for ' + $row.Name) -AsSecureString)
$b = ConvertFrom-SecureText (Read-Host 'The same password again' -AsSecureString)
if ($a -ne $b) { Write-Log 'The two passwords are not the same; nothing was changed.' 'Red'; exit 1 }
if ($a.Length -lt 8) { Write-Log 'Use at least 8 characters; nothing was changed.' 'Red'; exit 1 }
$code = Invoke-KitNode $Root 'reset-password.js' @('--set', $row.Email) $a
$a = $null; $b = $null
if ($code -eq 0) { Write-Log ('PASS: the password of ' + $row.Name + ' was changed. Sign in with it now.') 'Green'; exit 0 }
Write-Log 'FAIL: the password was not changed (see above).' 'Red'
exit 1
