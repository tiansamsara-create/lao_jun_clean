Add-Type -AssemblyName System.Drawing

$outputDir = Join-Path $PSScriptRoot '..\build'
$pngPath = Join-Path $outputDir 'icon.png'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$rect = New-Object System.Drawing.Rectangle 18, 18, 220, 220
$radius = 48
$backgroundPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$backgroundPath.AddArc($rect.X, $rect.Y, $radius, $radius, 180, 90)
$backgroundPath.AddArc($rect.Right - $radius, $rect.Y, $radius, $radius, 270, 90)
$backgroundPath.AddArc($rect.Right - $radius, $rect.Bottom - $radius, $radius, $radius, 0, 90)
$backgroundPath.AddArc($rect.X, $rect.Bottom - $radius, $radius, $radius, 90, 90)
$backgroundPath.CloseFigure()

$startColor = [System.Drawing.Color]::FromArgb(255, 33, 92, 225)
$endColor = [System.Drawing.Color]::FromArgb(255, 75, 143, 255)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $startColor, $endColor, 45
$graphics.FillPath($brush, $backgroundPath)

$shineBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(28, 255, 255, 255))
$graphics.FillEllipse($shineBrush, 112, -18, 190, 190)

$bolt = New-Object System.Drawing.Drawing2D.GraphicsPath
[System.Drawing.PointF[]]$points = @(
  (New-Object System.Drawing.PointF 143, 53),
  (New-Object System.Drawing.PointF 79, 143),
  (New-Object System.Drawing.PointF 122, 143),
  (New-Object System.Drawing.PointF 103, 205),
  (New-Object System.Drawing.PointF 180, 113),
  (New-Object System.Drawing.PointF 137, 113)
)
$bolt.AddPolygon($points)
$boltBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$graphics.FillPath($boltBrush, $bolt)

$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$boltBrush.Dispose()
$bolt.Dispose()
$shineBrush.Dispose()
$brush.Dispose()
$backgroundPath.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output $pngPath
