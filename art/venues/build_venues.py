"""
Builds the three venue maps in Blender, entirely from code, and exports one
glTF file per venue for the game.

    blender -b --factory-startup --python art/venues/build_venues.py -- \
        --out public/models --draco --renders art/venues/renders --blend art/venues

    --out DIR      writes DIR/venue_beach.glb, venue_paris.glb, venue_sydney.glb
    --draco        Draco-compress the meshes, about 4x smaller (the game loads
                   them with the decoder in public/draco)
    --renders DIR  preview renders from the in-game cameras, plus a contact sheet
    --blend DIR    saves each map as a .blend you can open and look around in
    --only a,b     build only these venues (beach, paris, sydney)

The maps:

  - beach:  dunes, palm trees, umbrellas, a lifeguard tower and a pier, the
            surf rolling in, sailing boats, a lighthouse and a low sun.
  - paris:  the Eiffel Tower at the end of a Champ de Mars of lawns and
            clipped trees, avenues of Haussmann buildings, the gold dome of
            Les Invalides, a fountain and a carousel.
  - sydney: a harbourside promenade, the Opera House on its point, the
            Harbour Bridge, ferries, the city skyline and the North Shore.

COORDINATES. Everything is written in GAME coordinates: X across the court,
Y up, Z along it, the net at the origin, and the landmark beyond the FAR end
at +Z. `to_b` converts to Blender (Z up) when the meshes are made, and the
glTF exporter converts back, so the file lands in the game the right way up.
The game turns the whole map round for the player on the other side.

THE HOLE. The stadium (court, stands, floodlights) is drawn by the game, and
its own ground covers |x| < 24, |z| < 38 (see GROUND_HALF in Court.tsx). Each
map leaves a hole of |x| < HOLE_X, |z| < HOLE_Z and puts nothing inside it, so
the two overlap by 2m under the game's ground and never fight.

MATERIALS carry flags for the game as glTF extras (src/scene/VenueScenery.tsx
reads them):
  flat   - shade faceted (three.js flatShading). The export keeps vertices
           shared and smooth, which is much smaller; the facets come back in
           the shader.
  unlit  - drawn in plain colour, ignoring light (the sun disc).
  nofog  - not faded by the distance fog (sun, clouds).
Objects named Bob_* bob on the water and Cloud_* drift across the sky.
"""

import bpy
import math
import os
import random
import sys
from math import cos, sin, pi, exp
from mathutils import Vector

# --------------------------------------------------------------------------
# Arguments
# --------------------------------------------------------------------------

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


OUT_DIR = arg("--out")
OUT_RENDERS = arg("--renders")
OUT_BLEND = arg("--blend")
ONLY = arg("--only")
DRACO = "--draco" in argv

# The contract with the game: nothing of ours inside this rectangle.
HOLE_X = 22.0
HOLE_Z = 36.0

X_AX = Vector((1, 0, 0))
UP = Vector((0, 1, 0))
Z_AX = Vector((0, 0, 1))


def V(x, y=None, z=None):
    if y is None:
        return Vector(x)
    return Vector((x, y, z))


def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def in_hole(x, z, margin=0.0):
    return abs(x) < HOLE_X + margin and abs(z) < HOLE_Z + margin


def out_of_hole(x, z):
    return max(abs(x) - HOLE_X, abs(z) - HOLE_Z, 0.0)


def coords(a, b, step, extra=()):
    n = max(1, int(round((b - a) / step)))
    vals = {round(a + (b - a) * k / n, 3) for k in range(n + 1)}
    vals.update(round(e, 3) for e in extra if a < e < b)
    return sorted(vals)


def spans(*parts, extra=()):
    """Join several coords() runs, e.g. coarse far away and fine nearby."""
    vals = set()
    for a, b, step in parts:
        vals.update(coords(a, b, step))
    lo, hi = min(vals), max(vals)
    vals.update(round(e, 3) for e in extra if lo < e < hi)
    return sorted(vals)


# --------------------------------------------------------------------------
# Materials. Colours are sRGB hex, as in the game's palettes.
# --------------------------------------------------------------------------

MATS = {
    # Sky
    "Cloud": dict(color="#ffffff", rough=1.0, emit=0.45, nofog=True),
    "Sun": dict(color="#fff3c4", unlit=True, nofog=True),
    "SunHalo": dict(color="#fbe7b0", unlit=True, nofog=True),

    # Shared nature
    "Bark": dict(color="#6b4e33"),
    "Leaf": dict(color="#4f8a3a"),
    "Leaf2": dict(color="#3f7a33"),
    "FigLeaf": dict(color="#2f6b35"),
    "Rock": dict(color="#8c8478"),
    "Pole": dict(color="#eef1f4", rough=0.5),
    "Hull": dict(color="#f7f7f2", rough=0.5),
    "HullStripe": dict(color="#2f5fa8"),
    "SailWhite": dict(color="#fbf8ef", double=True),
    "SailOrange": dict(color="#f08a3c", double=True),
    "SailRed": dict(color="#e0503a", double=True),
    "Window": dict(color="#2d3b4c", rough=0.3, metal=0.2),
    "LampGlass": dict(color="#fff1c9", emit=0.6),

    # Beach
    "Sand": dict(color="#e6cf98"),
    "WetSand": dict(color="#cdb47c"),
    "Shallow": dict(color="#38b8c9", rough=0.25, emit=0.12),
    "Sea": dict(color="#1f8fc9", rough=0.25, emit=0.12),
    "Foam": dict(color="#f4fbfd", emit=0.25, double=True),
    "PalmTrunk": dict(color="#8a6a45"),
    "PalmTrunk2": dict(color="#6d5236"),
    "PalmLeaf": dict(color="#2f8f3e", double=True),
    "PalmLeaf2": dict(color="#3aa04a", double=True),
    "Coconut": dict(color="#5b3f22"),
    "DuneGrass": dict(color="#8ea35a"),
    "Canvas": dict(color="#f7f3ea", double=True),
    "FabRed": dict(color="#e8503a", double=True),
    "FabYellow": dict(color="#f0b429", double=True),
    "FabBlue": dict(color="#2f7fe8", double=True),
    "FabGreen": dict(color="#37b46b", double=True),
    "FabPink": dict(color="#e05aa8", double=True),
    "Wood": dict(color="#a07a52"),
    "WoodDark": dict(color="#7a5a3a"),
    "GuardRed": dict(color="#e8503a"),
    "HutBlue": dict(color="#7cc3e8"),
    "HutMint": dict(color="#8fdcc0"),
    "HutYellow": dict(color="#f6d36b"),
    "HutPink": dict(color="#f3a6b8"),
    "HutRoof": dict(color="#f4f1ea"),
    "HutDoor": dict(color="#3b4a5a"),
    "IslandGrass": dict(color="#6f9a55"),
    "LHRed": dict(color="#d8443a"),
    "LHWhite": dict(color="#f6f4ee"),
    "Net": dict(color="#2a2f36", double=True),

    # Paris
    "ParkGrass": dict(color="#557f3e"),
    "Lawn": dict(color="#6aa84f"),
    "Lawn2": dict(color="#5f9c46"),
    "Lawn3": dict(color="#4e8a3c"),
    "Gravel": dict(color="#d9c9a3"),
    "Road": dict(color="#5f6368"),
    "RoadLine": dict(color="#eeeeee"),
    "Pavement": dict(color="#cfc6b4"),
    "Hedge": dict(color="#3f7d36"),
    "Stone": dict(color="#e9dcc3"),
    "StoneLight": dict(color="#f3ead8"),
    "StoneDark": dict(color="#d2c3a6"),
    "Roof": dict(color="#5d6b7c"),
    "Chimney": dict(color="#b8653f"),
    "Balcony": dict(color="#2b2f33"),
    "Shop": dict(color="#33302c", rough=0.3),
    "AwnRed": dict(color="#b8383a", double=True),
    "AwnGreen": dict(color="#2f6b4a", double=True),
    "AwnNavy": dict(color="#28406b", double=True),
    "Iron": dict(color="#7a5f45", rough=0.7, metal=0.2),
    "IronDark": dict(color="#5e4835", rough=0.7, metal=0.2),
    "TowerGlass": dict(color="#3c4a55", rough=0.3, metal=0.3),
    "TowerStone": dict(color="#bfae90"),
    "Gold": dict(color="#d9a93a", rough=0.35, metal=0.6),
    "LampGreen": dict(color="#2f4a3b"),
    "Poster": dict(color="#efe3c2"),
    "FountainWater": dict(color="#7fb7d6", rough=0.2, emit=0.15),
    "Spray": dict(color="#eef6fa", emit=0.4),
    "Carousel": dict(color="#d8443a", double=True),
    "CarouselWhite": dict(color="#f6f1e6", double=True),

    # Sydney
    "Plaza": dict(color="#8b949c"),
    "Paving": dict(color="#b7b2a6"),
    "Sandstone": dict(color="#c8b48e"),
    "Harbour": dict(color="#1d6aa3", rough=0.25, emit=0.12),
    "Steel": dict(color="#6d757d", rough=0.5, metal=0.4),
    "BridgeSteel": dict(color="#7d858d", rough=0.55, metal=0.35),
    "Granite": dict(color="#b9aa92"),
    "Podium": dict(color="#c9a88a"),
    "Steps": dict(color="#d6c3a8"),
    "Shell": dict(color="#f6f2e8", rough=0.35, emit=0.18, flat=False, double=True),
    "OperaGlass": dict(color="#4a3f33", rough=0.2, metal=0.3),
    "CityGround": dict(color="#9a9c98"),
    "ShoreGrass": dict(color="#5f8f4e"),
    "Glass1": dict(color="#9fb3c6", rough=0.3, metal=0.3),
    "Glass2": dict(color="#7f93a8", rough=0.3, metal=0.3),
    "Glass3": dict(color="#c2ccd6", rough=0.3, metal=0.3),
    "Glass4": dict(color="#6f8296", rough=0.3, metal=0.3),
    "Band": dict(color="#3e4d5e", rough=0.3, metal=0.3),
    "HouseWall": dict(color="#e8dcc8"),
    "HouseRoof": dict(color="#b5553c"),
    "FerryGreen": dict(color="#1f6b3a"),
    "FerryCream": dict(color="#efe6c8"),
    "FerryYellow": dict(color="#f2c230"),
    "LampHead": dict(color="#fff6dc", emit=0.5),
}

# Preview-only (the stand-in stadium in the renders). Never exported.
PREVIEW_MATS = ("PxGround", "PxRunoff", "PxCourt", "PxStand0", "PxStand1", "PxLight")


