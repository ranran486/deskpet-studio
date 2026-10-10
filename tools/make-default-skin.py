#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the builtin deskpet skin pack: art (PNG) + data (JSON), then verify it.

Everything is drawn from code with Pillow -- no external assets. The cat is drawn on a
4x supersampled canvas and downsampled with LANCZOS, which anti-aliases both fills and
outlines.

Outputs (all overwritten, so re-running is idempotent and byte-stable):
    packs/cat-default/spritesheet.png    横向排列, 25 帧 x 128px
    packs/cat-default/atlas.json
    packs/cat-default/states.json
    packs/cat-default/preview-{idle,wave,talk,drag}.png
    packs/cat-actions/states.json

It also re-reads plugin.json / tokens.json and runs the hard checks, printing PASS/FAIL.

Usage:  E:\\python\\python.exe deskpet\\tools\\make-default-skin.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

try:  # Windows console defaults to GBK; keep all output ASCII-safe anyway.
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover
    pass

LANCZOS = getattr(Image, "Resampling", Image).LANCZOS

ROOT = Path(__file__).resolve().parent.parent  # .../deskpet
SKIN_DIR = ROOT / "packs" / "cat-default"
ACTION_DIR = ROOT / "packs" / "cat-actions"
THEME_DIR = ROOT / "packs" / "bubble-default"

FRAME = 128          # single frame size, px
SS = 4               # supersample factor
CANVAS = FRAME * SS
Y_OFF = -6.0         # shift the whole cat up so it is visually centred in the frame

# ---------------------------------------------------------------- palette ----
FUR_TOP = (255, 228, 186)
FUR_BOT = (246, 176, 106)
HEAD_TOP = (255, 233, 196)
HEAD_BOT = (247, 183, 114)
OUTLINE = (186, 110, 52)
TAIL_TOP = (252, 199, 143)
TAIL_BOT = (238, 152, 90)
CREAM = (255, 248, 238)
CREAM_LINE = (226, 196, 164)
EAR_INNER = (255, 172, 176)
BLUSH = (255, 146, 166)
STRIPE = (228, 148, 80)
EYE = (58, 47, 66)
EYE_WHITE = (255, 253, 248)
NOSE = (240, 130, 150)
MOUTH_IN = (198, 79, 90)
TONGUE = (255, 150, 160)
WHISKER = (214, 160, 112)
ZZZ = (136, 158, 200)

OW_MAIN = 1.35       # outline width, design units (1 design unit = 1 px at 128)
OW_DETAIL = 0.85


# ------------------------------------------------------------- geometry ------
def X(v: float) -> float:
    return v * SS


def Y(v: float) -> float:
    return (v + Y_OFF) * SS


def XY(x: float, y: float):
    return (X(x), Y(y))


def B(x0: float, y0: float, x1: float, y1: float):
    return (X(x0), Y(y0), X(x1), Y(y1))


def W(v: float) -> int:
    """Line width in supersampled pixels."""
    return max(1, int(round(v * SS)))


def rot(p, o, deg):
    a = math.radians(deg)
    dx, dy = p[0] - o[0], p[1] - o[1]
    return (o[0] + dx * math.cos(a) - dy * math.sin(a),
            o[1] + dx * math.sin(a) + dy * math.cos(a))


def new_layer():
    return Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))


def empty_mask():
    return Image.new("L", (CANVAS, CANVAS), 0)


def vgrad(w, h, top, bottom, alpha=255):
    w, h = max(1, int(w)), max(1, int(h))
    img = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(img)
    for i in range(h):
        t = i / max(1, h - 1)
        c = tuple(int(round(top[k] + (bottom[k] - top[k]) * t)) for k in range(3)) + (alpha,)
        d.line([(0, i), (w, i)], fill=c)
    return img


def paint_gradient(base, mask, bbox, top, bottom):
    """Fill the region selected by L-mode `mask` with a vertical gradient."""
    x0, y0, x1, y1 = (int(round(v)) for v in bbox)
    w, h = x1 - x0 + 1, y1 - y0 + 1
    base.paste(vgrad(w, h, top, bottom), (x0, y0), mask.crop((x0, y0, x0 + w, y0 + h)))


