"""从默认外形生成 Windows 图标（多尺寸 .ico）。可重复运行。

用法： python tools/make-icon.py
产出： assets/deskpet.ico（16/24/32/48/64/128），桌面快捷方式用它当图标。
"""
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "packs" / "cat-default" / "preview-wave.png"
OUT = ROOT / "assets" / "deskpet.ico"
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128)]


def main() -> int:
    if not SRC.exists():
        print("source frame missing:", SRC)
        print("run it first: python tools/make-default-skin.py")
        return 1

    img = Image.open(SRC).convert("RGBA")
    box = img.getbbox()
    if box:
        img = img.crop(box)  # 去掉透明边，避免小尺寸下图案偏小

    # 放进正方形画布并留 6% 边距：Windows 各视图下都不会贴边裁切
    side = max(img.width, img.height)
    canvas_side = 128
    scale = (canvas_side * 0.94) / side
    resized = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    canvas.paste(resized, ((canvas_side - resized.width) // 2, (canvas_side - resized.height) // 2), resized)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT, format="ICO", sizes=SIZES)

    with Image.open(OUT) as check:
        got = sorted(check.info.get("sizes", []))
    print("source :", SRC.name, img.size)
    print("written:", OUT)
    print("sizes  :", ", ".join("%dx%d" % s for s in got))
    if len(got) < len(SIZES):
        print("WARNING: fewer sizes than requested")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
