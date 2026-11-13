#!/usr/bin/env python3
"""Kaz-style short-film renderer (stand-in for the skill bundle's render.py).

Storyboard JSON -> frames (Pillow + numpy) -> ffmpeg MP4, with a generated score.

  python3 render.py story.json --sheet sheet.jpg      # contact sheet for QC
  python3 render.py story.json -o film.mp4 --res 1080 # full render
  python3 render.py story.json -o prev.mp4 --preview  # 360p / 12 fps

Logical canvas is always 1920x1080; --res scales the final frame.
"""
import argparse, json, math, os, random, subprocess, sys, tempfile, wave
from functools import lru_cache
from multiprocessing import Pool

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1920, 1080
SR = 48000
CREAM = (241, 232, 214)
CREAM_BACK = (220, 208, 186)
OUTLINE = (34, 30, 28)
RED = (228, 36, 44)
ENEMY_BLACK = (10, 10, 12)
NOTE_YELLOW = (242, 206, 74)

FONT_DIR = "/usr/share/fonts/opentype/inter"
FALLBACK = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


@lru_cache(None)
def font(name, size):
    for p in (os.path.join(os.path.dirname(__file__), "assets/fonts", name),
              os.path.join(FONT_DIR, name)):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.truetype(FALLBACK, size)


# ---------------------------------------------------------------- palettes
PALETTES = {
    "cold":   dict(top=(54, 64, 78), bot=(40, 48, 60), floor=(29, 35, 45), furn=(72, 84, 100), dark=(56, 66, 82), win=(98, 114, 134)),
    "night":  dict(top=(30, 38, 56), bot=(22, 28, 42), floor=(15, 19, 29), furn=(46, 56, 76), dark=(34, 42, 60), win=(62, 78, 106)),
    "dark":   dict(top=(26, 30, 36), bot=(17, 19, 23), floor=(11, 12, 15), furn=(38, 42, 50), dark=(29, 32, 39), win=(46, 52, 62)),
    "black":  dict(top=(13, 13, 15), bot=(8, 8, 10), floor=(5, 5, 7), furn=(23, 23, 27), dark=(17, 17, 20), win=(27, 27, 33)),
    "dawn":   dict(top=(62, 76, 100), bot=(132, 114, 108), floor=(50, 52, 62), furn=(94, 100, 118), dark=(76, 82, 98), win=(232, 178, 124)),
    "amber":  dict(top=(228, 174, 108), bot=(198, 134, 74), floor=(150, 96, 52), furn=(126, 80, 44), dark=(102, 63, 34), win=(252, 218, 156)),
    "golden": dict(top=(250, 216, 146), bot=(236, 158, 80), floor=(124, 72, 38), furn=(150, 92, 44), dark=(110, 64, 30), win=(255, 238, 196)),
}

# ---------------------------------------------------------------- poses
# y is up-negative, feet at y=0, facing right. Hero standing height ~328 px.
def P(head, neck, hip, la, ra, ll, rl, rot=0):
    return dict(head=head, neck=neck, hip=hip, la=la, ra=ra, ll=ll, rl=rl, rot=rot)

LEGS_F = ([(-14, -128), (-16, -64), (-18, 0)], [(14, -128), (16, -64), (18, 0)])
LEGS_S = ([(-6, -128), (-14, -64), (-20, 0)], [(2, -128), (10, -64), (16, 0)])
SIT_LEGS = ([(-4, -122), (56, -128), (58, 0)], [(4, -122), (66, -124), (70, 0)])

POSES = {
    "stand": P((0, -292), (0, -238), (0, -128),
               [(-34, -226), (-46, -174), (-50, -122)], [(34, -226), (46, -174), (50, -122)], *LEGS_F),
    "hang": P((5, -274), (2, -232), (0, -128),
              [(-30, -220), (-38, -164), (-40, -108)], [(30, -220), (38, -164), (40, -108)], *LEGS_F),
    "shrug": P((0, -290), (0, -238), (0, -128),
               [(-34, -226), (-64, -194), (-88, -214)], [(34, -226), (64, -194), (88, -214)], *LEGS_F),
    "arms_up": P((0, -294), (0, -238), (0, -128),
                 [(-30, -232), (-64, -288), (-92, -342)], [(30, -232), (64, -288), (92, -342)], *LEGS_F),
    "hands_head": P((0, -292), (0, -238), (0, -128),
                    [(-34, -226), (-66, -262), (-30, -306)], [(34, -226), (66, -262), (30, -306)], *LEGS_F),
    "look": P((6, -290), (0, -238), (-2, -128),
              [(-2, -226), (-8, -172), (-8, -122)], [(4, -226), (10, -172), (12, -122)], *LEGS_S),
    "look_down": P((16, -272), (6, -234), (-2, -128),
                   [(0, -222), (-4, -166), (-2, -114)], [(6, -222), (12, -166), (14, -114)], *LEGS_S),
    "reach_forward": P((6, -292), (0, -238), (-2, -128),
                       [(-2, -226), (-8, -172), (-6, -122)], [(6, -226), (58, -220), (110, -224)], *LEGS_S),
    "reach_low": P((14, -284), (6, -236), (-2, -128),
                   [(0, -224), (-4, -170), (-2, -120)], [(8, -224), (52, -196), (92, -172)], *LEGS_S),
    "lift_note": P((6, -292), (0, -238), (-2, -128),
                   [(-2, -226), (-8, -172), (-6, -122)], [(6, -226), (42, -264), (64, -310)], *LEGS_S),
    "sweep": P((12, -286), (4, -236), (-2, -128),
               [(-2, -224), (-8, -170), (-6, -120)], [(8, -224), (70, -196), (130, -190)], *LEGS_S),
    "walkA": P((6, -290), (2, -238), (0, -128),
               [(0, -226), (-30, -180), (-44, -140)], [(4, -226), (34, -182), (52, -146)],
               [(-2, -128), (-30, -66), (-52, 0)], [(2, -128), (24, -64), (44, 0)]),
    "walkC": P((6, -294), (2, -242), (0, -132),
               [(0, -228), (-4, -174), (-2, -124)], [(4, -228), (8, -174), (8, -124)],
               [(-2, -132), (-4, -66), (-6, 0)], [(2, -132), (14, -70), (8, -8)]),
    "walkB": P((6, -290), (2, -238), (0, -128),
               [(0, -226), (30, -182), (48, -146)], [(4, -226), (-30, -180), (-44, -140)],
               [(-2, -128), (24, -64), (44, 0)], [(2, -128), (-30, -66), (-52, 0)]),
    "climbA": P((32, -280), (20, -230), (0, -128),
                [(14, -222), (-16, -186), (-6, -148)], [(22, -222), (56, -206), (70, -250)],
                [(-4, -128), (-8, -64), (-14, 0)], [(4, -128), (52, -110), (58, -60)]),
    "climbB": P((32, -280), (20, -230), (0, -128),
                [(14, -222), (54, -206), (68, -250)], [(22, -222), (-14, -186), (-4, -148)],
                [(-4, -128), (48, -110), (54, -60)], [(4, -128), (-6, -64), (-12, 0)]),
    "sit": P((10, -282), (6, -228), (0, -122),
             [(2, -218), (36, -172), (84, -172)], [(8, -218), (48, -176), (96, -178)], *SIT_LEGS),
    "sit_typeA": P((12, -282), (6, -228), (0, -122),
                   [(2, -218), (38, -170), (84, -176)], [(8, -218), (50, -176), (98, -182)], *SIT_LEGS),
    "sit_typeB": P((12, -281), (6, -228), (0, -122),
                   [(2, -218), (38, -174), (86, -182)], [(8, -218), (50, -172), (96, -176)], *SIT_LEGS),
    "head_in_hand": P((44, -262), (22, -222), (0, -122),
                      [(14, -212), (24, -164), (34, -132)], [(22, -214), (86, -182), (56, -256)], *SIT_LEGS),
    "slump": P((-30, -266), (-22, -214), (0, -118),
               [(-18, -206), (4, -160), (30, -186)], [(-14, -206), (12, -164), (38, -190)],
               [(-2, -118), (70, -120), (76, 0)], [(4, -118), (80, -114), (86, 0)]),
    "sit_curl": P((30, -232), (16, -198), (0, -118),
                  [(10, -194), (42, -150), (62, -150)], [(16, -194), (48, -156), (66, -162)],
                  [(-2, -118), (54, -152), (44, 0)], [(4, -118), (60, -150), (50, 0)]),
    "lean": P((40, -272), (18, -230), (0, -128),
              [(14, -220), (30, -166), (40, -114)], [(20, -220), (42, -168), (56, -120)], *LEGS_S),
}
POSES["lie"] = dict(POSES["stand"], rot=-90)
POSES["lie_reach"] = dict(POSES["stand"], ra=[(34, -226), (40, -292), (42, -352)], rot=-90)
POSES["curl"] = dict(POSES["sit_curl"], rot=-90)