def clip_composite(base, layer, mask):
    """Composite RGBA `layer` onto `base`, restricted to L-mode `mask`."""
    tmp = layer.copy()
    tmp.putalpha(ImageChops.multiply(layer.getchannel("A"), mask))
    base.alpha_composite(tmp)


def paint_ellipse(base, b, top, bottom, outline_w=OW_MAIN):
    m = empty_mask()
    ImageDraw.Draw(m).ellipse(b, fill=255)
    paint_gradient(base, m, (b[0] - 2, b[1] - 2, b[2] + 2, b[3] + 2), top, bottom)
    if outline_w > 0:
        ImageDraw.Draw(base).ellipse(b, outline=OUTLINE, width=W(outline_w))
    return m


def paint_poly(base, pts, top, bottom, outline_w=OW_MAIN):
    m = empty_mask()
    ImageDraw.Draw(m).polygon(pts, fill=255)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    paint_gradient(base, m, (min(xs) - 2, min(ys) - 2, max(xs) + 2, max(ys) + 2), top, bottom)
    if outline_w > 0:
        ImageDraw.Draw(base).line(list(pts) + [pts[0]], fill=OUTLINE,
                                 width=W(outline_w), joint="curve")
    return m


def soft_ellipse(base, cx, cy, rx, ry, color, alpha, mask=None):
    lay = new_layer()
    ImageDraw.Draw(lay).ellipse(B(cx - rx, cy - ry, cx + rx, cy + ry), fill=color + (alpha,))
    if mask is not None:
        clip_composite(base, lay, mask)
    else:
        base.alpha_composite(lay)


# ---------------------------------------------------------------- parts ------
def draw_tail(base, angle):
    """Tapered tail: a quadratic bezier stroked with shrinking circles.

    The outline is a second, fatter pass of the same circles drawn underneath, so the
    tapered stroke gets a clean constant-width border with no interior seams.
    """
    origin = (84.0, 102.0)
    p0 = origin
    p1 = rot((106.0, 100.0), origin, angle)
    p2 = rot((109.5, 58.0), origin, angle)
    n = 18
    pts = []
    for i in range(n):
        t = i / (n - 1)
        a, b = (1 - t) ** 2, 2 * (1 - t) * t
        c = t * t
        pts.append((a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1], 8.6 - 4.4 * t))

    d = ImageDraw.Draw(base)
    for (x, y, r) in pts:  # outline pass
        d.ellipse(B(x - r - OW_MAIN, y - r - OW_MAIN, x + r + OW_MAIN, y + r + OW_MAIN),
                  fill=OUTLINE)
    m = empty_mask()
    md = ImageDraw.Draw(m)
    for (x, y, r) in pts:
        md.ellipse(B(x - r, y - r, x + r, y + r), fill=255)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    r0 = max(p[2] for p in pts)
    paint_gradient(base, m, (X(min(xs) - r0) - 2, Y(min(ys) - r0) - 2,
                             X(max(xs) + r0) + 2, Y(max(ys) + r0) + 2), TAIL_TOP, TAIL_BOT)


def draw_ear(base, side, flatten):
    """Triangular ear. `side` -1 = viewer left, +1 = viewer right."""
    f = flatten
    pts = [
        XY(64 + side * 26.0, 42.0),
        XY(64 + side * (31.0 + 8.0 * f), 16.0 + 13.0 * f),
        XY(64 + side * 6.0, 30.0),
    ]
    paint_poly(base, pts, HEAD_TOP, HEAD_BOT)
    # inner ear: shrink towards the centroid
    cx = sum(p[0] for p in pts) / 3
    cy = sum(p[1] for p in pts) / 3
    inner = [(cx + (p[0] - cx) * 0.48, cy + (p[1] - cy) * 0.48) for p in pts]
    m = empty_mask()
    ImageDraw.Draw(m).polygon(inner, fill=255)
    lay = new_layer()
    ImageDraw.Draw(lay).polygon(inner, fill=EAR_INNER + (255,))
    base.alpha_composite(lay)


