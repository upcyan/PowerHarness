#!/usr/bin/env python3
"""Generate the fnOS app icons from ``fnos/app/ui/images/icon-source.png``.

The FPK icon must look like the other fnOS apps: a shape that fills the whole
canvas, with the rounded corners baked into the alpha channel and the outer
area fully transparent.  fnOS does not clip app icons itself, so an icon
shipped with a transparent background (as this project originally did) is drawn
as a bare glyph and stands out from every neighbouring app.

Measured from the icons installed under ``/usr/trim/www/static/app/icons/`` and
from other FPK apps under ``/vol1/@appcenter/*/ui/images/``, the corner radius is
a constant fraction of the icon size -- the 224, 272, 112 and 256 px families all
land on 0.2518 (third-party ``trim.hermes`` at 256 px measures 0.2516).  That
constant is shared by this generator and ``create-icons.ps1``.

Outputs, all from the same source and geometry:

    fnos/app/ui/images/icon_64.png     fnos/ICON.PNG        (64x64)
    fnos/app/ui/images/icon_256.png    fnos/ICON_256.PNG    (256x256)

``fnos/app/ui/config`` references ``images/icon_{0}.png`` for in-app use, while
the two ``ICON*.PNG`` files at the FPK root are what the fnOS desktop shows.
"""

from __future__ import annotations

import argparse
import math
import pathlib
import struct
import sys
import zlib

import numpy as np

# Corner radius as a fraction of the icon edge.  Measured from fnOS's own app
# icons; keep in sync with create-icons.ps1.
CORNER_RADIUS_RATIO = 0.2518

# Longest edge of the logo, as a fraction of the icon edge.  Small enough to
# stay clear of the rounded corners (which start at 0.074 * size) with a margin
# that matches the padding fnOS's own icons leave around their glyph.
LOGO_SCALE = 0.70

# Render the icon at this multiple of the target size and box-filter down.  This
# gives both the rounded corners and the logo placement sub-pixel accuracy.
SUPERSAMPLE = 4


