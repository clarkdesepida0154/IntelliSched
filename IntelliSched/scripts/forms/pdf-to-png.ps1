# Renders every page of a PDF to PNG with Windows' own PDF engine (WinRT Windows.Data.Pdf), the way
# Phase 8 Part 3 measured the SF-029 scans: no new package, nothing installed.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/forms/pdf-to-png.ps1 -Pdf <file> -OutDir <folder> [-Dpi 300]
# Writes <OutDir>/page-01.png, page-02.png, ... and prints one line per page.
param([Parameter(Mandatory = $true)][string]$Pdf, [Parameter(Mandatory = $true)][string]$OutDir, [int]$Dpi = 300)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, [Type]$type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
function AwaitAction($op) { $t = $asTaskAction.Invoke($null, @($op)); $t.Wait(-1) | Out-Null }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$sizes = @()
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $Pdf).Path)) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
for ($i = 0; $i -lt $doc.PageCount; $i++) {
  $page = $doc.GetPage($i)
  $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $opts.DestinationWidth = [uint32][math]::Round($page.Size.Width / 96.0 * $Dpi)
  $opts.DestinationHeight = [uint32][math]::Round($page.Size.Height / 96.0 * $Dpi)
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  AwaitAction ($page.RenderToStreamAsync($stream, $opts))
  $out = Join-Path $OutDir ('page-{0:D2}.png' -f ($i + 1))
  $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))
  $sizes += ('{{"file":"{0}","widthMm":{1},"heightMm":{2}}}' -f ('page-{0:D2}.png' -f ($i + 1)), [math]::Round($page.Size.Width / 96.0 * 25.4, 2), [math]::Round($page.Size.Height / 96.0 * 25.4, 2))
  $fs = [System.IO.File]::Create($out); $net.CopyTo($fs); $fs.Close(); $net.Close(); $stream.Dispose(); $page.Dispose()
  Write-Output $out
}
# The pages' sizes in mm (the PNG's pixels follow the display scaling, so the measurer divides by these).
[System.IO.File]::WriteAllText((Join-Path $OutDir 'pages.json'), '[' + ($sizes -join ',') + ']')