def draw_paw(base, cx, cy, rx, ry):
    b = B(cx - rx, cy - ry, cx + rx, cy + ry)
    ImageDraw.Draw(base).ellipse(b, fill=CREAM + (255,), outline=CREAM_LINE, width=W(OW_DETAIL))
    d = ImageDraw.Draw(base)
    for t in (-0.38, 0.38):
        d.line([XY(cx + t * rx, cy + ry * 0.05), XY(cx + t * rx * 1.25, cy + ry * 0.62)],
               fill=CREAM_LINE, width=W(0.6))


def draw_arm(base, shoulder, paw, width=8.4):
    d = ImageDraw.Draw(base)
    d.line([XY(*shoulder), XY(*paw)], fill=OUTLINE, width=W(width + 2 * OW_MAIN))
    d.line([XY(*shoulder), XY(*paw)], fill=(250, 195, 138, 255), width=W(width))


def draw_eye(base, cx, cy, p):
    rx, ry, prx, pry = 8.6, 9.6, 6.0, 7.6
    if p.eye_mode == "surprised":
        ry, prx, pry = 11.0, 3.7, 4.6
    if p.eye_mode in ("blink", "sleep", "happy"):
        b = B(cx - 7.4, cy - 7.0, cx + 7.4, cy + 7.6)
        start, end = (185, 355) if p.eye_mode == "happy" else (5, 175)
        ImageDraw.Draw(base).arc(b, start=start, end=end, fill=OUTLINE, width=W(1.15))
        return

    b = B(cx - rx, cy - ry, cx + rx, cy + ry)
    ImageDraw.Draw(base).ellipse(b, fill=EYE_WHITE + (255,), outline=OUTLINE, width=W(1.0))

    inset = 1.5
    cm = empty_mask()
    ImageDraw.Draw(cm).ellipse(B(cx - rx + inset, cy - ry + inset, cx + rx - inset, cy + ry - inset),
                               fill=255)
    lay = new_layer()
    ld = ImageDraw.Draw(lay)
    px, py = cx + p.pupil_dx, cy + p.pupil_dy
    ld.ellipse(B(px - prx, py - pry, px + prx, py + pry), fill=EYE + (255,))
    hl = 0.44 * prx
    ld.ellipse(B(px - prx * 0.75, py - pry * 0.72, px - prx * 0.75 + 2 * hl, py - pry * 0.72 + 2 * hl),
               fill=(255, 255, 255, 235))
    h2 = 0.20 * prx
    ld.ellipse(B(px + prx * 0.30, py + pry * 0.34, px + prx * 0.30 + 2 * h2, py + pry * 0.34 + 2 * h2),
               fill=(255, 255, 255, 185))
    clip_composite(base, lay, cm)


def draw_zzz(base, scale):
    d = ImageDraw.Draw(base)
    for (zx, zy, s) in ((93.0, 41.0, 8.5), (102.0, 25.0, 10.0), (110.0, 8.0, 11.0)):
        s = s * scale
        d.line([XY(zx, zy), XY(zx + s * 0.92, zy)], fill=ZZZ, width=W(1.25))
        d.line([XY(zx + s * 0.92, zy), XY(zx + s * 0.10, zy + s)], fill=ZZZ, width=W(1.25))
        d.line([XY(zx + s * 0.10, zy + s), XY(zx + s * 1.02, zy + s)], fill=ZZZ, width=W(1.25))


# ------------------------------------------------------------ the animal -----
class P:
    """One frame's worth of pose parameters."""

    def __init__(self, squash=1.0, jump=0.0, sway=0.0, head_dx=0.0, head_dy=0.0,
                 pupil_dx=0.0, pupil_dy=0.0, eye_mode="open", mouth_open=0.0, smile=0.0,
                 tail_angle=0.0, paw_lift=0.0, dangle=0.0, ear_flatten=0.0,
                 blush=1.0, zzz=0.0):
        self.squash = squash
        self.jump = jump
        self.sway = sway
        self.head_dx = head_dx
        self.head_dy = head_dy
        self.pupil_dx = pupil_dx
        self.pupil_dy = pupil_dy
        self.eye_mode = eye_mode
        self.mouth_open = mouth_open
        self.smile = smile
        self.tail_angle = tail_angle
        self.paw_lift = paw_lift
        self.dangle = dangle
        self.ear_flatten = ear_flatten
        self.blush = blush
        self.zzz = zzz