def read_png(path: pathlib.Path) -> np.ndarray:
    """Decode an 8-bit non-interlaced PNG into a float RGBA array in [0, 1]."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: not a PNG")

    pos, idat, palette = 8, bytearray(), None
    width = height = depth = colour = None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
            if depth != 8:
                raise ValueError(f"{path}: only 8-bit channels are supported")
            if interlace:
                raise ValueError(f"{path}: interlaced PNGs are not supported")
        elif kind == b"IDAT":
            idat += chunk
        elif kind == b"PLTE":
            palette = chunk
        elif kind == b"IEND":
            break
        pos += 12 + length

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour]
    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    out = np.empty((height, stride), dtype=np.uint8)
    prior = np.zeros(stride, dtype=np.uint8)
    offset = 0
    for y in range(height):
        method = raw[offset]
        line = np.frombuffer(raw, dtype=np.uint8, count=stride, offset=offset + 1)
        offset += 1 + stride
        line = line.copy()
        if method == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (int(line[i]) + int(line[i - channels])) & 0xFF
        elif method == 2:  # Up
            line = (line.astype(np.uint16) + prior).astype(np.uint8)
        elif method == 3:  # Average
            for i in range(stride):
                left = int(line[i - channels]) if i >= channels else 0
                line[i] = (int(line[i]) + ((left + int(prior[i])) >> 1)) & 0xFF
        elif method == 4:  # Paeth
            for i in range(stride):
                left = int(line[i - channels]) if i >= channels else 0
                up = int(prior[i])
                upleft = int(prior[i - channels]) if i >= channels else 0
                estimate = left + up - upleft
                pa, pb, pc = (
                    abs(estimate - left),
                    abs(estimate - up),
                    abs(estimate - upleft),
                )
                if pa <= pb and pa <= pc:
                    predict = left
                elif pb <= pc:
                    predict = up
                else:
                    predict = upleft
                line[i] = (int(line[i]) + predict) & 0xFF
        elif method != 0:
            raise ValueError(f"{path}: unknown filter {method}")
        out[y] = line
        prior = line
    out = out.reshape(height, width, channels).astype(np.float64) / 255.0

    if colour == 6:
        return out
    if colour == 2:
        return np.dstack([out, np.ones((height, width, 1))])
    if colour == 0:
        return np.dstack([np.repeat(out, 3, axis=2), np.ones((height, width, 1))])
    if colour == 4:
        return np.dstack([np.repeat(out[:, :, :1], 3, axis=2), out[:, :, 1:]])
    if colour == 3 and palette is not None:
        table = np.frombuffer(palette, dtype=np.uint8).reshape(-1, 3) / 255.0
        rgb = table[out[:, :, 0].astype(np.int32)]
        return np.dstack([rgb, np.ones((height, width, 1))])
    raise ValueError(f"{path}: unsupported colour type {colour}")


def write_png(path: pathlib.Path, rgba: np.ndarray) -> None:
    """Encode a float RGBA array in [0, 1] as an 8-bit RGBA PNG."""
    height, width, _ = rgba.shape
    pixels = np.clip(np.rint(rgba * 255.0), 0, 255).astype(np.uint8)

    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter: None
        raw += pixels[y].tobytes()

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    blob = b"\x89PNG\r\n\x1a\n"
    blob += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    blob += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    blob += chunk(b"IEND", b"")
    path.write_bytes(blob)


def lanczos_weights(src_len: int, dst_len: int, lobes: float = 3.0) -> np.ndarray:
    """Separable Lanczos resampling weights, widened when downscaling."""
    scale = dst_len / src_len
    widen = max(1.0, 1.0 / scale)
    support = lobes * widen
    centres = (np.arange(dst_len) + 0.5) / scale - 0.5
    weights = np.zeros((dst_len, src_len), dtype=np.float64)
    for i, centre in enumerate(centres):
        lo = max(int(math.ceil(centre - support)), 0)
        hi = min(int(math.floor(centre + support)), src_len - 1)
        if hi < lo:
            weights[i, min(max(int(round(centre)), 0), src_len - 1)] = 1.0
            continue
        distance = np.arange(lo, hi + 1) - centre
        u = distance / widen
        kernel = np.sinc(u) * np.sinc(u / lobes)
        kernel[np.abs(u) >= lobes] = 0.0
        total = kernel.sum()
        if total != 0:
            kernel = kernel / total
        weights[i, lo : hi + 1] = kernel
    return weights


def resize(image: np.ndarray, width: int, height: int) -> np.ndarray:
    """Resample an HxWxC float array with a separable Lanczos-3 filter."""
    if image.shape[0] == height and image.shape[1] == width:
        return image
    horizontal = lanczos_weights(image.shape[1], width)
    vertical = lanczos_weights(image.shape[0], height)
    out = np.tensordot(horizontal, image, axes=([1], [1]))
    out = np.tensordot(vertical, out, axes=([1], [1]))
    return out


def rounded_mask(size: int, radius: float) -> np.ndarray:
    """Analytic anti-aliased coverage of a rounded square that fills the canvas.

    Uses the standard rounded-box signed distance: the box has half-extent
    ``size/2`` with the corners replaced by arcs of ``radius``, so the shape
    spans the whole canvas with all four corners rounded equally.

    The obvious-looking alternative -- clamping a single corner's offsets at
    zero, ``max(radius - x, 0)`` -- silently rounds only the top-left: for the
    other three corners one offset stays zero, the signed distance comes out
    negative, and they render square. All four corners must be symmetric.
    """
    ys, xs = np.mgrid[0:size, 0:size]
    px, py = xs + 0.5, ys + 0.5
    half = size / 2.0
    # Distance from each pixel centre to the inset box, per axis.
    qx = np.abs(px - half) - (half - radius)
    qy = np.abs(py - half) - (half - radius)
    outside = np.sqrt(np.maximum(qx, 0.0) ** 2 + np.maximum(qy, 0.0) ** 2)
    inside = np.minimum(np.maximum(qx, qy), 0.0)
    return np.clip(0.5 - (outside + inside - radius), 0.0, 1.0)


def build_icon(
    logo: np.ndarray, size: int, background: tuple[float, float, float]
) -> np.ndarray:
    """Composite the logo over an opaque rounded background at ``size`` px."""
    hi = size * SUPERSAMPLE
    radius = CORNER_RADIUS_RATIO * size

    # The source logo is transparent outside its glyph, so crop it first: that
    # makes LOGO_SCALE a statement about the visible mark, not about whatever
    # padding the artwork happens to carry.
    alpha = logo[:, :, 3]
    rows = np.where(alpha.max(axis=1) > 0.02)[0]
    cols = np.where(alpha.max(axis=0) > 0.02)[0]
    if not len(rows) or not len(cols):
        raise ValueError("icon source has no visible pixels")
    cropped = logo[rows[0] : rows[-1] + 1, cols[0] : cols[-1] + 1]

    # Scale so the longest edge of the mark covers LOGO_SCALE of the icon.
    src_h, src_w = cropped.shape[:2]
    if src_w >= src_h:
        logo_w = LOGO_SCALE * hi
        logo_h = logo_w * src_h / src_w
    else:
        logo_h = LOGO_SCALE * hi
        logo_w = logo_h * src_w / src_h
    logo_w, logo_h = max(int(round(logo_w)), 1), max(int(round(logo_h)), 1)

    # Resample in premultiplied alpha so the transparent surround cannot bleed
    # dark fringes into the mark.
    premultiplied = np.dstack(
        [cropped[:, :, :3] * cropped[:, :, 3:4], cropped[:, :, 3:4]]
    )
    mark = resize(premultiplied, logo_w, logo_h)
    mark = np.clip(mark, 0.0, 1.0)

    canvas = np.zeros((hi, hi, 4), dtype=np.float64)
    x0 = (hi - logo_w) // 2
    y0 = (hi - logo_h) // 2
    canvas[y0 : y0 + logo_h, x0 : x0 + logo_w] = mark

    mark_rgb, mark_a = canvas[:, :, :3], canvas[:, :, 3:4]
    mask = rounded_mask(hi, radius * SUPERSAMPLE)[:, :, None]
    backdrop = np.array(background, dtype=np.float64).reshape(1, 1, 3)

    # Background under mark: premultiplied output plus the combined alpha.
    out_rgb = mark_rgb + backdrop * mask * (1.0 - mark_a)
    out_a = mark_a + mask * (1.0 - mark_a)

    composited = np.dstack([out_rgb, out_a])
    # Box-filter the supersampled render down to the requested size.  Filtering
    # while still premultiplied is what keeps the corner coverage correct.
    composited = composited.reshape(
        size, SUPERSAMPLE, size, SUPERSAMPLE, 4
    ).mean(axis=(1, 3))

    # PNG stores straight (non-premultiplied) alpha, so undo the premultiply the
    # compositing above relies on.  Skipping this encodes the corner coverage
    # into RGB as well, which renders the anti-aliased edge grey instead of
    # white -- visible as a dirty fringe against the fnOS desktop.
    alpha = composited[:, :, 3:4]
    rgb = np.divide(
        composited[:, :, :3],
        alpha,
        out=np.zeros_like(composited[:, :, :3]),
        where=alpha > 0.0,
    )
    return np.dstack([np.clip(rgb, 0.0, 1.0), alpha])


def main(argv: list[str] | None = None) -> int:
    root = pathlib.Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--source",
        type=pathlib.Path,
        default=root / "fnos" / "app" / "ui" / "images" / "icon-source.png",
        help="master artwork (default: fnos/app/ui/images/icon-source.png)",
    )
    parser.add_argument(
        "--app-root",
        type=pathlib.Path,
        default=root / "fnos",
        help="fnOS app tree to write ICON.PNG / ICON_256.PNG into",
    )
    parser.add_argument(
        "--outdir",
        type=pathlib.Path,
        default=None,
        help="write every icon into this directory instead of the app tree",
    )
    parser.add_argument(
        "--background",
        default="255,255,255",
        help="opaque background colour as R,G,B (default: 255,255,255)",
    )
    args = parser.parse_args(argv)

    background = tuple(
        int(part) / 255.0 for part in args.background.split(",")
    )
    if len(background) != 3:
        parser.error("--background must be R,G,B")

    logo = read_png(args.source)
    images_dir = args.outdir or (args.app_root / "app" / "ui" / "images")
    images_dir.mkdir(parents=True, exist_ok=True)
    if args.outdir is None:
        args.app_root.mkdir(parents=True, exist_ok=True)

    for size in (64, 256):
        icon = build_icon(logo, size, background)
        write_png(images_dir / f"icon_{size}.png", icon)
        if args.outdir is None:
            # fnOS looks for ICON.PNG (64 px) and ICON_256.PNG at the FPK root.
            name = "ICON_256.PNG" if size == 256 else "ICON.PNG"
            write_png(args.app_root / name, icon)
        print(f"icon_{size}.png  ({size}x{size}, R={CORNER_RADIUS_RATIO * size:.1f}px)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
