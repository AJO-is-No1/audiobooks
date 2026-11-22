# Renders the app icons (PNG) with System.Drawing. Run from the app folder:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force $out | Out-Null

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Make-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 46, 34, 25)), ([System.Drawing.Color]::FromArgb(255, 20, 17, 14)), 90
  $g.FillRectangle($bg, $rect)

  $s = $size / 512.0
  $amber = [System.Drawing.Color]::FromArgb(255, 241, 165, 91)
  $cream = [System.Drawing.Color]::FromArgb(255, 243, 238, 231)

  # microphone capsule
  $cap = New-RoundRect (206 * $s) (92 * $s) (100 * $s) (196 * $s) (50 * $s)
  $g.FillPath((New-Object System.Drawing.SolidBrush $amber), $cap)

  # cradle, stem and base
  $pen = New-Object System.Drawing.Pen $cream, ([float](24 * $s))
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $g.DrawArc($pen, [float](160 * $s), [float](134 * $s), [float](192 * $s), [float](192 * $s), [float]0, [float]180)
  $g.DrawLine($pen, [float](256 * $s), [float](326 * $s), [float](256 * $s), [float](396 * $s))
  $g.DrawLine($pen, [float](200 * $s), [float](400 * $s), [float](312 * $s), [float](400 * $s))

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose(); $g.Dispose(); $bmp.Dispose()
}

Make-Icon 180 (Join-Path $out 'icon-180.png')
Make-Icon 192 (Join-Path $out 'icon-192.png')
Make-Icon 512 (Join-Path $out 'icon-512.png')
Write-Output "Icons written to $out"