def render(p: P) -> Image.Image:
    cat = new_layer()

    # --- body geometry (breathing scales vertically, feet stay planted) -------
    bry = 27.0 * p.squash
    bcy = 119.0 - bry
    body_box = B(31.0, bcy - bry, 97.0, bcy + bry)

    draw_tail(cat, p.tail_angle)

    # --- hind feet (peek out under the body) ---------------------------------
    d = p.dangle
    for side, dx in ((-1, -1.8), (1, 1.8)):
        fx = 64 + side * 17.0 + dx * d
        fy = 117.0 + 5.0 * d
        ImageDraw.Draw(cat).ellipse(B(fx - 11.5, fy - 7.5, fx + 11.5, fy + 7.5),
                                    fill=CREAM + (255,), outline=CREAM_LINE, width=W(OW_DETAIL))

    # --- body ----------------------------------------------------------------
    body_mask = paint_ellipse(cat, body_box, FUR_TOP, FUR_BOT)
    soft_ellipse(cat, 64.0 - 12.0, bcy - 13.0, 15.0, 8.0, (255, 255, 255), 60, body_mask)
    soft_ellipse(cat, 64.0, 104.0, 18.0, 13.0, CREAM, 255, body_mask)
    soft_ellipse(cat, 64.0, 104.0, 18.0, 13.0, CREAM, 0, body_mask)

    # --- front paws / waving arm (drawn in front of the body) ----------------
    draw_paw(cat, 79.0 + 2.8 * d, 106.0 + 9.0 * d, 9.5, 7.5)
    rest = (49.0 - 2.8 * d, 106.0 + 9.0 * d)
    up = (23.0, 55.0)
    px = rest[0] + (up[0] - rest[0]) * p.paw_lift
    py = rest[1] + (up[1] - rest[1]) * p.paw_lift
    if p.paw_lift > 0.02:
        draw_arm(cat, (46.0, 92.0), (px, py))
    draw_paw(cat, px, py, 9.5, 7.5)

    # --- ears + head ---------------------------------------------------------
    draw_ear(cat, -1, p.ear_flatten)
    draw_ear(cat, 1, p.ear_flatten)

    hcx = 64.0 + p.head_dx
    hcy = 52.0 + p.head_dy + (1.0 - p.squash) * 20.0
    head_mask = paint_ellipse(cat, B(hcx - 31.0, hcy - 28.0, hcx + 31.0, hcy + 28.0),
                              HEAD_TOP, HEAD_BOT)
    soft_ellipse(cat, hcx - 11.0, hcy - 16.0, 13.0, 6.0, (255, 255, 255), 70, head_mask)

    # forehead stripes
    stripes = new_layer()
    sd = ImageDraw.Draw(stripes)
    for off, tilt in ((-6.6, -1.8), (0.0, 0.0), (6.6, 1.8)):
        sd.line([XY(hcx + off * 0.72, hcy - 24.0), XY(hcx + off + tilt, hcy - 15.5)],
                fill=STRIPE + (255,), width=W(1.7))
    clip_composite(cat, stripes, head_mask)

    # muzzle
    ImageDraw.Draw(cat).ellipse(B(hcx - 15.0, hcy + 0.0, hcx + 15.0, hcy + 16.5),
                                fill=CREAM + (255,))

    # blush
    for side in (-1, 1):
        soft_ellipse(cat, hcx + side * 20.5, hcy + 7.5, 8.0, 5.0, BLUSH,
                     int(min(255, 120 * p.blush)), head_mask)

    # eyes
    for side in (-1, 1):
        draw_eye(cat, hcx + side * 13.0, hcy - 5.0 + p.pupil_dy * 0.0, p)

    # nose + mouth
    dd = ImageDraw.Draw(cat)
    dd.polygon([XY(hcx - 3.6, hcy + 4.6), XY(hcx + 3.6, hcy + 4.6), XY(hcx, hcy + 8.6)],
               fill=NOSE + (255,))
    if p.mouth_open > 0.03:
        mw = 3.6 + 3.2 * p.mouth_open
        mh = 2.2 + 6.4 * p.mouth_open
        dd.ellipse(B(hcx - mw, hcy + 9.0, hcx + mw, hcy + 9.0 + mh), fill=MOUTH_IN + (255,))
        dd.ellipse(B(hcx - mw * 0.62, hcy + 9.0 + mh * 0.52, hcx + mw * 0.62, hcy + 9.0 + mh * 0.98),
                   fill=TONGUE + (255,))
    elif p.smile > 0.03:
        dd.arc(B(hcx - 6.0, hcy + 6.5, hcx + 6.0, hcy + 14.0 + 1.5 * p.smile),
               start=15, end=165, fill=OUTLINE, width=W(0.95))
    else:
        for side in (-1, 1):
            b = B(hcx + side * 4.9 - 4.6, hcy + 8.2, hcx + side * 4.9 + 4.6, hcy + 14.4)
            dd.arc(b, start=5 if side > 0 else 175, end=175 if side > 0 else 355,
                   fill=OUTLINE, width=W(0.95))

    # whiskers
    for side in (-1, 1):
        for (dy0, dy1, ln) in ((-2.2, -4.6, 15.0), (1.0, 0.6, 16.0), (4.2, 5.6, 14.0)):
            dd.line([XY(hcx + side * 13.0, hcy + 6.0 + dy0),
                     XY(hcx + side * (13.0 + ln), hcy + 6.0 + dy1)],
                    fill=WHISKER, width=W(0.62))

    if p.zzz > 0.0:
        draw_zzz(cat, p.zzz)

    out = new_layer()
    out.paste(cat, (int(round(p.sway * SS)), int(round(-p.jump * SS))))
    return out


