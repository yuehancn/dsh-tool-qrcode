"""Verify the plugin's QR symbols two independent ways.

1. Decode with OpenCV's QRCodeDetector (a separate implementation).
2. Re-build the reference `qrcode` library's grid for the same payload, version,
   level AND mask, then diff module by module.

Mask-agnostic comparison of the raw grids would be wrong: the standard's mask is
chosen by a penalty heuristic, and two correct encoders may legitimately choose
different masks. Any mask difference then cascades across the whole data region.
What must match is the underlying codeword stream, so the reference is forced to
the mask the plugin chose and the grids are compared after that.

Usage: verify-qr.py <dir-with-svgs> <expected-json>
"""
import json
import re
import sys
from pathlib import Path

import cv2
import numpy as np
import qrcode
from qrcode.constants import (
    ERROR_CORRECT_H,
    ERROR_CORRECT_L,
    ERROR_CORRECT_M,
    ERROR_CORRECT_Q,
)

MODULE_PATH = re.compile(r"M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z")
FILL = re.compile(r'<path fill="(#[0-9a-fA-F]{6})" d="([^"]*)"')
LEVELS = {
    "L": ERROR_CORRECT_L,
    "M": ERROR_CORRECT_M,
    "Q": ERROR_CORRECT_Q,
    "H": ERROR_CORRECT_H,
}


def grid_of(svg_text):
    """Rebuild the module grid from a plugin-rendered QR SVG."""
    width = int(re.search(r'width="(\d+)"', svg_text).group(1))
    _, data = FILL.search(svg_text).groups()
    boxes = [(int(m.group(1)), int(m.group(2)), int(m.group(3))) for m in MODULE_PATH.finditer(data)]
    step = boxes[0][2]
    size = width // step - 8
    grid = [[0] * size for _ in range(size)]
    for x, y, unit in boxes:
        grid[y // unit - 4][x // unit - 4] = 1
    return grid


def read_mask(grid):
    """Recover the mask index from a symbol's format-information strip."""
    size = len(grid)
    word = 0
    for i in range(15):
        row = i if i < 6 else (i + 1 if i < 8 else size - 15 + i)
        if grid[row][8]:
            word |= 1 << i
    for mask in range(8):
        # Level L code is 1; the plugin writes L in these tests.
        if qrcode.util.BCH_type_info(1 << 3 | mask) == word:
            return mask
    return None


directory = Path(sys.argv[1])
expected = json.loads((directory / "expected.json").read_text(encoding="utf8"))
meta = json.loads((directory / "meta.json").read_text(encoding="utf8"))

detector = cv2.QRCodeDetector()
decode_failures, grid_failures = [], []

for name, want in sorted(expected.items()):
    text = (directory / name).read_text(encoding="utf8")
    grid = grid_of(text)
    size = len(grid)
    version = (size - 17) // 4
    level = meta[name]["level"]
    mask = read_mask(grid)

    # --- independent decode ---
    canvas = np.full((size + 8, size + 8), 255, dtype=np.uint8)
    for r in range(size):
        for c in range(size):
            if grid[r][c]:
                canvas[r + 4, c + 4] = 0
    canvas = cv2.resize(canvas, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
    decoded, points, _ = detector.detectAndDecode(canvas)
    decode_ok = decoded == want

    # --- grid diff against the reference, forced to our mask ---
    ref = qrcode.QRCode(version=version, error_correction=LEVELS[level], border=0)
    ref.add_data(want)
    ref.make(fit=False)
    if mask is not None:
        ref.makeImpl(False, mask)
    theirs = [[1 if cell else 0 for cell in row] for row in ref.modules]
    diff = sum(1 for r in range(size) for c in range(size) if grid[r][c] != theirs[r][c])
    grid_ok = diff == 0

    if not decode_ok:
        decode_failures.append((name, size, points is not None))
    if not grid_ok:
        grid_failures.append((name, diff, size))

    status = "ok  " if grid_ok else "FAIL"
    print(f"{status}  {name:12} v{version:<2} L{level} mask={mask}  {size:>2}x{size:<2}  "
          f"grid-diff={diff:>4}  opencv-decoded={decode_ok}")

print()
print(f"grid matches reference (same mask): {len(expected) - len(grid_failures)}/{len(expected)}")
print(f"decoded by OpenCV:                  {len(expected) - len(decode_failures)}/{len(expected)}")
for name, diff, size in grid_failures:
    print(f"  GRID MISMATCH {name}: {diff}/{size * size} modules differ")
for name, size, detected in decode_failures:
    print(f"  OpenCV could not decode: {name} ({size}x{size}, detected={detected})"
          + ("" if name in [g[0] for g in grid_failures] else " — grid is correct, decoder limitation"))

sys.exit(1 if grid_failures else 0)