def lin(hex_):
    h = hex_.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1.0]


_made = {}


def get_mat(name):
    if name in _made:
        return _made[name]
    s = MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    col = lin(s["color"])
    b.inputs["Base Color"].default_value = col
    b.inputs["Roughness"].default_value = s.get("rough", 0.9)
    b.inputs["Metallic"].default_value = s.get("metal", 0.0)
    emit = 1.0 if s.get("unlit") else s.get("emit", 0.0)
    if emit > 0:
        b.inputs["Emission Color"].default_value = col
        b.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = col
    m.use_backface_culling = not s.get("double", False)
    if s.get("unlit"):
        m["unlit"] = 1
    elif s.get("flat", True):
        m["flat"] = 1
    if s.get("nofog"):
        m["nofog"] = 1
    _made[name] = m
    return m


# --------------------------------------------------------------------------
# Mesh building. Geometry is gathered per object and per material in plain
# Python lists, then turned into one Blender mesh per object at the end:
# far faster than creating thousands of objects, and it makes the export one
# draw call per material instead of one per palm tree.
# --------------------------------------------------------------------------

OBJS = []


class Obj:
    def __init__(self, name, origin=(0, 0, 0)):
        self.name = name
        self.origin = V(origin)
        self.parts = {}
        OBJS.append(self)

    def add(self, mat, verts, faces):
        if mat not in MATS:
            raise KeyError(mat)
        vs, fs = self.parts.setdefault(mat, ([], []))
        off = len(vs)
        vs.extend(V(v) for v in verts)
        fs.extend(tuple(i + off for i in f) for f in faces)
        return off


def frame(d, hint=None):
    """A right-handed frame (x, y, d) with d along the given direction."""
    d = V(d).normalized()
    h = hint if hint is not None else UP
    if abs(d.dot(h.normalized())) > 0.97:
        h = X_AX if abs(d.dot(X_AX)) < 0.9 else Z_AX
    x = h.cross(d).normalized()
    y = d.cross(x)
    return x, y, d


# Corner i of a box has x, y, z from bits 0, 1, 2. Faces wind outward.
BOX_FACES = ((0, 2, 3, 1), (4, 5, 7, 6), (0, 4, 6, 2), (1, 3, 7, 5), (0, 1, 5, 4), (2, 6, 7, 3))
NO_BOTTOM = BOX_FACES[:4] + BOX_FACES[5:]
AXES = (X_AX, UP, Z_AX)


def yaw_axes(yaw):
    """Axes turned about Y. The third (local +Z) is the 'front'."""
    return (V(cos(yaw), 0, -sin(yaw)), UP.copy(), V(sin(yaw), 0, cos(yaw)))


def corners(c, size, axes=AXES):
    c = V(c)
    h = [s / 2 for s in size]
    return [c + axes[0] * (h[0] if i & 1 else -h[0]) + axes[1] * (h[1] if i & 2 else -h[1])
            + axes[2] * (h[2] if i & 4 else -h[2]) for i in range(8)]


def box(o, mat, c, size, axes=AXES, faces=BOX_FACES):
    o.add(mat, corners(c, size, axes), faces)


def slab(o, mat, x0, x1, y0, y1, z0, z1, faces=BOX_FACES):
    box(o, mat, ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)),
        faces=faces)


def beam(o, mat, a, b, w, h=None, hint=None, caps=False):
    a, b = V(a), V(b)
    d = b - a
    if d.length < 1e-6:
        return
    x, y, z = frame(d, hint)
    box(o, mat, (a + b) / 2, (w, h if h else w, d.length), (x, y, z), BOX_FACES if caps else BOX_FACES[2:])


def lathe(o, mat, base, profile, n=8, axis=None, sx=1.0, sy=1.0, rot=0.0, caps=(True, True), hint=None):
    """
    Surface of revolution. `profile` is (radius, height) pairs from the bottom
    round the outside to the top; a radius of 0 is a pole. For the default up
    axis, `sx` scales along world Z and `sy` along world X.
    """
    base = V(base)
    x, y, d = frame(axis if axis is not None else UP, hint)
    verts, rings = [], []
    for r, h in profile:
        if r <= 1e-9:
            rings.append([len(verts)])
            verts.append(base + d * h)
        else:
            ring = []
            for i in range(n):
                t = rot + 2 * pi * i / n
                ring.append(len(verts))
                verts.append(base + d * h + x * (r * cos(t) * sx) + y * (r * sin(t) * sy))
            rings.append(ring)
    faces = []
    for A, B in zip(rings, rings[1:]):
        if len(A) == 1 and len(B) == 1:
            continue
        for i in range(n):
            j = (i + 1) % n
            if len(A) == 1:
                faces.append((A[0], B[j], B[i]))
            elif len(B) == 1:
                faces.append((A[i], A[j], B[0]))
            else:
                faces.append((A[i], A[j], B[j], B[i]))
    if caps[0] and len(rings[0]) > 1:
        faces.append(tuple(reversed(rings[0])))
    if caps[1] and len(rings[-1]) > 1:
        faces.append(tuple(rings[-1]))
    off = o.add(mat, verts, faces)
    return off, len(verts)


def cyl(o, mat, a, b, r0, r1=None, n=8, caps=(True, True), hint=None):
    a, b = V(a), V(b)
    d = b - a
    return lathe(o, mat, a, [(r0, 0.0), (r0 if r1 is None else r1, d.length)], n, axis=d, caps=caps, hint=hint)


def cone(o, mat, base, r, h, n=8, rot=0.0):
    return lathe(o, mat, base, [(r, 0.0), (0.0, h)], n, rot=rot)


def ellipsoid(o, mat, c, rx, ry, rz, n=8, m=5, rot=0.0):
    prof = []
    for k in range(m + 1):
        phi = -pi / 2 + pi * k / m
        prof.append((0.0 if k in (0, m) else cos(phi), sin(phi) * ry))
    return lathe(o, mat, c, prof, n, sx=rz, sy=rx, rot=rot)


def jitter(o, mat, off, count, c, amt, rng):
    vs = o.parts[mat][0]
    c = V(c)
    for k in range(off, off + count):
        vs[k] = c + (vs[k] - c) * (1 + rng.uniform(-amt, amt))


def tube(o, mat, pts, radii, n=6, hint=None, caps=(True, True)):
    pts = [V(p) for p in pts]
    verts, rings = [], []
    for k, p in enumerate(pts):
        if k == 0:
            t = pts[1] - pts[0]
        elif k == len(pts) - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[k + 1] - pts[k - 1]
        x, y, _ = frame(t, hint)
        ring = []
        for i in range(n):
            a = 2 * pi * i / n
            ring.append(len(verts))
            verts.append(p + x * (radii[k] * cos(a)) + y * (radii[k] * sin(a)))
        rings.append(ring)
    faces = []
    for A, B in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            faces.append((A[i], A[j], B[j], B[i]))
    if caps[0]:
        faces.append(tuple(reversed(rings[0])))
    if caps[1]:
        faces.append(tuple(rings[-1]))
    o.add(mat, verts, faces)


def extrude(o, mat, poly, y0, y1, caps=(True, True)):
    """A prism from a polygon of (x, z) points, either winding."""
    pts = [(float(p[0]), float(p[1])) for p in poly]
    n = len(pts)
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    if area > 0:
        pts.reverse()
    verts = [V(x, y0, z) for x, z in pts] + [V(x, y1, z) for x, z in pts]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    if caps[1]:
        faces.append(tuple(range(n, 2 * n)))
    if caps[0]:
        faces.append(tuple(reversed(range(n))))
    o.add(mat, verts, faces)


def quad(o, mat, a, b, c, d):
    o.add(mat, [a, b, c, d], [(0, 1, 2, 3)])


def tri(o, mat, a, b, c):
    o.add(mat, [a, b, c], [(0, 1, 2)])


def rect(o, mat, x0, x1, z0, z1, y):
    """A flat rectangle facing up."""
    quad(o, mat, V(x0, y, z0), V(x0, y, z1), V(x1, y, z1), V(x1, y, z0))


def ribbon(o, mat, A, B):
    verts = list(A) + list(B)
    n = len(A)
    o.add(mat, verts, [(i, n + i, n + i + 1, i + 1) for i in range(n - 1)])


def facade_quad(o, mat, center, R, U, w, h):
    """A rectangle on a wall, facing R x U (the wall's outward normal)."""
    p0 = center - R * (w / 2) - U * (h / 2)
    quad(o, mat, p0, p0 + R * w, p0 + R * w + U * h, p0 + U * h)