# ------------------------------------------------------- frame script --------
def frames():
    """Ordered (name, P) list. Sheet order == this order."""
    out = []

    def add(state, params):
        for i, p in enumerate(params):
            out.append((f"{state}_{i}", p))

    add("idle", [
        P(squash=1.00),
        P(squash=1.04, tail_angle=-3.0),
        P(squash=1.00, eye_mode="blink"),
        P(squash=0.96, tail_angle=3.0),
    ])
    add("idle_look", [
        P(pupil_dx=-4.6, head_dx=-2.0, tail_angle=0.0),
        P(pupil_dx=0.0, head_dx=0.0, tail_angle=5.0),
        P(pupil_dx=4.6, head_dx=2.0, tail_angle=0.0),
        P(pupil_dx=0.0, head_dx=0.0, tail_angle=-5.0),
    ])
    add("idle_tail", [
        P(squash=1.00, tail_angle=0.0),
        P(squash=1.02, tail_angle=13.0, pupil_dx=-0.8),
        P(squash=1.00, tail_angle=0.0, pupil_dx=0.0),
        P(squash=0.98, tail_angle=-13.0, pupil_dx=0.8),
    ])
    add("wave", [
        P(paw_lift=0.05, mouth_open=0.0, smile=0.5),
        P(paw_lift=0.55, head_dx=0.5, smile=0.6, tail_angle=6.0),
        P(paw_lift=1.00, head_dx=1.0, smile=0.7, tail_angle=3.0),
        P(paw_lift=0.55, head_dx=0.5, smile=0.6, tail_angle=0.0),
    ])
    add("talk", [
        P(mouth_open=0.0, smile=1.0, squash=1.00),
        P(mouth_open=1.00, smile=0.0, squash=1.02, head_dy=-1.2),
    ])
    add("drag", [
        P(eye_mode="surprised", mouth_open=0.35, dangle=1.0, ear_flatten=0.9, sway=0.0),
        P(eye_mode="surprised", mouth_open=0.50, dangle=0.72, ear_flatten=0.7, sway=1.5),
    ])
    add("happy", [
        P(squash=0.94, eye_mode="happy", mouth_open=0.45, blush=1.35, paw_lift=0.20),
        P(squash=1.05, jump=9.0, eye_mode="happy", mouth_open=0.85, blush=1.5, paw_lift=0.30),
        P(squash=0.99, jump=2.0, eye_mode="happy", mouth_open=0.60, blush=1.2, paw_lift=0.15),
    ])
    add("sleep", [
        P(squash=1.00, eye_mode="sleep", zzz=0.82, smile=0.4),
        P(squash=1.03, eye_mode="sleep", zzz=1.00, smile=0.4),
    ])
    return out


