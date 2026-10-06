# Regenerates the fnOS app icons from fnos/app/ui/images/icon-source.png.
#
# The icon geometry -- opaque white rounded-square background, the corner radius
# shared with every other fnOS app, and the mark scale -- is defined in exactly
# one place: create-icons.py.  This wrapper exists only so the step can be
# invoked the same way on Windows, where the other packaging scripts are run.
# It deliberately contains no drawing code of its own, so the two entry points
# cannot drift apart and silently ship icons that look different from the rest
# of the fnOS desktop.
#
# Requires Python 3 with numpy, the same interpreter already used for
# scripts/repack-windows.py.
$ErrorActionPreference = 'Stop'

$script = Join-Path $PSScriptRoot 'create-icons.py'
if (-not (Test-Path -LiteralPath $script)) {
    Write-Error "Missing $script"
    exit 1
}

$python = if (Get-Command py -ErrorAction SilentlyContinue) { 'py' } else { 'python' }
& $python $script @args
exit $LASTEXITCODE