def grid(o, xs, zs, hfn, matfn):
    """A height field. `matfn(cx, cz)` picks each cell's material, or None to skip it."""
    store = {}
    for i in range(len(xs) - 1):
        for j in range(len(zs) - 1):
            cx, cz = (xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2
            m = matfn(cx, cz)
            if m is None:
                continue
            vm, verts, faces = store.setdefault(m, ({}, [], []))
            ids = []
            for a, b in ((i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j)):
                if (a, b) not in vm:
                    vm[(a, b)] = len(verts)
                    verts.append(V(xs[a], hfn(xs[a], zs[b]), zs[b]))
                ids.append(vm[(a, b)])
            faces.append(tuple(ids))
    for m, (_, verts, faces) in store.items():
        o.add(m, verts, faces)


# --------------------------------------------------------------------------
# Shared props
# --------------------------------------------------------------------------

def cloud(name, c, s, rng):
    o = Obj(name, c)
    c = V(c)
    for k in range(rng.randint(4, 6)):
        off = V(rng.uniform(-1, 1) * 9 * s, rng.uniform(0, 1) * 2.2 * s, rng.uniform(-1, 1) * 3 * s)
        if k == 0:
            off = V(0, 0, 0)
        r = rng.uniform(4.5, 7.5) * s
        ellipsoid(o, "Cloud", c + off, r * 1.35, r * 0.68, r, n=8, m=4, rot=rng.uniform(0, 1))


def clouds(rng, spots):
    for k, (x, y, z, s) in enumerate(spots):
        cloud(f"Cloud_{k}", (x, y, z), s, rng)


def rock(o, c, r, rng, mat="Rock"):
    off, n = ellipsoid(o, mat, c, r * rng.uniform(0.9, 1.35), r * rng.uniform(0.5, 0.8), r, n=6, m=4,
                       rot=rng.uniform(0, 1))
    jitter(o, mat, off, n, c, 0.28, rng)


def round_tree(o, base, s, rng, leaf="Leaf"):
    base = V(base)
    cyl(o, "Bark", base, base + UP * (3.2 * s), 0.26 * s, 0.18 * s, n=5, caps=(False, False))
    top = base + UP * (4.6 * s)
    for k in range(3):
        a = rng.uniform(0, 2 * pi)
        off = V(cos(a), 0, sin(a)) * (rng.uniform(0.4, 1.2) * s) + UP * (rng.uniform(-0.3, 1.0) * s)
        r = rng.uniform(1.8, 2.5) * s
        ellipsoid(o, leaf if k % 2 == 0 else "Leaf2", top + off, r, r * 0.85, r, n=7, m=4, rot=a)


def fig_tree(o, base, s, rng):
    base = V(base)
    cyl(o, "Bark", base, base + UP * (3.0 * s), 0.55 * s, 0.4 * s, n=6, caps=(False, False))
    top = base + UP * (4.8 * s)
    for k in range(4):
        a = 2 * pi * k / 4 + rng.uniform(-0.3, 0.3)
        off = V(cos(a), 0, sin(a)) * (2.3 * s) + UP * (rng.uniform(-0.2, 0.8) * s)
        r = rng.uniform(3.0, 3.8) * s
        ellipsoid(o, "FigLeaf", top + off, r, r * 0.6, r, n=7, m=4, rot=a)


def sailboat(name, c, yaw, sail):
    o = Obj(name, c)
    c = V(c)
    X, _, Z = yaw_axes(yaw)
    hull = [(-3.2, -0.95), (2.0, -1.05), (3.9, 0.0), (2.0, 1.05), (-3.2, 0.95)]
    pts = [c + X * u + Z * v for u, v in hull]
    extrude(o, "Hull", [(p.x, p.z) for p in pts], c.y - 0.35, c.y + 0.75)
    pts = [c + X * (u * 1.03) + Z * (v * 1.04) for u, v in hull]
    extrude(o, "HullStripe", [(p.x, p.z) for p in pts], c.y + 0.35, c.y + 0.5, caps=(False, False))
    m = c + X * 0.6
    cyl(o, "Pole", m + UP * 0.7, m + UP * 9.6, 0.08, 0.06, n=5)
    tri(o, sail, m + UP * 1.5, m + UP * 9.3, c + X * (-2.9) + UP * 1.5)
    tri(o, sail, m + UP * 8.6, c + X * 3.7 + UP * 1.0, m + UP * 1.3 + X * 0.15)


def bench(o, base, yaw, mat="Wood"):
    X, U, Z = yaw_axes(yaw)
    base = V(base)
    box(o, mat, base + U * 0.45, (1.8, 0.08, 0.5), (X, U, Z))
    box(o, mat, base + U * 0.8 - Z * 0.24, (1.8, 0.45, 0.06), (X, U, Z))
    for sx in (-1, 1):
        box(o, "Balcony", base + U * 0.22 + X * (sx * 0.8), (0.08, 0.44, 0.45), (X, U, Z))


# --------------------------------------------------------------------------
# BEACH
# --------------------------------------------------------------------------

def palm(o, base, height, lean_dir, lean, rng):
    base = V(base)
    top = base + UP * height + lean_dir * lean
    ctrl = base + UP * (height * 0.6)
    pts, radii = [], []
    n = 7
    for k in range(n + 1):
        t = k / n
        pts.append((1 - t) ** 2 * base + 2 * (1 - t) * t * ctrl + t * t * top)
        radii.append((0.34 - 0.14 * t) * (1.1 if k % 2 else 0.95))
    tube(o, "PalmTrunk", pts, radii, n=6, hint=X_AX, caps=(False, True))
    ellipsoid(o, "PalmTrunk2", top, 0.42, 0.5, 0.42, n=6, m=3)
    a0 = rng.uniform(0, 2 * pi)
    for k in range(8):
        ang = a0 + 2 * pi * k / 8 + rng.uniform(-0.18, 0.18)
        frond(o, "PalmLeaf" if k % 2 else "PalmLeaf2", top + UP * 0.25, ang, rng.uniform(3.6, 4.8), 0.78,
              rng.uniform(0.3, 0.6), rng.uniform(0.9, 1.35))
    for k in range(3):
        a = a0 + k * 2.1
        ellipsoid(o, "Coconut", top + V(cos(a), 0, sin(a)) * 0.38 - UP * 0.35, 0.22, 0.24, 0.22, n=5, m=3)


def frond(o, mat, root, ang, length, width, rise, droop, segs=5):
    H = V(cos(ang), 0, sin(ang))
    S = UP.cross(H)
    mid, L, R = [], [], []
    for k in range(segs + 1):
        t = k / segs
        p = root + H * (length * t) + UP * (length * (rise * t - droop * t * t))
        w = width * sin(pi * min(t * 1.1, 1.0)) ** 0.8 if k else 0.0
        sag = UP * (-w * 0.45)
        mid.append(p)
        L.append(p + S * w + sag)
        R.append(p - S * w + sag)
    ribbon(o, mat, mid, L)
    ribbon(o, mat, R, mid)


def umbrella(o, base, fabric):
    base = V(base)
    top = base + UP * 2.4
    cyl(o, "Pole", base, top + UP * 0.6, 0.045, n=4)
    apex = top + UP * 0.6
    n = 10
    for i in range(n):
        a0, a1 = 2 * pi * i / n, 2 * pi * (i + 1) / n
        p0 = top + V(sin(a0), 0, cos(a0)) * 1.65
        p1 = top + V(sin(a1), 0, cos(a1)) * 1.65
        tri(o, fabric if i % 2 == 0 else "Canvas", p0, p1, apex)


def lounger(o, base, yaw, fabric):
    X, U, Z = yaw_axes(yaw)
    base = V(base)
    box(o, fabric, base + U * 0.32, (0.7, 0.08, 1.4), (X, U, Z))
    beam(o, fabric, base + U * 0.32 - Z * 0.7, base + U * 0.95 - Z * 1.05, 0.7, 0.08, hint=X)
    for sz in (-1, 1):
        box(o, "Pole", base + U * 0.15 + Z * (sz * 0.55), (0.66, 0.3, 0.05), (X, U, Z))


def beach_hut(o, base, yaw, body):
    X, U, Z = yaw_axes(yaw)
    base = V(base)
    w, d, h = 2.8, 2.6, 2.5
    box(o, body, base + U * (h / 2), (w, h, d), (X, U, Z))
    ridge = base + U * (h + 1.0)
    for sx in (-1, 1):
        eave = base + U * (h - 0.1) + X * (sx * (w / 2 + 0.3))
        beam(o, "HutRoof", eave, ridge, 0.14, d + 0.5, hint=Z)
    for sz in (-1, 1):
        f = Z * (sz * (d / 2 + 0.01))
        l, r = base + U * h - X * (w / 2) + f, base + U * h + X * (w / 2) + f
        if sz > 0:
            tri(o, body, l, r, ridge - U * 0.05 + f)
        else:
            tri(o, body, r, l, ridge - U * 0.05 + f)
    facade_quad(o, "HutDoor", base + U * 1.0 + Z * (d / 2 + 0.03), X, U, 1.0, 1.9)


def lifeguard_tower(o, base):
    base = V(base)
    deck = 2.8
    for sx in (-1, 1):
        for sz in (-1, 1):
            beam(o, "HutRoof", base + V(sx * 1.2, 0, sz * 1.2), base + V(sx * 0.95, deck, sz * 0.95), 0.16, caps=True)
    slab(o, "Wood", base.x - 1.5, base.x + 1.5, base.y + deck, base.y + deck + 0.2, base.z - 1.5, base.z + 1.5)
    slab(o, "GuardRed", base.x - 1.1, base.x + 1.1, base.y + deck + 0.2, base.y + deck + 1.9, base.z - 1.1,
         base.z + 1.1)
    facade_quad(o, "Window", base + V(0, deck + 1.35, -1.12), -X_AX, UP, 1.6, 0.7)
    cone(o, "HutRoof", base + UP * (deck + 1.9), 1.9, 0.9, n=4, rot=pi / 4)
    beam(o, "Wood", base + V(0, deck + 0.1, -1.5), base + V(0, 0.0, -4.6), 0.12, 0.9, hint=X_AX)
    top = base + UP * (deck + 2.8)
    cyl(o, "Pole", base + UP * (deck + 2.4), top + UP * 1.4, 0.04, n=4)
    tri(o, "FabRed", top + UP * 1.4, top + UP * 0.8, top + UP * 1.1 + X_AX * 1.0)


def pier(o, x, z0, z1, rng):
    y = 1.3
    slab(o, "Wood", x - 2.0, x + 2.0, y, y + 0.25, z0, z1)
    z = z0 + 4
    while z < z1:
        for sx in (-1, 1):
            cyl(o, "WoodDark", V(x + sx * 1.75, -1.6, z), V(x + sx * 1.75, y, z), 0.2, n=5, caps=(False, False))
        z += 8
    z = z0 + 2
    while z < z1:
        for sx in (-1, 1):
            beam(o, "WoodDark", V(x + sx * 1.9, y + 0.25, z), V(x + sx * 1.9, y + 1.25, z), 0.1)
        z += 4
    for sx in (-1, 1):
        beam(o, "WoodDark", V(x + sx * 1.9, y + 1.25, z0 + 2), V(x + sx * 1.9, y + 1.25, z1 - 1), 0.12)
    # A shack at the end.
    slab(o, "HutBlue", x - 1.6, x + 1.6, y + 0.25, y + 2.7, z1 - 5, z1 - 1.5)
    beam(o, "HutRoof", V(x - 2.0, y + 2.6, z1 - 3.25), V(x + 2.0, y + 2.6, z1 - 3.25), 0.15, 4.2)


def lighthouse(o, base, h=16.0):
    base = V(base)
    bands = 6
    for k in range(bands):
        y0, y1 = h * k / bands, h * (k + 1) / bands
        r0, r1 = 2.2 - 0.8 * k / bands, 2.2 - 0.8 * (k + 1) / bands
        cyl(o, "LHRed" if k % 2 else "LHWhite", base + UP * y0, base + UP * y1, r0, r1, n=10,
            caps=(False, k == bands - 1))
    cyl(o, "Balcony", base + UP * h, base + UP * (h + 0.3), 1.9, n=10)
    cyl(o, "LampGlass", base + UP * (h + 0.3), base + UP * (h + 2.2), 1.0, n=8, caps=(False, False))
    cone(o, "LHRed", base + UP * (h + 2.2), 1.3, 1.2, n=8)


def build_beach():
    rng = random.Random(7)
    S = Obj("Beach")
    WATER_Y = -0.35
    SHORE = 52.0

    def ground(x, z):
        out = out_of_hole(x, z)
        ramp = smoothstep(0, 40, out)
        d = 1.4 + 1.1 * sin(x * 0.045 + 1.3) * cos(z * 0.055) + 0.6 * sin(x * 0.11 + z * 0.07 + 0.5)
        d = max(d, 0.0) * ramp * (1 + 1.6 * smoothstep(-50, -170, z) + 0.9 * smoothstep(60, 220, abs(x)))
        d *= smoothstep(SHORE - 6, SHORE - 28, z)
        y = -0.06 + d
        if z > SHORE - 5:
            y -= (z - (SHORE - 5)) * 0.06
        return y

    xs = spans((-600, -130, 22), (-130, 130, 8), (130, 600, 22), extra=(-HOLE_X, HOLE_X))
    zs = spans((-320, -70, 20), (-70, SHORE + 4, 5), extra=(-HOLE_Z, HOLE_Z, 44.5, SHORE + 0.5))

    def sand_mat(cx, cz):
        if in_hole(cx, cz):
            return None
        return "WetSand" if 44.5 < cz < SHORE + 0.5 else "Sand"

    grid(S, xs, zs, ground, sand_mat)

    # The sea: calm by the shore, rolling further out.
    def sea(x, z):
        a = 0.05 + 0.4 * smoothstep(60, 300, z)
        return WATER_Y + a * (sin(x * 0.08 + z * 0.19) + 0.6 * sin(x * 0.21 - z * 0.11 + 1.0))

    grid(S, coords(-640, 640, 20), spans((48, 100, 6), (100, 680, 18), extra=(66,)), sea,
         lambda cx, cz: "Shallow" if cz < 66 else "Sea")

    # Surf: a foam line on the sand's edge and broken lines of breakers.
    def foam(z0, y, width, amp, freq, phase, gap):
        run = []
        for x in coords(-640, 640, 5) + [None]:
            keep = x is not None and (gap is None or sin(x * 0.031 + phase) + 0.5 * sin(x * 0.077) > gap)
            if keep:
                run.append(x)
                continue
            if len(run) >= 2:
                A, B = [], []
                for xx in run:
                    zc = z0 + amp * sin(xx * freq + phase) + 0.4 * amp * sin(xx * freq * 2.7 + 1.3)
                    w = width * (0.7 + 0.3 * sin(xx * 0.2))
                    A.append(V(xx, y, zc - w))
                    B.append(V(xx, y, zc + w))
                ribbon(S, "Foam", A, B)
            run = []

    foam(SHORE + 0.4, WATER_Y + 0.13, 0.9, 0.9, 0.05, 0.0, None)
    foam(SHORE + 7, WATER_Y + 0.12, 0.6, 1.4, 0.04, 1.7, 0.1)
    foam(SHORE + 17, WATER_Y + 0.15, 0.5, 2.0, 0.03, 3.1, 0.6)

    # Palms: clusters either side of the court and a line along the shore.
    spots = [(-30, -6), (-34, 14), (-27, 30), (-44, 4), (-40, -24), (-52, 22), (29, -10), (33, 10), (27, 31),
             (45, -2), (41, 24), (56, 12), (-27, 46), (-40, 44), (30, 47), (43, 43), (-64, 40), (72, 44),
             (-92, 38), (98, 40), (-122, 42), (132, 38), (-160, 41), (168, 42), (-205, 40), (210, 39),
             (-70, -40), (75, -45), (-28, -46), (30, -48), (-100, -10), (104, 6)]
    for x, z in spots:
        lean_dir = V(rng.uniform(-0.4, 0.4) + (0.5 if x > 0 else -0.5), 0, 0.6 + rng.uniform(-0.3, 0.5)).normalized()
        palm(S, (x, ground(x, z) - 0.1, z), rng.uniform(7.2, 10.5), lean_dir, rng.uniform(1.2, 3.2), rng)

    # Umbrellas, towels and loungers behind the far stand, facing the sea.
    fabrics = ["FabRed", "FabYellow", "FabBlue", "FabGreen", "FabPink"]
    for k, x in enumerate((-17, -9, -1, 7, 15, -33, 55)):
        z = 41.5 + (k % 2) * 2.5
        f = fabrics[k % len(fabrics)]
        umbrella(S, (x, ground(x, z), z), f)
        lounger(S, (x + 1.3, ground(x + 1.3, z), z + 0.2), 0.1, f)
        lounger(S, (x - 1.2, ground(x - 1.2, z), z + 0.4), -0.15, "Canvas")

    lifeguard_tower(S, V(24, ground(24, 45), 45))
    pier(S, -62.0, 44.0, 150.0, rng)

    for k, body in enumerate(("HutBlue", "HutMint", "HutYellow", "HutPink", "HutBlue", "HutYellow")):
        z = -14 + k * 8.5
        beach_hut(S, V(-74, ground(-74, z), z), pi / 2, body)

    # Beach volleyball.
    for sz in (-1, 1):
        cyl(S, "Pole", V(60, 0, -20 + sz * 4.5), V(60, 2.6, -20 + sz * 4.5), 0.06, n=5)
    quad(S, "Net", V(60, 1.6, -24.5), V(60, 1.6, -15.5), V(60, 2.5, -15.5), V(60, 2.5, -24.5))

    # Rocks at the pier and the right-hand point.
    for c, r in (((-67, 0, 52), 1.6), ((-57, 0, 54), 1.1), ((-70, 0, 57), 1.3), ((84, -0.2, 53), 2.0),
                 ((90, -0.2, 57), 1.5), ((95, -0.2, 54), 1.2)):
        rock(S, c, r, rng)

    # A lighthouse on a rocky islet.
    for k in range(7):
        a = 2 * pi * k / 7
        rock(S, (-112 + cos(a) * 6, -0.6, 168 + sin(a) * 6), rng.uniform(3.0, 4.5), rng)
    rock(S, (-112, 0.4, 168), 6.0, rng)
    lighthouse(S, V(-112, 2.4, 168), 16)

    # Headlands on the horizon.
    for c, r, h, sx in (((230, 0, 360), 110, 34, 0.55), ((-300, 0, 470), 80, 22, 0.5)):
        lathe(S, "Sand", c, [(r * 1.06, -1.5), (r, 0.8)], n=16, sx=sx, caps=(False, False))
        off, n = lathe(S, "IslandGrass", V(c) + UP * 0.8,
                       [(r, 0.0), (r * 0.7, h * 0.45), (r * 0.35, h * 0.9), (0.0, h)], n=16, sx=sx,
                       caps=(False, False))
        jitter(S, "IslandGrass", off, n, V(c) + UP * 0.8, 0.12, rng)

    # Dune grass on the dunes.
    for _ in range(90):
        x, z = rng.uniform(-200, 200), rng.uniform(-160, 44)
        if out_of_hole(x, z) < 12:
            continue
        b = V(x, ground(x, z) - 0.05, z)
        for k in range(3):
            a = rng.uniform(0, 2 * pi)
            cone(S, "DuneGrass", b + V(cos(a), 0, sin(a)) * 0.35, 0.22, rng.uniform(0.6, 1.1), n=4, rot=a)

    sailboat("Bob_boat_1", (-30, WATER_Y, 115), 0.4, "SailWhite")
    sailboat("Bob_boat_2", (78, WATER_Y, 178), -0.6, "SailOrange")
    sailboat("Bob_boat_3", (-160, WATER_Y, 270), 1.0, "SailWhite")
    sailboat("Bob_boat_4", (140, WATER_Y, 300), 2.6, "SailRed")

    # The sun, low over the sea.
    sun = Obj("Sun")
    c = V(-150, 105, 470)
    for mat, r, dz in (("SunHalo", 30, 2.0), ("Sun", 20, 0.0)):
        ring = [c + V(r * cos(2 * pi * k / 32), r * sin(2 * pi * k / 32), dz) for k in range(32)]
        sun.add(mat, list(reversed(ring)), [tuple(range(32))])

    clouds(rng, [(-180, 110, 260, 1.4), (-40, 140, 380, 1.8), (120, 100, 230, 1.1), (260, 150, 420, 2.0),
                 (-300, 160, 440, 2.0), (40, 95, 170, 0.9), (-110, 125, 120, 1.0), (200, 120, 90, 1.2)])


# --------------------------------------------------------------------------
# PARIS
# --------------------------------------------------------------------------

def eiffel_tower(o, base, s=0.28):
    """
    The tower, at `s` times real size (330m real). Real proportions: a
    square base 125m across, the first floor at 57m, the second at 115m, the
    top at 276m. The outline follows an exponential, fitted to those floors:
    half-width W(y) = 56.5 e^(-0.01149 y) + 6. Each leg is a lattice box of
    corner posts, rings and X braces, and the four legs merge into one shaft
    at about 180m.
    """
    base = V(base)

    def P(x, y, z):
        return base + V(x, y, z) * s

    def W(y):
        return 56.5 * exp(-0.01149 * y) + 6.0

    def Lw(y):
        return 25.0 + (13.1 - 25.0) * min(y, 180.0) / 180.0

    def I(y):
        return max(W(y) - Lw(y), 0.0)

    post, brace, ring = 2.8 * s, 1.3 * s, 1.5 * s
    levels = [0, 16, 34, 57, 80, 100, 115, 140, 160, 180]
    for sx in (-1, 1):
        for sz in (-1, 1):
            def quad_at(y):
                i, w = I(y), W(y)
                return [P(sx * i, y, sz * i), P(sx * w, y, sz * i), P(sx * w, y, sz * w), P(sx * i, y, sz * w)]

            prev = quad_at(0)
            for y in levels[1:]:
                cur = quad_at(y)
                for k in range(4):
                    j = (k + 1) % 4
                    beam(o, "Iron", prev[k], cur[k], post)
                    beam(o, "Iron", prev[k], cur[j], brace)
                    if k in (1, 2):  # the outer faces get a full X
                        beam(o, "Iron", prev[j], cur[k], brace)
                    beam(o, "Iron", cur[k], cur[j], ring)
                prev = cur
            # Masonry pier under the foot.
            mid = (I(0) + W(0)) / 2
            box(o, "TowerStone", P(sx * mid, 2.5, sz * mid), (Lw(0) * s + 1.2, 5 * s, Lw(0) * s + 1.2))

    # The single shaft above the legs.
    shaft = [180, 200, 220, 240, 258, 276]

    def square(y):
        w = W(y)
        return [P(-w, y, -w), P(w, y, -w), P(w, y, w), P(-w, y, w)]

    prev = square(shaft[0])
    for y in shaft[1:]:
        cur = square(y)
        for k in range(4):
            j = (k + 1) % 4
            beam(o, "Iron", prev[k], cur[k], post * 0.8)
            beam(o, "Iron", prev[k], cur[j], brace * 0.8)
            beam(o, "Iron", prev[j], cur[k], brace * 0.8)
            beam(o, "Iron", cur[k], cur[j], ring * 0.8)
        prev = cur

    # The great arches between the legs, one on each face.
    y0, top = 20.0, 54.0
    for face in range(4):
        def fp(x, y):
            zf = (I(y) + W(y)) / 2
            pts = {0: (x, zf), 1: (zf, -x), 2: (-x, -zf), 3: (-zf, x)}[face]
            return P(pts[0], y, pts[1])

        for A, B in ((I(y0) + 1.0, top - y0), (I(y0) - 3.0, top - y0 - 5.0)):
            pts = [fp(A * cos(pi * k / 12), y0 + B * sin(pi * k / 12)) for k in range(13)]
            for a, b in zip(pts, pts[1:]):
                beam(o, "Iron", a, b, ring)
        for k in range(1, 12, 2):
            t = pi * k / 12
            beam(o, "Iron", fp((I(y0) + 1.0) * cos(t), y0 + (top - y0) * sin(t)),
                 fp((I(y0) - 3.0) * cos(t), y0 + (top - y0 - 5.0) * sin(t)), brace)

    # Floors.
    def floor(y, pad, thick, pav_inset, pav_h):
        w = W(y) + pad
        box(o, "IronDark", P(0, y, 0), (2 * w * s, thick * s, 2 * w * s))
        wp = W(y) - pav_inset
        box(o, "TowerGlass", P(0, y + thick / 2 + pav_h / 2, 0), (2 * wp * s, pav_h * s, 2 * wp * s))
        box(o, "Iron", P(0, y + thick / 2 + pav_h, 0), (2 * (wp + 1) * s, 1.2 * s, 2 * (wp + 1) * s))

    floor(57, 3.0, 6.0, 4.0, 7.0)
    floor(115, 2.5, 4.0, 3.0, 5.0)
    box(o, "IronDark", P(0, 281, 0), (19.6 * s, 10 * s, 19.6 * s))
    hexa = corners(P(0, 293, 0), (12 * s, 14 * s, 12 * s))
    c_top = P(0, 300, 0)
    for i in range(8):
        if i & 2:
            hexa[i] = V(c_top.x + (hexa[i].x - c_top.x) * 0.42, c_top.y, c_top.z + (hexa[i].z - c_top.z) * 0.42)
    o.add("Iron", hexa, BOX_FACES)
    cyl(o, "IronDark", P(0, 300, 0), P(0, 306, 0), 2.6 * s, n=8)
    cyl(o, "Iron", P(0, 306, 0), P(0, 330, 0), 1.2 * s, 0.45 * s, n=6)


def haussmann(o, c, w, d, yaw, floors, rng, detail=True):
    """A Paris apartment block: cream stone, iron balconies, a slate mansard."""
    R, U, N = yaw_axes(yaw)
    c = V(c)
    ground_h, floor_h = 4.6, 3.3
    H = ground_h + floors * floor_h
    box(o, "Stone", c + U * (H / 2), (w, H, d), (R, U, N), NO_BOTTOM)
    front = c + N * (d / 2)
    box(o, "StoneDark", front + U * (ground_h / 2), (w, ground_h, 0.3), (R, U, N), NO_BOTTOM)
    cols = max(2, int(w / 3.1))
    step = w / cols
    awning = rng.choice(("AwnRed", "AwnGreen", "AwnNavy", None, None))
    if detail:
        for k in range(max(1, int(w / 4.6))):
            n_shops = max(1, int(w / 4.6))
            x = -w / 2 + w * (k + 0.5) / n_shops
            facade_quad(o, "Shop", front + N * 0.16 + R * x + U * 1.9, R, U, min(3.0, w / n_shops - 0.8), 2.6)
            if awning:
                beam(o, awning, front + N * 0.2 + R * x + U * 3.9, front + N * 1.5 + R * x + U * 3.25, 0.06,
                     min(3.2, w / n_shops - 0.5), hint=R)
    for f in range(floors):
        y = ground_h + f * floor_h + 1.55
        for k in range(cols):
            facade_quad(o, "Window", front + N * 0.03 + R * (-w / 2 + step * (k + 0.5)) + U * y, R, U, 1.25, 2.0)
    if detail:
        for f in (1, floors - 1):
            box(o, "Balcony", front + N * 0.35 + U * (ground_h + f * floor_h + 0.5), (w - 0.6, 0.85, 0.7), (R, U, N))
    box(o, "StoneLight", c + U * (H + 0.15), (w + 0.3, 0.3, d + 0.6), (R, U, N))
    # Mansard: a frustum, steep at the front and back.
    roof = corners(c + U * (H + 0.3 + 2.0), (w, 4.0, d), (R, U, N))
    for i in range(8):
        if i & 2:
            roof[i] = roof[i] - N * (2.6 if i & 4 else -2.6)
    o.add("Roof", roof, NO_BOTTOM)
    if detail:
        for k in range(0, cols, 2):
            x = -w / 2 + step * (k + 0.5)
            box(o, "StoneLight", front - N * 1.2 + R * x + U * (H + 1.9), (1.1, 1.5, 1.0), (R, U, N), NO_BOTTOM)
    for x in (-w * 0.3, w * 0.28):
        box(o, "Chimney", c + R * x + U * (H + 4.9), (0.8, 1.6, 1.8), (R, U, N), NO_BOTTOM)


def building_row(o, rng, start, end, place, gap_every=4, detail=True):
    """Buildings side by side from `start` to `end` along a street, with cross streets."""
    t, count = start, 0
    while t < end:
        w = rng.uniform(15, 23)
        if t + w > end:
            break
        place(t + w / 2, w, rng.choice((5, 5, 6)), detail)
        t += w
        count += 1
        if count % gap_every == 0:
            t += 12


def paris_lamp(o, base):
    base = V(base)
    cyl(o, "LampGreen", base, base + UP * 3.6, 0.14, 0.09, n=6)
    box(o, "LampGlass", base + UP * 3.95, (0.5, 0.7, 0.5))
    cone(o, "LampGreen", base + UP * 4.3, 0.42, 0.45, n=4, rot=pi / 4)


def morris_column(o, base):
    base = V(base)
    cyl(o, "LampGreen", base, base + UP * 0.5, 1.0, n=10)
    cyl(o, "Poster", base + UP * 0.5, base + UP * 2.8, 0.92, n=10, caps=(False, False))
    cyl(o, "LampGreen", base + UP * 2.8, base + UP * 3.1, 1.05, n=10)
    lathe(o, "LampGreen", base + UP * 3.1, [(1.05, 0), (0.7, 0.5), (0.2, 0.9), (0.0, 1.2)], n=10, caps=(True, False))


def fountain(o, base):
    base = V(base)
    lathe(o, "StoneLight", base, [(7.0, 0.0), (7.0, 0.6), (6.6, 0.6), (6.6, 0.25)], n=20, caps=(False, False))
    lathe(o, "FountainWater", base, [(6.6, 0.25), (0.0, 0.25)], n=20, caps=(False, False))
    cyl(o, "StoneLight", base, base + UP * 1.6, 0.8, 0.55, n=8)
    lathe(o, "StoneLight", base + UP * 1.6, [(0.5, 0), (2.4, 0.5), (2.4, 0.7), (0.0, 0.7)], n=12, caps=(True, False))
    cone(o, "Spray", base + UP * 2.2, 0.7, 4.2, n=8)
    cone(o, "Spray", base + UP * 0.25, 2.2, 0.9, n=12)


def carousel(o, base):
    base = V(base)
    lathe(o, "CarouselWhite", base, [(7.0, 0.0), (7.0, 0.5), (0.0, 0.5)], n=16, caps=(False, False))
    for k in range(10):
        a = 2 * pi * k / 10
        p = base + V(cos(a), 0, sin(a)) * 6.4
        cyl(o, "Gold", p + UP * 0.5, p + UP * 4.6, 0.09, n=4, caps=(False, False))
        box(o, "CarouselWhite", p + UP * 1.6, (0.4, 0.9, 1.3), yaw_axes(a))
    cyl(o, "Carousel", base + UP * 0.5, base + UP * 4.6, 2.0, n=10)
    n = 16
    top = base + UP * 4.6
    apex = top + UP * 2.6
    for i in range(n):
        a0, a1 = 2 * pi * i / n, 2 * pi * (i + 1) / n
        p0, p1 = top + V(sin(a0), 0, cos(a0)) * 7.4, top + V(sin(a1), 0, cos(a1)) * 7.4
        tri(o, "Carousel" if i % 2 == 0 else "CarouselWhite", p0, p1, apex)
    cyl(o, "Gold", apex - UP * 0.2, apex + UP * 1.2, 0.12, n=4)


def invalides_dome(o, base, k=1.0):
    """The gilded dome of Les Invalides, seen over the rooftops."""
    base = V(base)
    UP = V(0, k, 0)  # every height below scales with k
    box(o, "Stone", base + UP * 7, (42 * k, 14 * k, 42 * k), faces=NO_BOTTOM)
    box(o, "StoneLight", base + UP * 14.4, (43 * k, 0.8 * k, 43 * k))
    cyl(o, "Stone", base + UP * 14, base + UP * 30, 12.0 * k, n=20)
    for i in range(20):
        a = 2 * pi * (i + 0.5) / 20
        p = base + V(cos(a), 0, sin(a)) * (12.6 * k)
        cyl(o, "StoneLight", p + UP * 15, p + UP * 29, 0.5 * k, n=4, caps=(False, False))
    cyl(o, "StoneLight", base + UP * 30, base + UP * 31, 13.0 * k, n=20)
    cyl(o, "Stone", base + UP * 31, base + UP * 36, 10.2 * k, n=20)
    prof = [(10.4 * k, 0.0)] + [(10.4 * k * cos(pi / 2 * j / 6), 15.0 * k * sin(pi / 2 * j / 6)) for j in range(1, 6)] + [(2.0 * k, 15.2 * k)]
    lathe(o, "Gold", base + UP * 36, prof, n=20, caps=(False, True))
    cyl(o, "StoneLight", base + UP * 51, base + UP * 57, 2.0 * k, 1.6 * k, n=8)
    cone(o, "Gold", base + UP * 57, 1.4 * k, 4.0 * k, n=8)
    cyl(o, "Gold", base + UP * 61, base + UP * 66, 0.25 * k, 0.08 * k, n=4)


def build_paris():
    rng = random.Random(11)
    S = Obj("Paris")

    xs = spans((-640, 640, 40), extra=(-HOLE_X, HOLE_X))
    zs = spans((-320, 700, 40), extra=(-HOLE_Z, HOLE_Z))
    grid(S, xs, zs, lambda x, z: -0.06, lambda cx, cz: None if in_hole(cx, cz) else "ParkGrass")

    # The Champ de Mars: gravel, lawns with mowing stripes, clipped tree rows.
    rect(S, "Gravel", -25, 25, 38, 178, 0.02)
    rect(S, "Gravel", -46, 46, 178, 236, 0.02)
    for z0, z1 in ((42, 80), (86, 124), (130, 168)):
        n = 4
        for k in range(n):
            a, b = z0 + (z1 - z0) * k / n, z0 + (z1 - z0) * (k + 1) / n
            rect(S, "Lawn" if k % 2 == 0 else "Lawn2", -17, 17, a, b, 0.08)
    for sx in (-1, 1):
        rect(S, "Lawn3", min(sx * 25, sx * 36), max(sx * 25, sx * 36), 38, 178, 0.02)
        rect(S, "Pavement", min(sx * 36, sx * 40), max(sx * 36, sx * 40), -320, 700, 0.02)
        rect(S, "Road", min(sx * 40, sx * 51), max(sx * 40, sx * 51), -320, 700, 0.03)
        rect(S, "Pavement", min(sx * 51, sx * 55), max(sx * 51, sx * 55), -320, 700, 0.02)
        z = -300
        while z < 680:
            rect(S, "RoadLine", sx * 45.5 - 0.1, sx * 45.5 + 0.1, z, z + 3, 0.06)
            z += 8
        # Clipped tree rows ("rideaux") along the lawns.
        for z0, z1 in ((44, 78), (88, 122), (132, 166)):
            box(S, "Hedge", (sx * 30.5, 6.3, (z0 + z1) / 2), (5.5, 5.8, z1 - z0))
            z = z0 + 2
            while z < z1:
                cyl(S, "Bark", V(sx * 30.5, 0, z), V(sx * 30.5, 3.5, z), 0.24, n=5, caps=(False, False))
                z += 6.5
        # Avenue trees and lamps.
        z = -60
        while z < 240:
            if not in_hole(sx * 38, z, 2):
                round_tree(S, (sx * 38, 0, z), rng.uniform(1.05, 1.3), rng)
            z += 11
        for z in range(46, 172, 14):
            paris_lamp(S, (sx * 21.5, 0.02, z))
            bench(S, (sx * 22.6, 0.02, z + 7), sx * pi / 2 * -1)

    # Buildings down both avenues, facing in.
    for sx in (-1, 1):
        def place(t, w, floors, detail, sx=sx):
            haussmann(S, (sx * 63, 0, t), w, 16, -sx * pi / 2, floors, rng, detail and t > -40)
        building_row(S, rng, -250, 420, place)
    # Behind the tower, facing the court; a gap frames the tower.
    for x0, x1 in ((-330, -70), (70, 330)):
        def place(t, w, floors, detail):
            haussmann(S, (t, 0, 318), w, 16, pi, floors, rng, False)
        building_row(S, rng, x0, x1, place)
    # Behind the near stand (seen from the broadcast camera).
    def place_near(t, w, floors, detail):
        haussmann(S, (t, 0, -78), w, 16, 0.0, floors, rng, False)
    building_row(S, rng, -150, 150, place_near)

    # Park by the court: fountain, trees, benches, kiosks.
    fountain(S, (-34, 0.02, 2))
    for c in ((-30, -26), (-31, 26), (31, -26), (31, 26), (-28, -60), (30, -62), (-32, 60), (32, 64)):
        round_tree(S, (c[0], 0, c[1]), rng.uniform(1.0, 1.25), rng)
    for c in ((26, 2), (-26, 34), (26, 36)):
        morris_column(S, (c[0], 0.02, c[1]))
    for c in ((32, 6, pi / 2), (32, -6, pi / 2)):
        bench(S, (c[0], 0.02, c[1]), c[2])

    eiffel_tower(S, (0, 0.02, 206))
    carousel(S, (30, 0.02, 190))
    for x in (-38, 38):
        for z in (184, 230):
            round_tree(S, (x, 0, z), 1.2, rng)
    invalides_dome(S, (-125, 0, 390), 1.35)

    clouds(rng, [(-160, 120, 250, 1.4), (-20, 150, 400, 1.9), (140, 110, 220, 1.2), (260, 150, 430, 2.0),
                 (-300, 160, 440, 1.8), (90, 125, 330, 1.3), (-120, 135, 110, 1.0), (220, 120, 80, 1.1)])


# --------------------------------------------------------------------------
# SYDNEY
# --------------------------------------------------------------------------

def opera_shell(o, frame_, a0, b0, y0, w, h, L, ov, facing=1):
    """
    One sail: a pointed arch for a mouth, tapering back to the podium. The tip
    overhangs the mouth the way the real shells lean forward over their glass
    walls. `frame_` maps local (a along the axis, b across, y up) to world.
    """
    R = (h * h + w * w) / (2 * w)
    apex_ang = pi - math.atan2(h, R - w)
    across = []
    for k in range(7):
        u = k / 6
        t = pi + u * (apex_ang - pi)
        across.append(((R - w) + R * cos(t), R * sin(t)))
    across = across + [(-b, y) for b, y in reversed(across[:-1])]
    K = 10
    rows = []
    for k in range(K + 1):
        f = k / K
        d = L * f
        gy = cos(f * pi / 2) ** 0.9
        gw = 1 - 0.3 * f
        row = []
        for b, y in across:
            yy = y * gy
            a = a0 + facing * (ov * (yy / h) * (1 - f) - d)
            row.append(frame_(a, b0 + b * gw, y0 + yy))
        rows.append(row)
    n = len(across)
    verts = [p for row in rows for p in row]
    faces = [(k * n + i, k * n + i + 1, (k + 1) * n + i + 1, (k + 1) * n + i) for k in range(K) for i in range(n - 1)]
    o.add("Shell", verts, faces)
    # The glass wall in the mouth, set a little back.
    f = 0.07
    glass = []
    for b, y in across:
        yy = y * cos(f * pi / 2) ** 0.9 * 0.97
        a = a0 + facing * (ov * (yy / h) * (1 - f) * 0.4 - L * f)
        glass.append(frame_(a, b0 + b * (1 - 0.3 * f) * 0.97, y0 + yy))
    o.add("OperaGlass", glass, [tuple(range(len(glass)))])


def opera_house(o, C, north):
    C = V(C)
    N = V(north).normalized()
    E = V(-N.z, 0, N.x)

    def F(a, b, y):
        return C + N * a + E * b + UP * y

    top = 7.0
    podium = [(-40, -26), (26, -26), (38, -14), (38, 14), (26, 26), (-40, 26)]
    extrude(o, "Podium", [(F(a, b, 0).x, F(a, b, 0).z) for a, b in podium], -1.4, top)
    # The broad steps down to the forecourt.
    for k in range(10):
        a1 = -40 - k * 1.3
        a0 = a1 - 1.3
        yy = top - (k + 1) * (top - 0.9) / 10
        pts = [F(a0, -22, 0), F(a1, -22, 0), F(a1, 22, 0), F(a0, 22, 0)]
        extrude(o, "Steps", [(p.x, p.z) for p in pts], 0.0, yy, caps=(False, True))
    # Concert Hall (west) and Joan Sutherland Theatre (east), each a run of
    # sails facing the harbour, with a small one facing back at the south end.
    for b0, sc, da in ((-11.5, 1.0, 0.0), (11.5, 0.9, -4.0)):
        for a, w, h, L, ov in ((30, 8.5, 19, 16, 6), (19, 9.5, 25, 19, 6), (7, 8.5, 18, 15, 4)):
            opera_shell(o, F, a * sc + da, b0, top, w * sc, h * sc, L * sc, ov * sc)
        opera_shell(o, F, -14 * sc + da, b0, top, 7.0 * sc, 11 * sc, 11 * sc, 3, facing=-1)
    # The restaurant's little pair, at the south-west corner.
    opera_shell(o, F, -30, -19, top, 4.0, 7.5, 6, 1.5, facing=-1)
    opera_shell(o, F, -22, -19, top, 3.5, 6.0, 5, 1.2, facing=1)


def harbour_bridge(o, C, axis, s=0.3):
    """
    The Harbour Bridge at `s` times real size: a 503m two-hinged arch, its top
    134m above the water, the deck at 52m, granite pylons 89m tall at each end.
    """
    C = V(C)
    A = V(axis).normalized()
    Wd = V(-A.z, 0, A.x)
    half = 251.5 * s

    def P(u, y, w):
        return C + A * u + UP * y + Wd * w

    def yl(u):
        return (6 + 112 * (1 - (u / half) ** 2)) * s

    def yu(u):
        return (134 - 72 * (u / half) ** 2) * s

    deck_y, deck_w, truss_w = 52 * s, 24.5 * s, 15 * s
    panels = 28
    us = [-half + 2 * half * k / panels for k in range(panels + 1)]
    chord, post, diag = 6 * s, 3 * s, 2.4 * s
    for side in (-1, 1):
        w = side * truss_w
        for k in range(panels):
            u0, u1 = us[k], us[k + 1]
            beam(o, "BridgeSteel", P(u0, yl(u0), w), P(u1, yl(u1), w), chord, hint=UP)
            beam(o, "BridgeSteel", P(u0, yu(u0), w), P(u1, yu(u1), w), chord * 0.8, hint=UP)
            if k % 2 == 0:
                beam(o, "BridgeSteel", P(u0, yl(u0), w), P(u1, yu(u1), w), diag)
            else:
                beam(o, "BridgeSteel", P(u0, yu(u0), w), P(u1, yl(u1), w), diag)
        for u in us:
            beam(o, "BridgeSteel", P(u, yl(u), w), P(u, yu(u), w), post)
            if yl(u) > deck_y + 1:
                beam(o, "Steel", P(u, deck_y, w), P(u, yl(u), w), post * 0.45)
            elif yl(u) < deck_y - 1:
                beam(o, "BridgeSteel", P(u, yl(u), w), P(u, deck_y - 1.2, w), post)
    for u in us[1:-1]:
        beam(o, "BridgeSteel", P(u, yu(u), -truss_w), P(u, yu(u), truss_w), post * 0.7)
        beam(o, "BridgeSteel", P(u, yl(u), -truss_w), P(u, yl(u), truss_w), post * 0.7)
    # Deck: road slab on a girder.
    span = half + 120
    box(o, "Steel", P(0, deck_y - 0.4, 0), (2 * span, 0.8, 2 * deck_w), (A, UP, Wd))
    box(o, "BridgeSteel", P(0, deck_y - 1.4, 0), (2 * span, 1.2, 2 * deck_w * 0.8), (A, UP, Wd))
    # Pylons and abutments.
    for e in (-1, 1):
        u = e * (half + 5.5)
        for side in (-1, 1):
            c = P(u, -1.2, side * (deck_w + 4.5))
            pts = corners(c + UP * (27.9 / 2), (11, 27.9, 9), (A, UP, Wd))
            for i in range(8):
                if i & 2:
                    pts[i] = c + UP * 27.9 + (pts[i] - c - UP * 27.9) * 0.78
            o.add("Granite", pts, NO_BOTTOM)
            box(o, "Granite", c + UP * 27.4, (10.2, 1.2, 8.4), (A, UP, Wd))
            box(o, "Granite", c + UP * 29.0, (6.0, 2.0, 5.0), (A, UP, Wd), NO_BOTTOM)
        box(o, "Granite", P(u, (deck_y - 2.0 - 1.2) / 2 - 1.2 + 1.2, 0), (14, deck_y - 2.0, 2 * (deck_w + 1)),
            (A, UP, Wd))
        for k in range(1, 7):
            uu = e * (half + 5.5 + 18 * k)
            box(o, "Granite", P(uu, (deck_y - 2.0) / 2 - 0.6, 0), (4, deck_y - 0.8, 2 * deck_w * 0.8), (A, UP, Wd))


def ferry(name, c, yaw):
    o = Obj(name, c)
    c = V(c)
    X, U, Z = yaw_axes(yaw)
    hull = [(-11, 0), (-8, -3), (8, -3), (11, 0), (8, 3), (-8, 3)]

    def poly(scale):
        return [((c + X * (u * scale) + Z * (v * scale)).x, (c + X * (u * scale) + Z * (v * scale)).z) for u, v in hull]

    extrude(o, "FerryGreen", poly(1.0), c.y - 0.6, c.y + 1.6)
    extrude(o, "FerryCream", poly(1.0), c.y + 1.6, c.y + 2.6, caps=(False, True))
    extrude(o, "FerryYellow", poly(1.03), c.y + 2.6, c.y + 2.8)
    box(o, "FerryCream", c + U * 3.9, (14, 2.2, 5.2), (X, U, Z))
    box(o, "Window", c + U * 4.1, (14.1, 0.8, 5.3), (X, U, Z))
    box(o, "FerryGreen", c + U * 5.1, (14.6, 0.2, 5.8), (X, U, Z))
    for e in (-1, 1):
        box(o, "FerryCream", c + X * (e * 5.2) + U * 5.9, (2.6, 1.6, 3.4), (X, U, Z))
        box(o, "Window", c + X * (e * 5.2) + U * 6.1, (2.7, 0.6, 3.5), (X, U, Z))
        box(o, "FerryGreen", c + X * (e * 5.2) + U * 6.8, (3.0, 0.2, 3.8), (X, U, Z))
    cyl(o, "FerryYellow", c + U * 5.2, c + U * 8.2, 0.5, 0.45, n=8)


def sydney_tower(o, base):
    base = V(base)
    cyl(o, "Glass3", base, base + UP * 96, 2.3, 1.9, n=10)
    for k in range(6):
        a = 2 * pi * k / 6
        beam(o, "Steel", base + V(cos(a), 0, sin(a)) * 3.2, base + UP * 80, 0.25)
    cyl(o, "Gold", base + UP * 80, base + UP * 84, 6.5, 7.2, n=16)
    cyl(o, "Window", base + UP * 84, base + UP * 86, 7.2, n=16)
    cyl(o, "Gold", base + UP * 86, base + UP * 90, 7.2, 6.0, n=16)
    cyl(o, "Steel", base + UP * 90, base + UP * 118, 0.6, 0.15, n=5)


def office_tower(o, base, w, d, h, mat, crown=False):
    base = V(base)
    X, U, Z = AXES
    box(o, mat, base + U * (h / 2), (w, h, d), faces=NO_BOTTOM)
    faces = ((Z, X, w, d), (-Z, -X, w, d), (X, -Z, d, w), (-X, Z, d, w))
    y = 3.0
    while y < h - 2.0:
        for Nn, Rr, ext, other in faces:
            facade_quad(o, "Band", base + U * y + Nn * (other / 2 + 0.05), Rr, U, ext - 0.8, 1.1)
        y += 3.8
    if crown:
        box(o, "Steel", base + U * (h + 2.5), (w * 0.6, 5, d * 0.6), faces=NO_BOTTOM)
        cyl(o, "Steel", base + U * (h + 5), base + U * (h + 14), 0.3, 0.1, n=4)


def house(o, base, yaw, rng):
    X, U, Z = yaw_axes(yaw)
    base = V(base)
    w, d, h = rng.uniform(7, 11), rng.uniform(7, 10), rng.uniform(4, 7)
    box(o, "HouseWall", base + U * (h / 2), (w, h, d), (X, U, Z), NO_BOTTOM)
    cone(o, "HouseRoof", base + U * h, max(w, d) * 0.74, 3.0, n=4, rot=pi / 4 + yaw)


def build_sydney():
    rng = random.Random(23)
    S = Obj("Sydney")
    WATER_Y = -1.1
    EDGE = 48.0

    # The promenade, paved along the water's edge.
    xs = spans((-640, -120, 40), (-120, 120, 12), (120, 640, 40), extra=(-HOLE_X, HOLE_X))
    zs = spans((-320, -60, 40), (-60, EDGE, 6), extra=(-HOLE_Z, HOLE_Z, 40.0))

    def plaza_mat(cx, cz):
        if in_hole(cx, cz):
            return None
        return "Paving" if cz > 40 else "Plaza"

    grid(S, xs, zs, lambda x, z: -0.06, plaza_mat)
    slab(S, "Sandstone", -640, 640, -1.8, 0.0, EDGE, EDGE + 1.0)

    def harbour(x, z):
        a = 0.06 + 0.18 * smoothstep(80, 300, z)
        return WATER_Y + a * (sin(x * 0.07 + z * 0.17) + 0.6 * sin(x * 0.19 - z * 0.1 + 2.0))

    grid(S, coords(-640, 640, 20), spans((EDGE, 120, 8), (120, 700, 18)), harbour, lambda cx, cz: "Harbour")

    # Railing and lamps along the edge.
    x = -150
    while x <= 150:
        beam(S, "Steel", (x, 0.0, EDGE + 0.4), (x, 1.1, EDGE + 0.4), 0.1)
        x += 3.5
    for x0 in range(-150, 150, 75):
        beam(S, "Steel", (x0, 1.1, EDGE + 0.4), (x0 + 75, 1.1, EDGE + 0.4), 0.08)
        beam(S, "Steel", (x0, 0.6, EDGE + 0.4), (x0 + 75, 0.6, EDGE + 0.4), 0.05)
    for x in range(-144, 150, 18):
        b = V(x, 0.0, EDGE - 2.0)
        cyl(S, "Steel", b, b + UP * 6.0, 0.13, 0.09, n=6)
        beam(S, "Steel", b + UP * 5.9, b + UP * 6.1 + Z_AX * 1.1, 0.1)
        box(S, "LampHead", b + UP * 5.95 + Z_AX * 1.2, (0.5, 0.25, 0.9))

    # Fig trees and benches either side of the stadium.
    for c in ((-30, -24), (-34, 6), (31, -22), (35, 8), (-56, 20), (58, -8), (-60, -30),
              (62, 30), (-90, 28), (92, 26), (-30, -60), (32, -64)):
        fig_tree(S, (c[0], 0, c[1]), rng.uniform(0.9, 1.15), rng)
    for x in (-60, -42, 42, 60, -110, 110):
        bench(S, (x, 0.0, EDGE - 4.5), pi)

    # Land across the water: the city shore behind, the point under the
    # Opera House, and the North Shore on the right.
    back = [(-640, 228), (40, 228), (60, 236), (64, 300), (60, 700), (-640, 700)]
    extrude(S, "CityGround", back, -1.8, 0.9)
    north = [(150, 700), (148, 300), (160, 240), (190, 200), (260, 160), (640, 140), (640, 700)]
    extrude(S, "ShoreGrass", north, -1.8, 0.9)

    C_O = V(-74, 0, 132)
    N_O = V(-1, 0, -0.3).normalized()
    E_O = V(-N_O.z, 0, N_O.x)

    def at(a, b):
        p = C_O + N_O * a + E_O * b
        return (p.x, p.z)

    sw, se = at(-36, -30), at(-36, 30)
    extrude(S, "Paving", [sw, se, (se[0] + 20, 232), (sw[0] - 40, 232)], -1.8, 0.9)
    opera_house(S, C_O, N_O)
    for k in range(10):
        x, z = rng.uniform(-170, -60), rng.uniform(200, 226)
        fig_tree(S, (x, 0.9, z), rng.uniform(1.0, 1.4), rng)

    harbour_bridge(S, (100, WATER_Y, 262), (1, 0, 0.09))

    # The city: glass towers behind the water, and Sydney Tower.
    mats = ("Glass1", "Glass2", "Glass3", "Glass4")
    placed = []
    for _ in range(34):
        x, z = rng.uniform(-260, 50), rng.uniform(285, 420)
        if any(abs(x - px) < 22 and abs(z - pz) < 22 for px, pz in placed):
            continue
        placed.append((x, z))
        h = rng.uniform(22, 64) * (1.1 if -120 < x < 20 else 0.8)
        w = rng.uniform(11, 20)
        office_tower(S, (x, 0.9, z), w, rng.uniform(11, 20), h, rng.choice(mats), crown=rng.random() < 0.3)
    sydney_tower(S, (-40, 0.9, 360))
    # Low sandstone buildings at the bridge's south end (The Rocks).
    for k in range(7):
        x, z = -40 + k * 12 + rng.uniform(-2, 2), 236 + rng.uniform(0, 10)
        box(S, "Sandstone", (x, 0.9 + 4, z), (9, 8, 9), faces=NO_BOTTOM)
        cone(S, "HouseRoof", V(x, 8.9, z), 6.6, 2.4, n=4, rot=pi / 4)

    # The North Shore: hills, houses, trees.
    for c, r, h in (((300, 0.9, 300), 120, 26), ((210, 0.9, 420), 90, 20), ((420, 0.9, 220), 110, 30)):
        off, n = lathe(S, "ShoreGrass", c, [(r, 0.0), (r * 0.65, h * 0.55), (r * 0.3, h * 0.92), (0.0, h)], n=14,
                       sx=0.6, caps=(False, False))
        jitter(S, "ShoreGrass", off, n, V(c), 0.1, rng)
    for _ in range(40):
        x, z = rng.uniform(170, 330), rng.uniform(170, 330)
        if x < 160 + (300 - z) * 0.1 or (abs(z - (262 + (x - 100) * 0.09)) < 18):
            continue
        if rng.random() < 0.55:
            house(S, (x, 0.9, z), rng.uniform(0, pi), rng)
        else:
            fig_tree(S, (x, 0.9, z), rng.uniform(0.8, 1.2), rng)

    ferry("Bob_ferry_1", (-12, WATER_Y, 96), 0.25)
    ferry("Bob_ferry_2", (62, WATER_Y, 150), -0.2)
    sailboat("Bob_boat_1", (115, WATER_Y, 110), 0.9, "SailWhite")
    sailboat("Bob_boat_2", (-150, WATER_Y, 120), -0.5, "SailWhite")
    sailboat("Bob_boat_3", (20, WATER_Y, 190), 2.4, "SailRed")

    clouds(rng, [(-160, 130, 250, 1.4), (-20, 160, 420, 1.9), (140, 120, 230, 1.2), (280, 160, 440, 2.0),
                 (-300, 170, 460, 1.8), (90, 140, 340, 1.3), (-120, 140, 110, 1.0), (220, 130, 80, 1.1)])


BUILDERS = {"beach": build_beach, "paris": build_paris, "sydney": build_sydney}

# Sydney is laid out with the bridge on +X; mirrored, the Opera House lands on
# the left of the player's view and the bridge on the right, as on the card.
MIRROR = {"sydney"}


# --------------------------------------------------------------------------
# Into Blender, out to glTF
# --------------------------------------------------------------------------

def to_b(v):
    return (v.x, -v.z, v.y)


def realize(objs, collection, mirror=False):
    flip = -1.0 if mirror else 1.0
    for o in objs:
        if not o.parts:
            continue
        names = list(o.parts)
        verts, faces, mi = [], [], []
        for k, n in enumerate(names):
            vs, fs = o.parts[n]
            off = len(verts)
            verts.extend(to_b(V(flip * (v.x - o.origin.x), v.y - o.origin.y, v.z - o.origin.z)) for v in vs)
            faces.extend(tuple(i + off for i in (reversed(f) if mirror else f)) for f in fs)
            mi.extend([k] * len(fs))
        me = bpy.data.meshes.new(o.name)
        me.from_pydata(verts, [], faces)
        for n in names:
            me.materials.append(get_mat(n))
        me.polygons.foreach_set("material_index", mi)
        me.polygons.foreach_set("use_smooth", [True] * len(faces))
        me.update()
        me.validate()
        ob = bpy.data.objects.new(o.name, me)
        ob.location = to_b(V(flip * o.origin.x, o.origin.y, o.origin.z))
        collection.objects.link(ob)


def export(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    kw = dict(filepath=path, export_format="GLB", export_yup=True, export_apply=False,
              export_materials="EXPORT", export_cameras=False, export_lights=False,
              export_extras=True, export_texcoords=False, export_normals=True,
              export_animations=False, use_selection=False)
    if DRACO:
        # 20 bits keeps positions to ~1mm across the whole map; the default
        # 14 would snap them to ~8cm and collapse the small layer offsets.
        kw.update(export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                  export_draco_position_quantization=20, export_draco_normal_quantization=10)
    bpy.ops.export_scene.gltf(**kw)
    print("exported", path, os.path.getsize(path))


# --------------------------------------------------------------------------
# Preview renders: the map round a stand-in stadium, from the game's cameras.
# --------------------------------------------------------------------------

PAL = {
    "beach": dict(sky="#3b8fe0", horizon="#cde8f6", ground="#e6cf98", court="#c8643b", runoff="#b3532f",
                  stands=("#e8e1d2", "#d8cfbc"), sun="#fff0d4"),
    "paris": dict(sky="#6b98d6", horizon="#f2d9b8", ground="#557f3e", court="#4f9b45", runoff="#438a3b",
                  stands=("#2f4a3b", "#273f32"), sun="#ffd8a6"),
    "sydney": dict(sky="#2f80d8", horizon="#c4e2f6", ground="#8b949c", court="#1f6ec7", runoff="#2f8ade",
                   stands=("#26364c", "#1f2d40"), sun="#ffffff"),
}

VIEWS = (
    ("player", (0, 3.4, -18.1), (0, 1.0, -3.1), 62),
    ("broadcast", (13, 12, -18), (0, 0.6, 1), 50),
    ("aerial", (-230, 170, -160), (0, 0, 150), 45),
)


def build_preview_stadium(key):
    pal = PAL[key]
    MATS["PxGround"] = dict(color=pal["ground"])
    MATS["PxRunoff"] = dict(color=pal["runoff"])
    MATS["PxCourt"] = dict(color=pal["court"])
    MATS["PxStand0"] = dict(color=pal["stands"][0])
    MATS["PxStand1"] = dict(color=pal["stands"][1])
    MATS["PxLight"] = dict(color="#3e4a56")
    o = Obj("PreviewStadium")
    rect(o, "PxGround", -24, 24, -38, 38, -0.05)
    rect(o, "PxRunoff", -7.3, 7.3, -15.3, 15.3, 0.0)
    rect(o, "PxCourt", -4.1, 4.1, -11.9, 11.9, 0.004)
    for row in range(8):
        top = 0.5 + row * 0.45
        near = row * 0.9
        m = "PxStand0" if row % 2 == 0 else "PxStand1"
        for sg in (-1, 1):
            x0 = sg * (9.9 + near)
            slab(o, m, x0, x0 + sg * 0.9, 0, top, -23.3, 23.3)
            z0 = sg * (23.3 + near)
            hw = 9.9 + near + 0.9
            slab(o, m, -hw, hw, 0, top, z0, z0 + sg * 0.9)
    for sx in (-1, 1):
        for sz in (-1, 1):
            beam(o, "PxLight", (sx * 18.6, 0, sz * 32), (sx * 18.6, 17, sz * 32), 0.4)
            box(o, "PxLight", (sx * 18.6, 17.5, sz * 32), (3.2, 1.6, 0.4))


def setup_render(key):
    pal = PAL[key]
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    scene.view_settings.view_transform = "Standard"
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 88
    try:
        scene.eevee.taa_render_samples = 16
    except AttributeError:
        pass

    world = bpy.data.worlds.new("Sky")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes["Background"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = lin(pal["horizon"])
    ramp.color_ramp.elements[1].position = 0.55
    ramp.color_ramp.elements[1].color = lin(pal["sky"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.9

    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 3.2
    sun.color = lin(pal["sun"])[:3]
    sob = bpy.data.objects.new("Sun", sun)
    scene.collection.objects.link(sob)
    pos = Vector(to_b(V(14, 22, 10)))
    sob.rotation_euler = (-pos).to_track_quat("-Z", "Y").to_euler()

    cam_data = bpy.data.cameras.new("Cam")
    cam_data.sensor_fit = "VERTICAL"
    cam_data.clip_end = 3000
    cam = bpy.data.objects.new("Cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def preview_flat():
    """Facet the flat materials in Blender too, so the renders match the game."""
    for ob in bpy.data.objects:
        if ob.type != "MESH":
            continue
        me = ob.data
        flat = [bool(MATS[m.name].get("flat", True)) for m in me.materials]
        me.polygons.foreach_set("use_smooth", [not flat[p.material_index] for p in me.polygons])


def render_views(key, out_dir):
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    cam = setup_render(key)
    scene = bpy.context.scene
    paths = []
    for name, pos, look, fov in VIEWS:
        cam.data.angle_y = math.radians(fov)
        cam.location = to_b(V(pos))
        d = Vector(to_b(V(look))) - Vector(to_b(V(pos)))
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        path = os.path.join(out_dir, f"{key}_{name}.jpg")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        paths.append(path)
        print("rendered", path)
    return paths


def contact_sheet(paths, out, cols=3):
    import numpy as np
    imgs = []
    for p in paths:
        im = bpy.data.images.load(p)
        w, h = im.size
        a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)[::2, ::2]
        imgs.append(a)
        bpy.data.images.remove(im)
    h, w = imgs[0].shape[:2]
    rows = (len(imgs) + cols - 1) // cols
    sheet = np.ones((rows * h, cols * w, 4), dtype=np.float32)
    for k, a in enumerate(imgs):
        r = rows - 1 - k // cols
        c = k % cols
        sheet[r * h:(r + 1) * h, c * w:(c + 1) * w] = a
    img = bpy.data.images.new("sheet", cols * w, rows * h, alpha=True)
    img.pixels = sheet.ravel()
    img.filepath_raw = out
    img.file_format = "JPEG"
    img.save()
    print("sheet", out)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    keys = ONLY.split(",") if ONLY else list(BUILDERS)
    sheet_paths = []
    for key in keys:
        print("building", key)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        _made.clear()
        OBJS.clear()
        BUILDERS[key]()
        realize(OBJS, bpy.context.scene.collection, key in MIRROR)
        tris = sum(sum(len(f) - 2 for f in fs) for o in OBJS for _, fs in o.parts.values())
        print("TRIS", key, tris, {o.name: sum(sum(len(f) - 2 for f in fs) for _, fs in o.parts.values())
                                  for o in OBJS if not o.name.startswith(("Cloud", "Bob"))})
        if OUT_DIR:
            export(os.path.join(os.path.abspath(OUT_DIR), f"venue_{key}.glb"))
        if OUT_RENDERS or OUT_BLEND:
            preview_flat()
            OBJS.clear()
            build_preview_stadium(key)
            coll = bpy.data.collections.new("Preview stadium (not exported)")
            bpy.context.scene.collection.children.link(coll)
            realize(OBJS, coll)
            preview_flat()
            if OUT_RENDERS:
                sheet_paths += render_views(key, OUT_RENDERS)
            else:
                setup_render(key)
        if OUT_BLEND:
            os.makedirs(os.path.abspath(OUT_BLEND), exist_ok=True)
            bpy.ops.wm.save_as_mainfile(filepath=os.path.join(os.path.abspath(OUT_BLEND), f"{key}.blend"))
    if OUT_RENDERS and sheet_paths:
        contact_sheet(sheet_paths, os.path.join(os.path.abspath(OUT_RENDERS), "sheet.jpg"))


main()