CYCLES = {"sit_type": (["sit_typeA", "sit_typeB"], 0.16),
          "walk": (["walkA", "walkC", "walkB", "walkC"], 0.14),
          "climb": (["climbA", "climbB"], 0.26)}

HEAD_R, TORSO_W, ARM_W, LEG_W = 36, 62, 22, 26


def _xf(pt, facing, rot):
    x, y = pt
    if facing == "left":
        x = -x
    if rot:
        a = math.radians(rot)
        x, y = x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)
    return x, y


@lru_cache(None)
def figure(pose, scale=1.0, kind="hero", facing="right", headband=False, ss=3):
    """Render a pictogram figure. Returns (RGBA image, origin(x,y) in image, anchors)."""
    p = POSES[pose]
    rot = p.get("rot", 0)
    hb = headband and kind == "hero"
    parts = {k: [_xf(q, facing, rot) for q in (v if isinstance(v, list) else [v])]
             for k, v in p.items() if k != "rot"}
    if hb:
        hx, hy = p["head"]
        parts["band"] = [_xf((hx - 35, hy - 8), facing, rot), _xf((hx + 35, hy - 8), facing, rot)]
        parts["tail1"] = [_xf((hx - 34, hy - 8), facing, rot), _xf((hx - 60, hy + 6), facing, rot)]
        parts["tail2"] = [_xf((hx - 34, hy - 6), facing, rot), _xf((hx - 54, hy + 18), facing, rot)]
    pts = [q for v in parts.values() for q in v]
    pad = HEAD_R + 14
    minx, maxx = min(q[0] for q in pts) - pad, max(q[0] for q in pts) + pad
    miny, maxy = min(q[1] for q in pts) - pad, max(q[1] for q in pts) + pad
    if rot:  # rest rotated poses on the ground: bottom of body = y 0
        body_bottom = max(q[1] for q in pts) + LEG_W / 2
        shift = -body_bottom
        parts = {k: [(x, y + shift) for x, y in v] for k, v in parts.items()}
        cx = parts["hip"][0][0]  # anchor on the hip so pose changes don't slide the body
        parts = {k: [(x - cx, y) for x, y in v] for k, v in parts.items()}
        minx, maxx, miny, maxy = minx - cx, maxx - cx, miny + shift, maxy + shift
    k = scale * ss
    cw, ch = int((maxx - minx) * k) + 4, int((maxy - miny) * k) + 4
    img = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    T = lambda q: ((q[0] - minx) * k + 2, (q[1] - miny) * k + 2)

    hero = kind == "hero"
    fill = CREAM if hero else ENEMY_BLACK
    back = CREAM_BACK if hero else ENEMY_BLACK
    ow = 5 * ss * scale if hero else 0

    def limb(pl, w, col):
        pl = [T(q) for q in pl]
        for wid, c in ((w * k + 2 * ow, OUTLINE), (w * k, col)):
            if wid <= 0 or (c == OUTLINE and not ow):
                continue
            for a, b in zip(pl, pl[1:]):
                d.line([a, b], fill=c, width=int(wid))
            for q in pl:
                r = wid / 2
                d.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r], fill=c)

    limb(parts["ll"], LEG_W, back)
    limb(parts["la"], ARM_W, back)
    limb([parts["hip"][0], parts["neck"][0]], TORSO_W, fill)
    limb(parts["rl"], LEG_W, fill)
    limb([parts["head"][0]], HEAD_R * 2, fill)
    if hb:
        for key in ("tail1", "tail2", "band"):
            pl = [T(q) for q in parts[key]]
            d.line(pl, fill=RED, width=int(11 * k))
            for q in pl:
                r = 5.5 * k
                d.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r], fill=RED)
    limb(parts["ra"], ARM_W, fill)

    img = img.resize((max(1, cw // ss), max(1, ch // ss)), Image.LANCZOS)
    o = ((0 - minx) * scale + 2 / ss, (0 - miny) * scale + 2 / ss)
    anchors = {n: ((parts[n][-1][0]) * scale, (parts[n][-1][1]) * scale) for n in ("head", "ra", "la")}
    return img, o, anchors


@lru_cache(None)
def enemy_sprite(pose, scale, facing):
    body, o, anchors = figure(pose, scale * 1.4, "enemy", facing)
    pad = int(40 * scale + 30)
    a = body.split()[3]
    big = Image.new("L", (body.width + 2 * pad, body.height + 2 * pad), 0)
    big.paste(a, (pad, pad))
    g = big.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(10 + 10 * scale))
    g = g.point(lambda v: min(255, int(v * 1.8)))
    glow = Image.new("RGBA", big.size, RED + (0,))
    glow.putalpha(g)
    rim = big.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(2))
    rim_img = Image.new("RGBA", big.size, (255, 70, 60, 0))
    rim_img.putalpha(rim)
    glow = Image.alpha_composite(glow, rim_img)
    out = glow.copy()
    out.alpha_composite(body, (pad, pad))
    return out, glow, (o[0] + pad, o[1] + pad), anchors


# ---------------------------------------------------------------- backgrounds
def grad(top, bot, h=H, w=W):
    t = np.linspace(0, 1, h)[:, None, None]
    arr = (np.array(top)[None, None] * (1 - t) + np.array(bot)[None, None] * t)
    return np.repeat(arr, w, axis=1)


def vignette(arr, strength=0.35):
    yy, xx = np.mgrid[0:arr.shape[0], 0:arr.shape[1]]
    cx, cy = arr.shape[1] / 2, arr.shape[0] / 2
    r = np.sqrt(((xx - cx) / cx) ** 2 + ((yy - cy) / cy) ** 2) / math.sqrt(2)
    return arr * (1 - strength * r[..., None] ** 2)


def build_set(name, pal_name):
    """Return (bg RGBA, fg RGBA or None, info dict)."""
    pal = PALETTES[pal_name]
    SS = 2
    arr = grad(pal["top"], pal["bot"])
    info = {}
    if name not in ("void", "title", "summit", "stairs", "street", "closeup"):
        arr[860:] = np.array(pal["floor"])
    bg = Image.fromarray(np.clip(vignette(arr, 0.0), 0, 255).astype("uint8")).convert("RGBA")
    big = bg.resize((W * SS, H * SS))
    d = ImageDraw.Draw(big)
    R = lambda *v: [int(a * SS) for a in v]
    fg = None

    def rect(x0, y0, x1, y1, c, rr=0, dd=d):
        dd.rounded_rectangle(R(x0, y0, x1, y1), radius=int(rr * SS), fill=c)

    if name == "desk":
        rect(980, 690, 1470, 710, pal["furn"], 4)
        rect(1000, 710, 1020, 860, pal["dark"])
        rect(1430, 710, 1450, 860, pal["dark"])
        rect(1250, 710, 1430, 780, pal["dark"], 3)
        rect(1320, 738, 1360, 746, pal["furn"], 3)
        rect(820, 738, 950, 754, pal["furn"], 4)      # seat
        rect(814, 596, 832, 754, pal["furn"], 6)      # backrest
        rect(830, 754, 842, 860, pal["dark"])
        rect(926, 754, 938, 860, pal["dark"])
        rect(1520, 420, 1560, 690, pal["dark"], 6)    # floor lamp
        d.polygon([tuple(R(1490, 430)), tuple(R(1590, 430)), tuple(R(1570, 360)), tuple(R(1510, 360))], fill=pal["furn"])
        info["seat"] = (885, 860)
    elif name == "bedroom":
        rect(1380, 250, 1660, 560, pal["dark"], 6)
        rect(1396, 266, 1644, 544, pal["win"], 4)
        rect(1516, 266, 1524, 544, pal["dark"])
        rect(680, 620, 712, 860, pal["dark"], 6)      # headboard
        rect(700, 742, 1300, 800, pal["furn"], 10)    # mattress
        rect(700, 800, 1300, 840, pal["dark"], 4)
        rect(712, 840, 732, 860, pal["dark"]); rect(1270, 840, 1290, 860, pal["dark"])
        rect(724, 712, 840, 746, CREAM_BACK if pal_name in ("amber", "golden", "dawn") else pal["win"], 14)
        rect(540, 742, 660, 860, pal["dark"], 4)      # nightstand
        rect(540, 742, 660, 752, pal["furn"], 4)
        if pal_name == "night" or pal_name == "black" or pal_name == "dark":
            d.ellipse(R(1560, 300, 1610, 350), fill=(200, 206, 214))
        else:
            d.ellipse(R(1420, 440, 1520, 540), fill=(255, 226, 160))
        info["bed_top"] = 742
    elif name == "couch":
        rect(1380, 250, 1660, 560, pal["dark"], 6)
        rect(1396, 266, 1644, 544, pal["win"], 4)
        d.ellipse(R(1560, 300, 1610, 350), fill=(200, 206, 214))
        fgi = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
        fd = ImageDraw.Draw(fgi)
        rect(760, 600, 1260, 760, pal["furn"], 26, fd)  # back
        rect(740, 700, 800, 860, pal["dark"], 18, fd)   # arms
        rect(1220, 700, 1280, 860, pal["dark"], 18, fd)
        rect(780, 742, 1240, 800, pal["dark"], 10, fd)  # seat front
        rect(800, 800, 1220, 860, pal["furn"], 6, fd)
        fg = fgi
    elif name == "window":
        rect(760, 240, 1500, 720, pal["dark"], 8)
        rect(780, 260, 1480, 700, pal["win"], 4)
        rect(780, 600, 1480, 700, tuple(int(c * 0.82) for c in pal["win"]))
        for bx, bw, bh in ((800, 120, 200), (960, 90, 260), (1090, 160, 170), (1300, 110, 230)):
            rect(bx, 600 - bh, bx + bw, 600, tuple(int(c * 0.9) for c in pal["win"]))
        rect(1124, 260, 1136, 700, pal["dark"])
        info["window"] = (780, 260, 1480, 700)
    elif name == "mirror":
        for x in range(0, W, 120):
            d.line(R(x, 0, x, 860), fill=tuple(int(c * 0.93) for c in pal["top"]), width=2)
        for y in range(0, 860, 120):
            d.line(R(0, y, W, y), fill=tuple(int(c * 0.93) for c in pal["top"]), width=2)
        rect(1060, 260, 1340, 660, pal["dark"], 12)
        rect(1076, 276, 1324, 644, pal["win"], 6)
        rect(1040, 700, 1360, 732, pal["furn"], 8)
        rect(1170, 732, 1230, 860, pal["dark"], 6)
        info["mirror"] = (1076, 276, 1324, 644)
    elif name == "street":
        rnd = random.Random(4)
        x = -40
        while x < W:
            bw, bh = rnd.randint(140, 260), rnd.randint(260, 560)
            rect(x, 860 - bh, x + bw, 860, tuple(int(c * (0.78 + rnd.random() * 0.1)) for c in pal["bot"]))
            for wy in range(860 - bh + 40, 820, 70):
                for wx in range(x + 24, x + bw - 30, 54):
                    if rnd.random() < 0.5:
                        rect(wx, wy, wx + 24, wy + 34, tuple(min(255, int(c * 1.08)) for c in pal["top"]), 3)
            x += bw + rnd.randint(10, 40)
        rect(0, 860, W, 1080, pal["floor"])
        rect(0, 860, W, 872, pal["furn"])
    elif name == "stairs":
        d.ellipse(R(1380, 120, 1620, 360), fill=(255, 232, 170))
        steps = []
        x0, y0, sw, sh = 160, 1000, 150, 64
        for i in range(12):
            x, y = x0 + i * sw, y0 - i * sh
            steps.append((x, y))
            rect(x, y, W + 200, y + sh + 2, pal["floor"])
            rect(x, y, W + 200, y + 8, pal["furn"])
        info["steps"] = steps
    elif name == "summit":
        d.ellipse(R(760, 300, 1160, 700), fill=(255, 232, 168))
        d.polygon([tuple(R(-100, 1080)), tuple(R(960, 640)), tuple(R(2020, 1080))], fill=pal["floor"])
        d.polygon([tuple(R(-100, 1080)), tuple(R(420, 900)), tuple(R(700, 1080))], fill=pal["dark"])
    elif name == "closeup":
        pass
    big = big.resize((W, H), Image.LANCZOS)
    if fg is not None:
        fg = fg.resize((W, H), Image.LANCZOS)
    v = np.asarray(big).astype(np.float32)
    v[..., :3] = vignette(v[..., :3], 0.38)
    big = Image.fromarray(np.clip(v, 0, 255).astype("uint8"), "RGBA")
    return big, fg, info


# ---------------------------------------------------------------- props
@lru_cache(None)
def note_sprite(size, text, rot, big=False):
    ss = 3
    s = int(size * ss)
    img = Image.new("RGBA", (s + 12 * ss, s + 12 * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([6 * ss + 3 * ss, 6 * ss + 4 * ss, 6 * ss + s + 3 * ss, 6 * ss + s + 4 * ss], fill=(0, 0, 0, 60))
    d.rectangle([6 * ss, 6 * ss, 6 * ss + s, 6 * ss + s], fill=NOTE_YELLOW)
    d.rectangle([6 * ss, 6 * ss, 6 * ss + s, 6 * ss + s * 0.18], fill=(230, 190, 60))
    if text:
        lines = text.split("\n")
        f = font("Inter-Black.otf", int(s * (0.24 if not big else 0.22)))
        f2 = font("Inter-Bold.otf", int(s * 0.08))
        tw = d.textlength(lines[0], font=f)
        d.text((6 * ss + (s - tw) / 2, 6 * ss + s * 0.32), lines[0], font=f, fill=(40, 36, 40))
        if len(lines) > 1:
            tw = d.textlength(lines[1], font=f2)
            d.text((6 * ss + (s - tw) / 2, 6 * ss + s * 0.68), lines[1], font=f2, fill=(70, 62, 60))
    img = img.rotate(rot, resample=Image.BICUBIC, expand=True)
    return img.resize((img.width // ss, img.height // ss), Image.LANCZOS)


def note_wall_positions(count):
    rnd = random.Random(11)
    pos = [(1240, 545, 70, -3, "START")]
    for i in range(count - 1):
        pos.append((rnd.randint(1000, 1440), rnd.randint(290, 600), rnd.randint(46, 60),
                    rnd.uniform(-14, 14), "START"))
    return pos


@lru_cache(None)
def text_img(text, fname, size, fill, glow=None, track=0, shadow=True):
    f = font(fname, size)
    tmp = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    widths = [tmp.textlength(ch, font=f) + track for ch in text]
    tw = int(sum(widths)) + 40
    asc, desc = f.getmetrics()
    th = asc + desc + 40
    img = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def draw(dd, col):
        x = 20
        for ch, w in zip(text, widths):
            dd.text((x, 20), ch, font=f, fill=col)
            x += w
    if glow:
        g = Image.new("RGBA", img.size, (0, 0, 0, 0))
        draw(ImageDraw.Draw(g), glow + (200,))
        img = Image.alpha_composite(img, g.filter(ImageFilter.GaussianBlur(9)))
    elif shadow:
        s = Image.new("RGBA", img.size, (0, 0, 0, 0))
        draw(ImageDraw.Draw(s), (0, 0, 0, 150))
        img = Image.alpha_composite(img, s.filter(ImageFilter.GaussianBlur(5)))
    d = ImageDraw.Draw(img)
    draw(d, fill)
    return img


def with_alpha(img, a):
    if a >= 0.999:
        return img
    im = img.copy()
    im.putalpha(im.split()[3].point(lambda v: int(v * max(0.0, a))))
    return im


def ease(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def fade_at(t, start, dur=0.4, end=None, out=0.4):
    a = ease((t - start) / dur)
    if end is not None:
        a *= 1 - ease((t - end) / out)
    return a


def interp_path(path, t):
    if t <= path[0][0]:
        return path[0][1:]
    for (t0, *a), (t1, *b) in zip(path, path[1:]):
        if t0 <= t <= t1:
            u = ease((t - t0) / (t1 - t0)) if t1 > t0 else 1
            return tuple(x + (y - x) * u for x, y in zip(a, b))
    return path[-1][1:]


def lin_path(path, t):
    if t <= path[0][0]:
        return path[0][1:]
    for (t0, *a), (t1, *b) in zip(path, path[1:]):
        if t0 <= t <= t1:
            u = (t - t0) / (t1 - t0) if t1 > t0 else 1
            return tuple(x + (y - x) * u for x, y in zip(a, b))
    return path[-1][1:]


# ---------------------------------------------------------------- scene
class Scene:
    def __init__(self, sc, film):
        self.sc, self.film = sc, film
        self.dur = sc["duration"]
        self.set = sc.get("set", "void")
        self.pal = sc.get("palette", "cold")
        if self.set == "title":
            self.bg = Image.new("RGBA", (W, H), (8, 8, 10, 255)); self.fg = None; self.info = {}
        else:
            self.bg, self.fg, self.info = build_set(self.set, self.pal)

    # -- hero state at time t
    def hero_state(self, t):
        h = self.sc.get("hero")
        if not h:
            return None
        pose, x, y, facing = h.get("pose", "stand"), h.get("x", 960), h.get("y", 860), h.get("facing", "right")
        for e in h.get("seq", []):
            if t >= e[0]:
                pose = e[1]
                if len(e) > 2 and e[2] is not None: x = e[2]
                if len(e) > 3 and e[3] is not None: y = e[3]
                if len(e) > 4: facing = e[4]
        if "path" in h:
            x, y = lin_path(h["path"], t)
        if pose in CYCLES:
            names, per = CYCLES[pose]
            pose = names[int(t / per) % len(names)]
        else:
            y += math.sin(t * 2 * math.pi * 0.35) * 2.0 * h.get("scale", 1)
        if h.get("jitter"):
            x += math.sin(t * 53) * h["jitter"]; y += math.cos(t * 41) * h["jitter"]
        hb = h.get("headband", False)
        if isinstance(hb, (int, float)) and not isinstance(hb, bool):
            hb = t >= hb
        return pose, x, y, facing, h.get("scale", 1.0), hb, fade_at(t, h.get("appear", -1), 0.5)

    def frame(self, t):
        sc = self.sc
        im = self.bg.copy()
        # walkers through window
        if "walkers" in sc:
            self.draw_walkers(im, t)
        # enemy
        en = sc.get("enemy")
        enemy_head = None
        if en and t >= en.get("appear", 0) and (en.get("disappear") is None or t < en["disappear"]):
            spr, glow, o, anc = enemy_sprite(en.get("pose", "lean"), en.get("scale", 1.0), en.get("facing", "right"))
            a = fade_at(t, en.get("appear", 0), en.get("fade", 0.9))
            pulse = 0.82 + 0.18 * math.sin(t * 2 * math.pi * 0.6)
            sway = math.sin(t * 2 * math.pi * 0.18) * 5 * en.get("scale", 1)
            ex, ey = en["x"] + sway, en.get("y", 860)
            pos = (int(ex - o[0]), int(ey - o[1]))
            layer = with_alpha(spr, a)
            gl = with_alpha(glow, a * (pulse - 0.82) * 2.5)
            clip = en.get("clip")
            if clip:
                tmp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                tmp.alpha_composite(gl, (max(pos[0], 0), max(pos[1], 0)), (max(0, -pos[0]), max(0, -pos[1])))
                tmp.alpha_composite(layer, (max(pos[0], 0), max(pos[1], 0)),
                                    (max(0, -pos[0]), max(0, -pos[1])))
                mask = Image.new("L", (W, H), 0)
                ImageDraw.Draw(mask).rectangle(clip, fill=255)
                tmp.putalpha(Image.fromarray(np.minimum(np.asarray(tmp.split()[3]), np.asarray(mask))))
                im.alpha_composite(tmp)
            else:
                paste(im, gl, pos)
                paste(im, layer, pos)
            enemy_head = (ex + anc["head"][0], ey + anc["head"][1], en.get("scale", 1.0), en.get("facing", "right"))
        if self.fg is not None:
            im.alpha_composite(self.fg)
        self.draw_props(im, t, front=False)
        hs = self.hero_state(t)
        hand = None
        if hs:
            pose, x, y, facing, scale, hb, a = hs
            spr, o, anc = figure(pose, scale, "hero", facing, bool(hb))
            paste(im, with_alpha(spr, a), (int(x - o[0]), int(y - o[1])))
            hand = (x + anc["ra"][0], y + anc["ra"][1])
        self.draw_props(im, t, front=True, hand=hand)
        self.draw_text(im, t, enemy_head)
        if self.set == "title":
            self.draw_title(im, t)
        # camera push + dip to black
        push = sc.get("push", 0.035)
        if push:
            z = 1 + push * (t / self.dur)
            cw, ch = W / z, H / z
            fx, fy = sc.get("focus", (W / 2, H / 2))
            x0 = min(max(fx - cw / 2, 0), W - cw); y0 = min(max(fy - ch / 2, 0), H - ch)
            im = im.resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch))
        fi, fo = sc.get("fade_in", 0.25), sc.get("fade_out", 0.25)
        k = 1.0
        if fi: k *= min(1, t / fi)
        if fo: k *= min(1, (self.dur - t) / fo)
        rgb = im.convert("RGB")
        if k < 0.999:
            rgb = Image.eval(rgb, lambda v: int(v * max(0, k)))
        return rgb

    def draw_walkers(self, im, t):
        wk = self.sc["walkers"]
        x0, y0, x1, y1 = wk.get("clip", self.info.get("window", (0, 0, W, H)))
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        for i, (start, speed, sc, gy) in enumerate(wk["list"]):
            x = start + speed * t
            names, per = CYCLES["walk"]
            spr, o, anc = figure(names[int(t / per + i) % 4], sc, "hero", "right" if speed > 0 else "left")
            spr = with_alpha(spr, wk.get("alpha", 0.75))
            paste(layer, spr, (int(x - o[0]), int(gy - o[1])))
            hx, hy = x + anc["ra"][0], gy + anc["ra"][1]
            ImageDraw.Draw(layer).rounded_rectangle([hx - 9 * sc * 2, hy, hx + 9 * sc * 2, hy + 30 * sc * 2],
                                                     radius=3, fill=(70, 60, 56, 200))
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).rectangle([x0, y0, x1, y1], fill=255)
        a = np.minimum(np.asarray(layer.split()[3]), np.asarray(mask))
        layer.putalpha(Image.fromarray(a))
        im.alpha_composite(layer)

    def draw_props(self, im, t, front, hand=None):
        d = ImageDraw.Draw(im)
        for p in self.sc.get("props", []):
            typ = p["type"]
            is_front = p.get("front", typ in ("hand_note", "bag", "phone"))
            if is_front != front:
                continue
            if t < p.get("appear", -1) or ("disappear" in p and t >= p["disappear"]):
                continue
            a = fade_at(t, p.get("appear", -1), p.get("fade", 0.25))
            if "fade_out" in p:
                a *= 1 - ease((t - p["fade_out"][0]) / (p["fade_out"][1] - p["fade_out"][0]))
            if a <= 0.01:
                continue
            if typ == "note":
                if "path" in p:
                    x, y = interp_path(p["path"], t)
                else:
                    x, y = p["x"], p["y"]
                if p.get("jitter"):
                    x += math.sin(t * 47) * p["jitter"]; y += math.cos(t * 39) * p["jitter"]
                spr = note_sprite(p.get("size", 70), p.get("text", "START"), p.get("rot", -3), p.get("big", False))
                if p.get("pop") is not None and t < p["pop"] + 0.25:
                    s = 1 + 0.25 * (1 - ease((t - p["pop"]) / 0.25))
                    spr = spr.resize((int(spr.width * s), int(spr.height * s)), Image.BILINEAR)
                paste(im, with_alpha(spr, a), (int(x - spr.width / 2), int(y - spr.height / 2)))
            elif typ == "note_wall":
                pos = note_wall_positions(p["count"])
                for i, (x, y, s, r, txt) in enumerate(pos):
                    ap = a
                    if p.get("new_at") is not None and i == len(pos) - 1:
                        if t < p["new_at"]:
                            continue
                        ap *= fade_at(t, p["new_at"], 0.15)
                    spr = note_sprite(s, txt, round(r))
                    paste(im, with_alpha(spr, ap), (int(x - spr.width / 2), int(y - spr.height / 2)))
            elif typ == "laptop":
                x, y = p.get("x", 1010), p.get("y", 690)
                op = p.get("state") == "open" or (p.get("open_at") is not None and t >= p["open_at"])
                col = PALETTES[self.pal]["dark"]
                d.rounded_rectangle([x, y - 8, x + 150, y], radius=3, fill=tuple(int(c * 0.6) for c in col))
                if op:
                    glow = Image.new("RGBA", (300, 260), (0, 0, 0, 0))
                    ImageDraw.Draw(glow).polygon([(150, 20), (0, 200), (0, 260), (150, 140)], fill=(170, 200, 230, 46))
                    paste(im, glow.filter(ImageFilter.GaussianBlur(14)), (x - 140, y - 240))
                    d.line([(x + 138, y - 6), (x + 112, y - 118)], fill=tuple(int(c * 0.6) for c in col), width=12)
                    d.line([(x + 132, y - 10), (x + 108, y - 112)], fill=(170, 200, 230), width=3)
                else:
                    d.rounded_rectangle([x + 2, y - 16, x + 148, y - 8], radius=3, fill=tuple(int(c * 0.5) for c in col))
            elif typ == "clock":
                x, y = p.get("x", 572), p.get("y", 742)
                ringing = p.get("ring") and p["ring"][0] <= t < p["ring"][1]
                dx = math.sin(t * 90) * 4 if ringing else 0
                d.rounded_rectangle([x + dx, y - 50, x + 60 + dx, y], radius=10, fill=(30, 22, 24))
                d.ellipse([x + 4 + dx, y - 66, x + 22 + dx, y - 48], fill=RED)
                d.ellipse([x + 38 + dx, y - 66, x + 56 + dx, y - 48], fill=RED)
                on = not (p.get("off_at") is not None and t >= p["off_at"])
                txt = text_img("6:00", "Inter-Bold.otf", 22, RED if on else (90, 40, 42), glow=RED if on else None)
                paste(im, txt, (int(x + 30 + dx - txt.width / 2), int(y - 25 - txt.height / 2)))
                if ringing and int(t * 6) % 2 == 0:
                    for r in (40, 58):
                        d.arc([x + 30 - r, y - 25 - r, x + 30 + r, y - 25 + r], 200, 250, fill=RED, width=4)
                        d.arc([x + 30 - r, y - 25 - r, x + 30 + r, y - 25 + r], 290, 340, fill=RED, width=4)
            elif typ == "drawer":
                if p.get("open") and p["open"][0] <= t < p["open"][1]:
                    col = PALETTES[self.pal]
                    d.rectangle([1250, 712, 1430, 780], fill=tuple(int(c * 0.5) for c in col["dark"]))
                    d.rounded_rectangle([1200, 770, 1420, 800], radius=3, fill=col["furn"])
                    d.rounded_rectangle([1200, 720, 1214, 800], radius=3, fill=col["dark"])
            elif typ == "pages":
                n = int(p["from"] + (p["to"] - p["from"]) * min(1, t / self.dur))
                x, y = p.get("x", 1300), p.get("y", 690)
                for i in range(n):
                    d.rectangle([x + (i % 3), y - 3 * (i + 1), x + 90 + (i % 3), y - 3 * i - 1],
                                fill=(246, 240, 228) if i % 2 else (226, 218, 204))
            elif typ == "book":
                x, y = p.get("x", 1160), p.get("y", 690)
                d.rounded_rectangle([x, y - 96, x + 70, y], radius=4, fill=(60, 44, 36))
                d.rectangle([x + 6, y - 92, x + 64, y - 4], fill=(110, 76, 52))
            elif typ == "phone" and hand:
                x, y = hand
                glow = Image.new("RGBA", (220, 220), (0, 0, 0, 0))
                ImageDraw.Draw(glow).ellipse([30, 30, 190, 190], fill=(150, 190, 240, 70))
                paste(im, glow.filter(ImageFilter.GaussianBlur(24)), (int(x - 110), int(y - 120)))
                d.rounded_rectangle([x - 8, y - 26, x + 8, y + 4], radius=3, fill=(20, 22, 30))
                d.rectangle([x - 6, y - 23, x + 6, y + 1], fill=(170, 205, 240))
            elif typ == "bag" and hand:
                x, y = hand
                d.rounded_rectangle([x - 18, y, x + 18, y + 54], radius=5, fill=(70, 52, 40))
            elif typ == "hand_note" and hand:
                spr = note_sprite(p.get("size", 54), p.get("text", "START"), p.get("rot", 6))
                paste(im, with_alpha(spr, a), (int(hand[0] - spr.width / 2 + 6), int(hand[1] - spr.height + 10)))
            elif typ == "arm_in":  # close-up hand holding note
                x, y = p["x"], p["y"]
                jx = math.sin(t * 47) * p.get("jitter", 0)
                d.line([(x + jx, y), (x + 120 + jx, H + 40)], fill=OUTLINE, width=62)
                d.line([(x + jx, y), (x + 120 + jx, H + 40)], fill=CREAM, width=52)
                d.ellipse([x - 34 + jx, y - 34, x + 34 + jx, y + 34], fill=OUTLINE)
                d.ellipse([x - 29 + jx, y - 29, x + 29 + jx, y + 29], fill=CREAM)

    def draw_text(self, im, t, enemy_head):
        sc = self.sc
        if sc.get("day"):
            label = sc["day"]
            cf = sc.get("day_from")
            if cf is not None:
                target = int(label.replace("DAY", "").replace(",", "").strip())
                u = ease((t - 0.3) / 0.9)
                label = "DAY {:,}".format(int(round(cf + (target - cf) * u)))
            a = fade_at(t, 0.1, 0.35)
            img = text_img(label, "Inter-Bold.otf", 52, CREAM, track=5)
            paste(im, with_alpha(img, a * 0.92), (70, 50))
            ImageDraw.Draw(im).rectangle([92, 146, 152, 149], fill=CREAM + (int(200 * a),))
        if sc.get("whisper"):
            wt = sc.get("whisper_at", 1.0)
            if t >= wt:
                a = fade_at(t, wt, 0.6, sc.get("whisper_end"), 0.5)
                img = text_img(sc["whisper"], "Inter-MediumItalic.otf", sc.get("whisper_size", 46), RED, glow=RED)
                if "whisper_xy" in sc:
                    x, y = sc["whisper_xy"]
                elif enemy_head:
                    hx, hy, s, f = enemy_head
                    # above the shadow's head, drifting away from the hero side
                    x = hx - img.width * (0.75 if f == "right" else 0.25)
                    y = hy - 60 * s - img.height - 10
                else:
                    x, y = W / 2 - img.width / 2, 300
                y -= 10 * (1 - ease((t - wt) / 1.0))
                x = min(max(x, 40), W - img.width - 40); y = min(max(y, 150), H - 200)
                paste(im, with_alpha(img, a), (int(x), int(y)))
        if sc.get("caption"):
            ct = sc.get("caption_at", 0.4)
            if t >= ct:
                a = fade_at(t, ct, 0.5)
                img = text_img(sc["caption"], "Inter-SemiBold.otf", sc.get("caption_size", 50), CREAM)
                if sc.get("caption_pos") == "center":
                    y = H / 2 - img.height / 2
                elif sc.get("caption_pos") == "top":
                    y = 150
                else:
                    y = H - 165
                paste(im, with_alpha(img, a), (int(W / 2 - img.width / 2), int(y)))

    def draw_title(self, im, t):
        tc = self.sc["title_card"]
        word = text_img(tc["word"], "Inter-Black.otf", 190, CREAM, track=22, shadow=False)
        paste(im, with_alpha(word, fade_at(t, 0.5, 1.2)), (int(W / 2 - word.width / 2), 270))
        for i, line in enumerate(tc["sub"]):
            img = text_img(line, "Inter-LightItalic.otf", 44, CREAM, shadow=False)
            paste(im, with_alpha(img, fade_at(t, 2.4 + i * 1.6, 0.9) * 0.9),
                  (int(W / 2 - img.width / 2), 560 + i * 66))
        img = text_img(tc["punch"], "Inter-Bold.otf", 50, RED, glow=RED)
        paste(im, with_alpha(img, fade_at(t, 6.0, 0.8)), (int(W / 2 - img.width / 2), 760))


def paste(dst, src, pos):
    x, y = pos
    sx, sy = max(0, -x), max(0, -y)
    dx, dy = max(0, x), max(0, y)
    w, h = min(src.width - sx, dst.width - dx), min(src.height - sy, dst.height - dy)
    if w <= 0 or h <= 0:
        return
    if sx or sy or w < src.width or h < src.height:
        src = src.crop((sx, sy, sx + w, sy + h))
    dst.alpha_composite(src, (dx, dy))


# ---------------------------------------------------------------- audio
NOTE_I = {"C": -9, "C#": -8, "D": -7, "D#": -6, "E": -5, "F": -4, "F#": -3, "G": -2, "G#": -1, "A": 0, "A#": 1, "B": 2}


def nfreq(n):
    name, octv = n[:-1], int(n[-1])
    return 440 * 2 ** ((NOTE_I[name] + 12 * (octv - 4)) / 12)


def bandnoise(n, lo, hi, rnd):
    x = rnd.standard_normal(n)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    X[(f < lo) | (f > hi)] = 0
    y = np.fft.irfft(X, n)
    return y / (np.abs(y).max() + 1e-9)


def build_audio(film, path):
    scenes = film["scenes"]
    total = sum(s["duration"] for s in scenes)
    N = int(total * SR) + SR
    out = np.zeros(N, np.float32)
    rnd = np.random.default_rng(7)
    starts, acc = [], 0.0
    for s in scenes:
        starts.append(acc); acc += s["duration"]

    def add(sig, t, gain=1.0):
        i = int(t * SR)
        if i >= N: return
        j = min(N, i + len(sig))
        out[i:j] += (sig[: j - i] * gain).astype(np.float32)

    def env(n, a, dcy):
        tt = np.arange(n) / SR
        return np.minimum(1, tt / max(a, 1e-4)) * np.exp(-tt * dcy)

    def piano(note, t, g=0.22):
        n = int(SR * 3.5); tt = np.arange(n) / SR; f = nfreq(note)
        s = sum(np.sin(2 * np.pi * f * k * tt * (1 + 0.0007 * k)) / k ** 1.6 for k in range(1, 7))
        add(s * env(n, 0.004, 1.6), t, g)

    def paper(t, g=0.35):
        n = int(SR * 0.09); add(bandnoise(n, 400, 5000, rnd) * env(n, 0.002, 40), t, g)
        add(np.sin(2 * np.pi * 110 * np.arange(n) / SR) * env(n, 0.001, 50), t, g * 0.5)

    def thump(t, g=0.6, f0=70):
        n = int(SR * 0.6); tt = np.arange(n) / SR
        add(np.sin(2 * np.pi * (f0 * tt + 40 * (1 - np.exp(-tt * 20)) / 20)) * env(n, 0.002, 8), t, g)
        add(bandnoise(n, 100, 2000, rnd) * env(n, 0.001, 30), t, g * 0.4)

    def kick(t, g=0.5):
        n = int(SR * 0.35); tt = np.arange(n) / SR
        ph = 2 * np.pi * (45 * tt + (110 - 45) * (1 - np.exp(-tt * 30)) / 30)
        add(np.sin(ph) * env(n, 0.001, 11), t, g)

    def alarm(t0, t1, g=0.16):
        t = t0
        while t < t1:
            n = int(SR * 0.09); tt = np.arange(n) / SR
            add(np.sign(np.sin(2 * np.pi * 2100 * tt)) * 0.5 * env(n, 0.002, 6), t, g)
            add(np.sign(np.sin(2 * np.pi * 2100 * tt)) * 0.5 * env(n, 0.002, 6), t + 0.13, g)
            t += 0.5

    def whisper(t, g=0.10):
        n = int(SR * 1.6); tt = np.arange(n) / SR
        e = np.sin(np.pi * np.clip(tt / 1.6, 0, 1)) ** 2
        add(bandnoise(n, 900, 4200, rnd) * e, t, g)
        add(np.sin(2 * np.pi * 72 * tt) * e, t, g * 1.4)

    def clicks(t0, t1, rate, g=0.12, lo=2000, hi=8000):
        t = t0
        n = int(SR * 0.02)
        while t < t1:
            add(bandnoise(n, lo, hi, rnd) * env(n, 0.0005, 300), t, g * (0.6 + 0.4 * rnd.random()))
            t += rate * (0.6 + 0.8 * rnd.random())

    # continuous beds: drone / pulse / city levels per scene, smoothed
    def level_curve(key):
        c = np.zeros(N, np.float32)
        for s, st in zip(scenes, starts):
            v = 0.0
            for e in s.get("sound", []):
                if e.startswith(key + "="):
                    v = float(e.split("=")[1])
            c[int(st * SR): int((st + s["duration"]) * SR)] = v
        k = int(0.6 * SR)
        cs = np.cumsum(np.concatenate([np.zeros(k), c, np.full(k, c[-1])]))
        return ((cs[2 * k:] - cs[:-2 * k]) / (2 * k))[:N].astype(np.float32)

    tt = np.arange(N) / SR
    drone = level_curve("drone")
    lfo = 0.75 + 0.25 * np.sin(2 * np.pi * 0.07 * tt)
    out += drone * lfo * (np.sin(2 * np.pi * 55 * tt) * 0.6 + np.sin(2 * np.pi * 82.41 * tt) * 0.35
                          + np.sin(2 * np.pi * 110.3 * tt) * 0.18)
    pulse = level_curve("pulse")
    # pad chords Am F C G at 92 bpm, 2 bars each
    beat = 60 / 92
    chords = [["A2", "C4", "E4", "A4"], ["F2", "A3", "C4", "F4"], ["C3", "E4", "G4", "C5"], ["G2", "B3", "D4", "G4"]]
    pad = np.zeros(N, np.float32)
    seg = beat * 8
    for i in range(int(total / seg) + 2):
        ch = chords[i % 4]
        a, b = int(i * seg * SR), min(N, int((i + 1) * seg * SR) + int(0.3 * SR))
        if a >= N: break
        ts = np.arange(b - a) / SR
        e = np.minimum(1, ts / 0.8) * np.minimum(1, np.maximum(0, (seg + 0.3 - ts)) / 0.6)
        pad[a:b] += e * sum(np.sin(2 * np.pi * nfreq(n) * ts) + 0.3 * np.sin(4 * np.pi * nfreq(n) * ts) for n in ch) / 5
    out += pad * pulse * 0.5
    pstart = None
    bt = 0.0
    while bt < total:
        lv = pulse[int(bt * SR)]
        if lv > 0.05:
            kick(bt, 0.55 * lv)
            if lv > 0.55:
                n = int(SR * 0.05)
                add(bandnoise(n, 5000, 12000, rnd) * env(n, 0.001, 60), bt + beat / 2, 0.08 * lv)
        bt += beat
    city = level_curve("city")
    out += city * np.tile(bandnoise(SR * 4, 150, 1200, rnd), int(N / (SR * 4)) + 1)[:N] * 0.6

    for s, st in zip(scenes, starts):
        if s.get("whisper"):
            whisper(st + s.get("whisper_at", 1.0))
        for e in s.get("sound", []):
            if "=" in e:
                continue
            name, _, when = e.partition("@")
            arg = None
            if ":" in name:
                name, arg = name.split(":", 1)
            if "-" in when:
                a0, a1 = (float(v) for v in when.split("-"))
            else:
                a0 = float(when) if when else 0.0; a1 = None
            t0 = st + a0
            if name == "piano":
                for k, nn in enumerate(arg.split("+")):
                    piano(nn, t0 + 0.0 * k)
            elif name == "paper":
                paper(t0)
            elif name == "rustle":
                n = int(SR * 0.7); add(bandnoise(n, 1500, 7000, rnd) * np.sin(np.pi * np.arange(n) / n), t0, 0.12)
            elif name == "thump":
                thump(t0)
            elif name == "hit":
                thump(t0, 0.9, 38)
                n = int(SR * 4); add(np.sin(2 * np.pi * 41 * np.arange(n) / SR) * env(n, 0.01, 1.0), t0, 0.35)
            elif name == "alarm":
                alarm(t0, st + a1 if a1 else t0 + 1.0)
            elif name == "clicks":
                clicks(t0, st + a1, 0.18, 0.10)
            elif name == "keys":
                clicks(t0, st + a1, 0.09, 0.13, 1500, 6000)
            elif name == "steps":
                clicks(t0, st + a1, 0.28, 0.25, 80, 1200)
            elif name == "heartbeat":
                t = t0
                while t < st + s["duration"]:
                    thump(t, 0.5, 48); thump(t + 0.22, 0.32, 44); t += 1.05
            elif name == "chord":
                for nn in ["A2", "E3", "A3", "C#4", "E4", "A4"]:
                    piano(nn, t0, 0.13)
                n = int(SR * 5); ts = np.arange(n) / SR
                add(sum(np.sin(2 * np.pi * nfreq(x) * ts) for x in ["A3", "C#4", "E4"]) / 3 * env(n, 0.4, 0.5), t0, 0.22)
            elif name == "swell":
                n = int(SR * (a1 - a0 if a1 else 3)); ts = np.arange(n) / SR
                e = (ts / ts[-1]) ** 2
                add(bandnoise(n, 200, 6000, rnd) * e, t0, 0.07)

    # master: gentle limiter, normalise
    out = np.tanh(out * 1.3) / np.tanh(1.3)
    out = out[: int(total * SR)]
    fade = int(0.8 * SR); out[-fade:] *= np.linspace(1, 0, fade)
    out = out / (np.abs(out).max() + 1e-9) * 0.89
    st = np.stack([out, np.roll(out, 24) * 0.97], 1)
    pcm = (st * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# ---------------------------------------------------------------- driver
def render_scene(args):
    idx, film, out, res, fps = args
    sc = Scene(film["scenes"][idx], film)
    n = max(1, int(round(sc.dur * fps)))
    ow, oh = int(res * 16 / 9) // 2 * 2, res
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{ow}x{oh}",
           "-r", str(fps), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
           "-pix_fmt", "yuv420p", "-r", str(fps), out]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in range(n):
        im = sc.frame(f / fps)
        if (ow, oh) != (W, H):
            im = im.resize((ow, oh), Image.LANCZOS)
        p.stdin.write(im.tobytes())
    p.stdin.close(); p.wait()
    return idx


def contact_sheet(film, path, at=0.6):
    thumbs = []
    acc = 0
    for i, s in enumerate(film["scenes"]):
        sc = Scene(s, film)
        im = sc.frame(sc.dur * s.get("sheet_at", at)).resize((480, 270), Image.LANCZOS)
        d = ImageDraw.Draw(im)
        d.rectangle([0, 0, 140, 30], fill=(0, 0, 0))
        d.text((6, 4), f"#{s.get('id', i + 1)}  {int(acc // 60)}:{acc % 60:04.1f}", font=font("Inter-Bold.otf", 18), fill=(255, 255, 255))
        thumbs.append(im); acc += s["duration"]
    cols = 5
    rows = math.ceil(len(thumbs) / cols)
    sheet = Image.new("RGB", (cols * 484 + 4, rows * 274 + 4), (30, 30, 30))
    for i, im in enumerate(thumbs):
        sheet.paste(im, (4 + (i % cols) * 484, 4 + (i // cols) * 274))
    sheet.save(path, quality=90)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("story")
    ap.add_argument("-o", "--out")
    ap.add_argument("--sheet")
    ap.add_argument("--res", type=int, default=1080)
    ap.add_argument("--fps", type=int)
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--only", help="comma list of scene indices (1-based) to render as stills")
    ap.add_argument("--workers", type=int, default=os.cpu_count())
    a = ap.parse_args()
    film = json.load(open(a.story))
    if a.sheet:
        contact_sheet(film, a.sheet); print("sheet ->", a.sheet)
    if a.only:
        for k in a.only.split(","):
            i = int(k) - 1; s = film["scenes"][i]
            Scene(s, film).frame(s["duration"] * s.get("sheet_at", 0.6)).save(f"still_{k}.png"); print("still", k)
    if not a.out:
        return
    res, fps = (360, 12) if a.preview else (a.res, a.fps or film.get("fps", 24))
    tmp = tempfile.mkdtemp(prefix="kaz_")
    jobs = [(i, film, os.path.join(tmp, f"s{i:03d}.mp4"), res, fps) for i in range(len(film["scenes"]))]
    with Pool(a.workers) as pool:
        for i in pool.imap_unordered(render_scene, jobs):
            print(f"scene {i + 1}/{len(jobs)} done", flush=True)
    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w") as f:
        for j in jobs:
            f.write(f"file '{j[2]}'\n")
    wav = os.path.join(tmp, "score.wav")
    build_audio(film, wav)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-i", wav,
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-shortest", "-movflags", "+faststart", a.out], check=True)
    print("film ->", a.out)


if __name__ == "__main__":
    main()