def build_sheet(frame_list):
    sheet = Image.new("RGBA", (len(frame_list) * FRAME, FRAME), (0, 0, 0, 0))
    atlas = {"frames": {}, "meta": {
        "image": "spritesheet.png",
        "size": {"w": len(frame_list) * FRAME, "h": FRAME},
        "frameSize": {"w": FRAME, "h": FRAME},
        "scale": 1,
    }}
    for i, (name, p) in enumerate(frame_list):
        img = render(p).resize((FRAME, FRAME), LANCZOS)
        sheet.paste(img, (i * FRAME, 0))
        atlas["frames"][name] = {"x": i * FRAME, "y": 0, "w": FRAME, "h": FRAME}
    return sheet, atlas


# ------------------------------------------------------------ data packs -----
def state_specs(frame_list):
    names = [n for n, _ in frame_list]

    def group(state):
        """Frames belonging to exactly this state: 'idle' must NOT swallow 'idle_look_0'."""
        pre = state + "_"
        return [n for n in names if n.startswith(pre) and n[len(pre):].isdigit()]

    def clip(state, weight=1, fps=None, loop=True):
        return {"frames": group(state), "weight": weight, "fps": fps, "loop": loop}

    skin = {
        "default": "idle",
        "drag": "drag",
        "talk": "talk",
        "states": {
            "idle": {"fps": 6, "loop": True, "idle": True, "clips": [
                {"frames": group("idle"), "weight": 3, "fps": 6, "loop": True},
                {"frames": group("idle_look"), "weight": 2, "fps": 5, "loop": True},
                {"frames": group("idle_tail"), "weight": 1, "fps": 7, "loop": True},
            ]},
            "wave": {"fps": 8, "loop": False, "next": "idle",
                     "clips": [clip("wave", 1, 8, False)]},
            "talk": {"fps": 5, "loop": True, "clips": [clip("talk", 1, 5, True)]},
            "drag": {"fps": 4, "loop": True, "clips": [clip("drag", 1, 4, True)]},
            "happy": {"fps": 7, "loop": False, "next": "idle",
                      "clips": [clip("happy", 1, 7, False)]},
            "sleep": {"fps": 2, "loop": True, "clips": [clip("sleep", 1, 2, True)]},
        },
    }
    for st in skin["states"].values():
        for c in st["clips"]:
            if c["fps"] is None:
                del c["fps"]

    actions = {
        "states": {
            # same name as the skin -> overrides it entirely (alternate talk rhythm)
            "talk": {"fps": 7, "loop": True, "clips": [
                {"frames": ["talk_0", "talk_1"], "weight": 3, "fps": 7, "loop": True},
                {"frames": ["talk_0", "talk_1", "idle_0", "talk_1"], "weight": 1, "fps": 6, "loop": True},
            ]},
            # new name -> appended to the skin's state table
            "purr": {"fps": 3, "loop": True, "idle": True, "clips": [
                {"frames": ["happy_0", "happy_2"], "weight": 2, "fps": 3, "loop": True},
                {"frames": ["idle_0", "idle_1"], "weight": 1, "fps": 3, "loop": True},
            ]},
        },
    }
    return skin, actions


