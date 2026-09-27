Add-Type -AssemblyName System.Drawing
$appRoot = Join-Path $PSScriptRoot '..\fnos'
$iconRoot = Join-Path $appRoot 'app\ui\images'
$source = Join-Path $iconRoot 'icon-source.png'
$image = [System.Drawing.Image]::FromFile($source)

try {
    foreach ($size in @(64, 256)) {
        $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($image, [System.Drawing.Rectangle]::new(0, 0, $size, $size))
            $bitmap.Save((Join-Path $iconRoot "icon_$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
            $name = if ($size -eq 256) { 'ICON_256.PNG' } else { 'ICON.PNG' }
            $bitmap.Save((Join-Path $appRoot $name), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
} finally {
    $image.Dispose()
}
