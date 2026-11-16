# Phase 8 Part 9 (decision 7): one picture of several page images side by side, each under a caption,
# made with Windows' own System.Drawing (no package). The office's form, the system's PDF and Word's PDF.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/forms/side-by-side.ps1 -Out <png> -Images "a.png|b.png|c.png" -Captions "Office|System PDF|Word PDF" [-Height 900]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Images,      # paths separated by |
  [Parameter(Mandatory = $true)][string]$Captions,    # captions separated by |
  [int]$Height = 900
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$imageList = $Images -split '\|'
$captionList = $Captions -split '\|'
$gap = 16
$captionH = 30
$loaded = @()
foreach ($path in $imageList) { $loaded += [System.Drawing.Image]::FromFile((Resolve-Path $path).Path) }
$widths = @()
foreach ($img in $loaded) { $widths += [int][math]::Round($img.Width * $Height / $img.Height) }
$totalW = [int](($widths | Measure-Object -Sum).Sum + $gap * ($loaded.Count + 1))
$bmp = New-Object System.Drawing.Bitmap $totalW, ([int]($Height + $captionH + 2 * $gap))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(236, 236, 236))
$g.InterpolationMode = 'HighQualityBicubic'
$font = New-Object System.Drawing.Font 'Arial', 13, ([System.Drawing.FontStyle]::Bold)
$x = $gap
for ($i = 0; $i -lt $loaded.Count; $i++) {
  $g.DrawString($captionList[$i], $font, [System.Drawing.Brushes]::Black, $x, $gap - 4)
  $g.FillRectangle([System.Drawing.Brushes]::White, $x, $gap + $captionH, $widths[$i], $Height)
  $g.DrawImage($loaded[$i], $x, $gap + $captionH, $widths[$i], $Height)
  $g.DrawRectangle([System.Drawing.Pens]::Gray, $x, $gap + $captionH, $widths[$i], $Height)
  $x += $widths[$i] + $gap
}
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Out))) | Out-Null
$bmp.Save([System.IO.Path]::GetFullPath($Out), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); foreach ($img in $loaded) { $img.Dispose() }
Write-Output $Out