def dump_json(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# ------------------------------------------------------------- verifying -----
def collect_state_frames(doc):
    names = []
    for st in doc.get("states", {}).values():
        for c in st.get("clips", []):
            names.extend(c.get("frames", []))
    return names


def verify(frame_list, atlas, sheet):
    fails, warns = [], []
    lines = []
    names = [n for n, _ in frame_list]

    # 1. sheet / atlas geometry
    real_w, real_h = sheet.size
    meta = atlas["meta"]
    lines.append(f"frames            : {len(names)}")
    lines.append(f"spritesheet       : {real_w}x{real_h} px")
    if (meta["size"]["w"], meta["size"]["h"]) != (real_w, real_h):
        fails.append("meta.size != real PNG size")
    if (meta["frameSize"]["w"], meta["frameSize"]["h"]) != (FRAME, FRAME):
        fails.append("meta.frameSize != 128x128")
    if real_w != len(names) * FRAME or real_h != FRAME:
        fails.append(f"sheet size != frames*128 ({len(names) * FRAME}x{FRAME})")
    lines.append(f"meta.size         : {meta['size']['w']}x{meta['size']['h']}  "
                 f"meta.frameSize: {meta['frameSize']['w']}x{meta['frameSize']['h']}")
    lines.append(f"atlas frames      : {len(atlas['frames'])}")

    bad = []
    for n in names:
        f = atlas["frames"].get(n)
        if f is None:
            bad.append(f"{n}: missing from atlas")
            continue
        if not (0 <= f["x"] and 0 <= f["y"] and f["x"] + f["w"] <= real_w
                and f["y"] + f["h"] <= real_h):
            bad.append(f"{n}: rect outside image")
        if (f["w"], f["h"]) != (FRAME, FRAME):
            bad.append(f"{n}: w/h != 128")
    if bad:
        fails.extend(bad)

    # 2. states <-> atlas
    skin_doc = json.loads((SKIN_DIR / "states.json").read_text(encoding="utf-8"))
    act_doc = json.loads((ACTION_DIR / "states.json").read_text(encoding="utf-8"))
    skin_refs = collect_state_frames(skin_doc)
    act_refs = collect_state_frames(act_doc)
    unknown = sorted({n for n in skin_refs + act_refs if n not in atlas["frames"]})
    orphan = sorted(set(atlas["frames"]) - set(skin_refs) - set(act_refs))
    if unknown:
        fails.append(f"states reference unknown frames: {unknown}")
    if orphan:
        fails.append(f"atlas frames never referenced: {orphan}")

    # 3. per-state / per-clip shape (catches prefix-collision bugs like idle_ vs idle_look_)
    expect_clip_sizes = {"idle": [4, 4, 4], "wave": [4], "talk": [2],
                         "drag": [2], "happy": [3], "sleep": [2]}
    per_state = []
    for name, st in skin_doc["states"].items():
        fs = sorted({n for c in st["clips"] for n in c["frames"]})
        per_state.append((name, len(fs), len(st["clips"])))
        sizes = [len(c["frames"]) for c in st["clips"]]
        if sizes != expect_clip_sizes.get(name):
            fails.append(f"state {name}: clip frame counts {sizes} != {expect_clip_sizes.get(name)}")
        for c in st["clips"]:
            bases = {f.rsplit("_", 1)[0] for f in c["frames"]}
            if len(bases) > 1:
                fails.append(f"state {name}: one clip mixes frame groups {sorted(bases)}")
    if set(skin_doc["states"]) != set(expect_clip_sizes):
        fails.append(f"state names {sorted(skin_doc['states'])} != {sorted(expect_clip_sizes)}")
    for key, want in (("default", "idle"), ("drag", "drag"), ("talk", "talk")):
        if skin_doc.get(key) != want:
            fails.append(f"states.{key} = {skin_doc.get(key)!r}, expected {want!r}")
    if not any(st.get("clips") for st in skin_doc["states"].values()):
        fails.append("no clips at all")
    lines.append(f"state frame counts: " +
                 ", ".join(f"{n}={c}({k}clips)" for n, c, k in per_state))
    lines.append(f"skin refs / action refs : {len(skin_refs)} / {len(act_refs)}  "
                 f"unknown={len(unknown)} orphan={len(orphan)}")

    # 4. no frame may be cut off by the frame border (tails / paws / Z glyphs)
    clipped = []
    for n in names:
        f = atlas["frames"][n]
        tile = sheet.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))
        al = tile.getchannel("A")
        edge = max(al.crop((0, 0, FRAME, 1)).getextrema()[1],
                   al.crop((0, FRAME - 1, FRAME, FRAME)).getextrema()[1],
                   al.crop((0, 0, 1, FRAME)).getextrema()[1],
                   al.crop((FRAME - 1, 0, FRAME, FRAME)).getextrema()[1])
        if edge > 200:
            clipped.append(f"{n} (alpha {edge} on border)")
    if clipped:
        fails.append(f"art clipped by frame border: {clipped}")
    lines.append(f"border clipping   : {len(names) - len(clipped)}/{len(names)} frames stay inside "
                 f"their 128x128 tile")

    # 5. manifests
    expect = {
        "cat-default": ("builtin.cat-default", "skin", "data"),
        "cat-actions": ("builtin.cat-actions", "action", "declarative"),
        "bubble-default": ("builtin.bubble-default", "theme", "data"),
    }
    for folder, (pid, kind, runtime) in expect.items():
        mf = ROOT / "packs" / folder / "plugin.json"
        if not mf.exists():
            fails.append(f"{folder}/plugin.json missing")
            continue
        m = json.loads(mf.read_text(encoding="utf-8"))
        if m.get("manifestVersion") != 1:
            fails.append(f"{folder}: manifestVersion != 1")
        if (m.get("id"), m.get("kind"), m.get("runtime")) != (pid, kind, runtime):
            fails.append(f"{folder}: id/kind/runtime mismatch")
        if m.get("engine", {}).get("deskpet") != ">=0.1.0 <1.0.0":
            fails.append(f"{folder}: engine range mismatch")
        for key, rel in (m.get("data") or {}).items():
            if key in ("spritesheet", "atlas", "states", "tokens") and not (mf.parent / rel).exists():
                fails.append(f"{folder}: data.{key} -> {rel} missing")
    lines.append("manifests         : 3/3 parsed, id/kind/runtime/engine/data-files checked")

    # 5. theme tokens
    tokens = json.loads((THEME_DIR / "tokens.json").read_text(encoding="utf-8"))
    want = ["bubbleBackground", "bubbleColor", "bubbleRadius", "bubbleFontFamily",
            "bubbleFontSize", "bubbleMaxWidth", "bubbleShadow", "accent"]
    miss = [k for k in want if k not in tokens]
    if miss:
        fails.append(f"tokens.json missing ThemeTokens keys: {miss}")
    lines.append(f"theme tokens      : {len(want) - len(miss)}/{len(want)} required keys present")

    # 6. previews
    prev = [("preview-idle.png", "idle_0"), ("preview-wave.png", "wave_2"),
            ("preview-talk.png", "talk_1"), ("preview-drag.png", "drag_0")]
    for fn, frame in prev:
        p = SKIN_DIR / fn
        if not p.exists():
            fails.append(f"{fn} missing")
            continue
        with Image.open(p) as im:
            if im.size != (FRAME, FRAME):
                fails.append(f"{fn}: size {im.size} != (128, 128)")
            if im.convert("RGBA").getchannel("A").getextrema()[1] == 0:
                fails.append(f"{fn}: fully transparent")
    lines.append("previews          : 4 written as 128x128 cropped from " +
                 ", ".join(f"{f}<-{n}" for f, n in prev))

    return lines, fails, warns


