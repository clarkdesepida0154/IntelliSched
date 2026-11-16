# Phase 8 Part 9 (decision 7): Word's own rendering of a generated DOCX, saved as PDF, with Word's page
# count. Word is opened through COM, invisible and read-only, and only the Word this script started is
# closed. If Word is already running (it could be the team's open work), nothing is touched: the
# script says so and exits with code 3. Never saves over a file: the DOCX is opened read-only and the
# PDF goes to the path given (refused if it exists).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/forms/word-to-pdf.ps1 -Docx <in.docx> -Pdf <out.pdf>
# Prints one line: PAGES <n>
param([Parameter(Mandatory = $true)][string]$Docx, [Parameter(Mandatory = $true)][string]$Pdf)
$ErrorActionPreference = 'Stop'
if (Get-Process -Name WINWORD -ErrorAction SilentlyContinue) {
  Write-Output 'SKIPPED Word is already running (it could be someone''s open work), so the Word check was skipped. Close Word and run npm run forms:word-check.'
  exit 3
}
$in = (Resolve-Path $Docx).Path
$out = [System.IO.Path]::GetFullPath($Pdf)
if (Test-Path $out) { Write-Output "REFUSED $out exists; nothing was overwritten."; exit 4 }
try { $word = New-Object -ComObject Word.Application } catch { Write-Output 'NOWORD Microsoft Word is not installed on this computer.'; exit 5 }
$started = Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
  $doc = $word.Documents.Open($in, $false, $true, $false)
  $doc.Repaginate()
  $pages = $doc.ComputeStatistics(2)
  # 17 = wdExportFormatPDF
  $doc.ExportAsFixedFormat($out, 17)
  $doc.Close(0)
  Write-Output "PAGES $pages"
} finally {
  try { $word.Quit(0) } catch { }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
  Start-Sleep -Milliseconds 500
  foreach ($id in $started) { Get-Process -Id $id -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
}