# ------------------------------------------------------------------ main -----
def main():
    SKIN_DIR.mkdir(parents=True, exist_ok=True)
    ACTION_DIR.mkdir(parents=True, exist_ok=True)

    frame_list = frames()
    sheet, atlas = build_sheet(frame_list)
    skin_doc, act_doc = state_specs(frame_list)

    sheet.save(SKIN_DIR / "spritesheet.png")
    dump_json(SKIN_DIR / "atlas.json", atlas)
    dump_json(SKIN_DIR / "states.json", skin_doc)
    dump_json(ACTION_DIR / "states.json", act_doc)

    index = {n: i for i, (n, _) in enumerate(frame_list)}
    for fn, frame in (("preview-idle.png", "idle_0"), ("preview-wave.png", "wave_2"),
                      ("preview-talk.png", "talk_1"), ("preview-drag.png", "drag_0")):
        x = index[frame] * FRAME
        sheet.crop((x, 0, x + FRAME, FRAME)).save(SKIN_DIR / fn)

    lines, fails, warns = verify(frame_list, atlas, sheet)

    print("== deskpet builtin skin pack: generated + verified ==")
    for ln in lines:
        print(ln)
    for w in warns:
        print(f"WARN: {w}")
    for f in fails:
        print(f"FAIL: {f}")
    print("RESULT: " + ("PASS" if not fails else f"FAIL ({len(fails)} problem(s))"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
