"""
Builds the tennis player model in Blender, entirely from code, and exports it
for the game.

    blender -b --factory-startup --python art/player/build_player.py -- \
        --glb public/models/player.glb --blend art/player/player.blend \
        --renders art/player/renders

Everything is generated: the body is a union of simple shapes fused with a
voxel remesh, the shirt and shorts are shells lifted off the body with clean
hems, the face and hair come in every variant the Customize screen offers, and
the animations are baked from key poses with IK on the feet and hands.

Coordinates while building (Blender, Z up): the player faces +Y, their right
hand is +X, feet at Z=0. glTF export turns +Y into -Z, which is the direction
the game's avatars face in their own space.

Names matter: the game finds parts by object name (Hair_short, Mouth_grin...)
and tints them by material name (Skin, Shirt, Shorts...). Keep them in sync
with src/scene/PlayerModel.tsx.
"""

import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector, Matrix, Quaternion, Euler
from mathutils.bvhtree import BVHTree

# --------------------------------------------------------------------------
# Arguments
# --------------------------------------------------------------------------

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


OUT_GLB = arg("--glb")
OUT_BLEND = arg("--blend")
OUT_RENDERS = arg("--renders")

FPS = 30

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
coll = scene.collection


def V(*a):
    return Vector(a if len(a) == 3 else a[0])


def link(ob):
    coll.objects.link(ob)
    return ob


def activate(ob):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)


# --------------------------------------------------------------------------
# Materials. Colours here are only defaults for the Blender renders; the game
# recolours them per player.
# --------------------------------------------------------------------------

def srgb(hex_):
    hex_ = hex_.lstrip("#")
    c = [int(hex_[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1.0]


MATS = {}


def material(name, color, rough=0.6, metal=0.0, alpha=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = srgb(color)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    MATS[name] = m
    return m


material("Skin", "#d9a377", 0.55)
material("Shirt", "#2f7fe8", 0.7)
material("Shorts", "#f4f7fa", 0.75)
material("Socks", "#f4f7fa", 0.9)
material("Shoes", "#f4f7fa", 0.5)
material("Sole", "#c9ced8", 0.85)
material("Hair", "#4a2f1d", 0.65)
material("Brow", "#3a2516", 0.8)
material("EyeWhite", "#f4f1ec", 0.25)
material("Iris", "#4a3222", 0.2)
material("Pupil", "#0b0d12", 0.15)
material("Mouth", "#5c2723", 0.6)
material("Teeth", "#f4f1ec", 0.35)
material("Accent", "#f4f7fa", 0.7)
material("Lens", "#0b0d12", 0.08, 0.6)
material("RacketFrame", "#22262e", 0.35, 0.3)
material("Grip", "#f4f7fa", 0.8)
material("Strings", "#e8f0f5", 0.6)


# --------------------------------------------------------------------------
# Shape building: primitives added into one bmesh, then fused.
# --------------------------------------------------------------------------

def add_ellipsoid(bm, center, semi, rot=None, seg=(32, 20)):
    m = Matrix.Translation(V(center))
    if rot is not None:
        m = m @ (rot if isinstance(rot, Matrix) else Euler(rot).to_matrix().to_4x4())
    m = m @ Matrix.Diagonal((semi[0], semi[1], semi[2], 1.0))
    bmesh.ops.create_uvsphere(bm, u_segments=seg[0], v_segments=seg[1], radius=1.0, matrix=m)


def add_sphere(bm, center, r, seg=(24, 16)):
    add_ellipsoid(bm, center, (r, r, r), seg=seg)


def align_z(direction):
    """A rotation taking +Z onto `direction`."""
    return Vector((0, 0, 1)).rotation_difference(V(direction).normalized()).to_matrix().to_4x4()


def add_limb(bm, p1, r1, p2, r2, seg=24):
    """Tapered capsule from p1 (radius r1) to p2 (radius r2)."""
    p1, p2 = V(p1), V(p2)
    d = p2 - p1
    m = Matrix.Translation((p1 + p2) / 2) @ align_z(d)
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                          radius1=r1, radius2=r2, depth=d.length, matrix=m)
    add_sphere(bm, p1, r1)
    add_sphere(bm, p2, r2)


def add_chain(bm, pts):
    """Tapered capsules through a list of (point, radius)."""
    for (a, ra), (b, rb) in zip(pts, pts[1:]):
        add_limb(bm, a, ra, b, rb)


def mesh_object(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return link(bpy.data.objects.new(name, me))


def apply_modifiers(ob):
    activate(ob)
    for mod in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def fuse(ob, voxel, smooth_iters=4, smooth_factor=0.5, target_faces=None):
    """Union everything in `ob` into one closed skin, then soften and thin it."""
    r = ob.modifiers.new("remesh", "REMESH")
    r.mode = "VOXEL"
    r.voxel_size = voxel
    r.adaptivity = 0.0
    apply_modifiers(ob)
    if smooth_iters:
        s = ob.modifiers.new("smooth", "SMOOTH")
        s.factor = smooth_factor
        s.iterations = smooth_iters
        apply_modifiers(ob)
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    if target_faces and tris > target_faces:
        d = ob.modifiers.new("decimate", "DECIMATE")
        d.ratio = target_faces / tris
        apply_modifiers(ob)
    shade_smooth(ob)
    return ob


def shade_smooth(ob):
    for p in ob.data.polygons:
        p.use_smooth = True


def set_material(ob, *names):
    ob.data.materials.clear()
    for n in names:
        ob.data.materials.append(MATS[n])


def mirror_x(p):
    return (-p[0], p[1], p[2])


# --------------------------------------------------------------------------
# Skeleton (rest pose: relaxed A-pose, arms 40 degrees below horizontal).
# --------------------------------------------------------------------------

SH = V(0.19, 0.0, 1.42)                 # right shoulder joint
ARM_DOWN = math.radians(40)
UA_LEN, FA_LEN, HAND_LEN = 0.29, 0.26, 0.09
ARM_DIR = V(math.cos(ARM_DOWN), 0, -math.sin(ARM_DOWN))
ELBOW = SH + ARM_DIR * UA_LEN + V(0, -0.01, 0)
WRIST = ELBOW + (ARM_DIR * FA_LEN + V(0, 0.02, 0)).normalized() * FA_LEN
HAND_TIP = WRIST + ARM_DIR * HAND_LEN

HIP = V(0.095, 0.0, 0.93)               # right hip joint
KNEE = V(0.095, 0.012, 0.50)
ANKLE = V(0.095, 0.0, 0.085)
TOE = V(0.095, 0.13, 0.03)

HEAD_C = V(0, 0.005, 1.665)             # middle of the head
HS = 1.08                               # head a touch big: reads better from afar


def hp(x, y, z):
    """A head point given relative to the head centre, before head scaling."""
    return HEAD_C + V(x, y, z) * HS


BONES = [
    # name, head, tail, parent
    ("hips", V(0, 0, 0.95), V(0, 0, 1.06), None),
    ("spine", V(0, 0, 1.06), V(0, 0, 1.25), "hips"),
    ("chest", V(0, 0, 1.25), V(0, 0, 1.46), "spine"),
    ("neck", V(0, 0, 1.46), V(0, 0.008, 1.56), "chest"),
    ("head", V(0, 0.008, 1.56), V(0, 0.008, 1.80), "neck"),
]
for s, f in (("R", 1), ("L", -1)):
    X = lambda p: V(p.x * f, p.y, p.z)
    BONES += [
        (f"shoulder.{s}", X(V(0.03, 0, 1.43)), X(SH + V(0, 0, 0.01)), "chest"),
        (f"upper_arm.{s}", X(SH), X(ELBOW), f"shoulder.{s}"),
        (f"forearm.{s}", X(ELBOW), X(WRIST), f"upper_arm.{s}"),
        (f"hand.{s}", X(WRIST), X(HAND_TIP), f"forearm.{s}"),
        (f"thigh.{s}", X(HIP), X(KNEE), "hips"),
        (f"shin.{s}", X(KNEE), X(ANKLE), f"thigh.{s}"),
        (f"foot.{s}", X(ANKLE), X(TOE), f"shin.{s}"),
    ]
BONE = {b[0]: b for b in BONES}


# --------------------------------------------------------------------------
# Body
# --------------------------------------------------------------------------

def build_body():
    bm = bmesh.new()
    # Torso
    add_ellipsoid(bm, (0, -0.005, 0.95), (0.158, 0.105, 0.12))           # pelvis
    for x in (0.068, -0.068):
        add_sphere(bm, (x, -0.045, 0.9), 0.082)                           # glutes
    add_ellipsoid(bm, (0, 0.0, 1.1), (0.135, 0.095, 0.16))               # waist
    add_ellipsoid(bm, (0, -0.005, 1.29), (0.162, 0.105, 0.17))           # ribcage
    for x in (0.068, -0.068):
        add_ellipsoid(bm, (x, 0.035, 1.34), (0.07, 0.035, 0.05))         # pecs
        add_ellipsoid(bm, (x * 1.3, -0.05, 1.3), (0.08, 0.05, 0.12))      # lats
    add_ellipsoid(bm, (0, -0.02, 1.405), (0.19, 0.085, 0.065))           # shoulder girdle
    for f in (1, -1):
        add_limb(bm, (0.05 * f, -0.015, 1.47), 0.042, (0.165 * f, -0.01, 1.435), 0.045)  # traps
        add_sphere(bm, (0.198 * f, 0.0, 1.405), 0.06)                     # deltoid
    add_limb(bm, (0, -0.005, 1.40), 0.054, (0, 0.012, 1.60), 0.048)      # neck

    # Arms and legs, built for the right side and mirrored.
    for f in (1, -1):
        X = lambda p: (p[0] * f, p[1], p[2])
        sh, el, wr = SH, ELBOW, WRIST
        mid_ua = sh.lerp(el, 0.42)
        add_chain(bm, [(X(sh + V(0, 0, 0.0)), 0.056), (X(mid_ua), 0.05), (X(el), 0.04)])
        add_ellipsoid(bm, X(sh.lerp(el, 0.45) + V(0, 0.012, 0.004)), (0.045, 0.045, 0.09),
                      rot=align_z(V(ARM_DIR.x * f, 0, ARM_DIR.z)))        # biceps
        add_chain(bm, [(X(el), 0.041), (X(el.lerp(wr, 0.3)), 0.044), (X(wr), 0.029)])

        add_chain(bm, [(X(HIP), 0.09), (X(HIP.lerp(KNEE, 0.5)), 0.074), (X(KNEE), 0.054)])
        add_ellipsoid(bm, X(HIP.lerp(KNEE, 0.45) + V(0.004, 0.022, 0)), (0.074, 0.07, 0.17))  # quads
        add_sphere(bm, X(KNEE + V(0, 0.008, 0)), 0.052)
        add_chain(bm, [(X(KNEE), 0.05), (X(KNEE.lerp(ANKLE, 0.35)), 0.054), (X(ANKLE), 0.034)])
        add_ellipsoid(bm, X(KNEE.lerp(ANKLE, 0.33) + V(0, -0.022, 0)), (0.05, 0.052, 0.11))  # calf
    ob = mesh_object("Body", bm)
    return fuse(ob, voxel=0.0075, smooth_iters=6, smooth_factor=0.6, target_faces=7000)


def build_head():
    bm = bmesh.new()
    s = HS
    add_ellipsoid(bm, hp(0, -0.014, 0.024), (0.089 * s, 0.103 * s, 0.104 * s))   # cranium
    add_ellipsoid(bm, hp(0, 0.03, -0.028), (0.077 * s, 0.075 * s, 0.084 * s))    # face mass
    add_ellipsoid(bm, hp(0, 0.04, -0.075), (0.064 * s, 0.062 * s, 0.045 * s))    # jaw
    add_sphere(bm, hp(0, 0.072, -0.094), 0.026 * s)                              # chin
    for f in (1, -1):
        add_sphere(bm, hp(0.044 * f, 0.058, -0.02), 0.024 * s)                   # cheekbones
        add_ellipsoid(bm, hp(0.09 * f, -0.008, -0.01), (0.013 * s, 0.026 * s, 0.035 * s),
                      rot=(0, 0, -0.25 * f))                                     # ears
    add_limb(bm, hp(-0.04, 0.089, 0.026), 0.019 * s, hp(0.04, 0.089, 0.026), 0.019 * s)  # brow ridge
    add_limb(bm, hp(0, 0.1, 0.012), 0.011 * s, hp(0, 0.117, -0.028), 0.015 * s)          # nose bridge
    for f in (1, -1):
        add_sphere(bm, hp(0.012 * f, 0.108, -0.032), 0.011 * s)                  # nostrils
    add_limb(bm, hp(0, 0.0, -0.11), 0.05, hp(0, -0.01, -0.06), 0.05)            # neck stub
    ob = mesh_object("Head", bm)
    fuse(ob, voxel=0.0042, smooth_iters=12, smooth_factor=0.6, target_faces=3200)
    set_material(ob, "Skin")
    return ob


# Eyes sit in front of the face; where exactly is found by casting onto the head.
EYE_R = 0.0175 * HS
EYE_X = 0.034 * HS
EYE_Z = HEAD_C.z + 0.004 * HS


class FaceCaster:
    def __init__(self, head):
        deps = bpy.context.evaluated_depsgraph_get()
        self.bvh = BVHTree.FromObject(head, deps)

    def hit(self, x, z, direction=V(0, -1, 0)):
        origin = V(x, 0.6, z)
        loc, normal, _, _ = self.bvh.ray_cast(origin, direction)
        if loc is None:
            raise RuntimeError(f"face ray missed at {x}, {z}")
        return loc, normal

    def project(self, ob, offset):
        """Push every vertex of a flat decal onto the face, `offset` proud of it."""
        for v in ob.data.vertices:
            loc, n = self.hit(v.co.x, v.co.z)
            v.co = loc + n * offset


def build_eyes(caster):
    bm = bmesh.new()
    centers = []
    for f in (1, -1):
        loc, n = caster.hit(EYE_X * f, EYE_Z)
        # Sink the eyeball so only a cap shows, like it sits in a socket.
        c = loc - V(0, 1, 0) * (EYE_R * 0.55)
        centers.append(c)
        # Pole pointing forward, so the iris and pupil follow the latitude
        # rings and come out perfectly round.
        add_ellipsoid(bm, c, (EYE_R, EYE_R * 0.92, EYE_R), rot=(-math.pi / 2, 0, 0), seg=(28, 24))
    ob = mesh_object("Eyes", bm)
    set_material(ob, "EyeWhite", "Iris", "Pupil")
    for p in ob.data.polygons:
        c = min(centers, key=lambda k: (k - p.center).length)
        d = (p.center - c).normalized()
        p.material_index = 2 if d.y > 0.955 else 1 if d.y > 0.8 else 0
    shade_smooth(ob)

    # Upper lids: skin hoods over the top of each eye, which is most of what
    # makes them read as eyes rather than marbles. Cut on a plane for a clean
    # lid line, tilted so the lid sits a little lower at the outer corner.
    lids_parts = []
    for c, f in zip(centers, (1, -1)):
        bm = bmesh.new()
        add_ellipsoid(bm, c, (EYE_R * 1.1, EYE_R * 1.1, EYE_R * 1.06), seg=(28, 16))
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=c + V(0, 0, EYE_R * 0.42),
                               plane_no=V(-0.12 * f, -0.25, 1).normalized(), clear_inner=True)
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=c - V(0, EYE_R * 0.3, 0),
                               plane_no=V(0, 1, 0), clear_inner=True)
        part = mesh_object("Lid", bm)
        lids_parts.append(part)
    lids = join(lids_parts, "Lids")
    sol = lids.modifiers.new("s", "SOLIDIFY")
    sol.thickness = 0.002
    apply_modifiers(lids)
    set_material(lids, "Skin")
    shade_smooth(lids)
    return ob, lids


def strip_decal(name, pts, width, caster, offset=0.0012, thickness=0.0015, mat="Mouth",
                taper=True):
    """A thick line drawn on the face: brows, mouth lines."""
    bm = bmesh.new()
    n = len(pts)
    left, right = [], []
    for i, (x, z) in enumerate(pts):
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        tx, tz = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, tz) or 1
        nx, nz = -tz / L, tx / L
        t = i / (n - 1)
        w = width(t) if callable(width) else width * (0.55 + 0.45 * math.sin(math.pi * t) if taper else 1)
        left.append(bm.verts.new((x + nx * w / 2, 0, z + nz * w / 2)))
        right.append(bm.verts.new((x - nx * w / 2, 0, z - nz * w / 2)))
    for i in range(n - 1):
        bm.faces.new((left[i], left[i + 1], right[i + 1], right[i]))
    ob = mesh_object(name, bm)
    caster.project(ob, offset)
    sol = ob.modifiers.new("s", "SOLIDIFY")
    sol.thickness = thickness
    sol.offset = 1
    apply_modifiers(ob)
    set_material(ob, mat)
    shade_smooth(ob)
    return ob


def poly_decal(name, outline, caster, mat, offset=0.001, thickness=0.001):
    """A filled shape on the face (open mouths), subdivided so it follows the curve."""
    bm = bmesh.new()
    vs = [bm.verts.new((x, 0, z)) for x, z in outline]
    face = bm.faces.new(vs)
    bmesh.ops.triangulate(bm, faces=[face])
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=2, use_grid_fill=True)
    ob = mesh_object(name, bm)
    caster.project(ob, offset)
    sol = ob.modifiers.new("s", "SOLIDIFY")
    sol.thickness = thickness
    sol.offset = 1
    apply_modifiers(ob)
    set_material(ob, mat)
    shade_smooth(ob)
    return ob


def arc(x0, x1, z0, bend, n=12, skew=0.0):
    """Points from x0 to x1 at height z0, bowed by `bend` at the middle."""
    out = []
    for i in range(n):
        t = i / (n - 1)
        x = x0 + (x1 - x0) * t
        out.append((x, z0 + bend * (1 - (2 * t - 1) ** 2) + skew * (t - 0.5)))
    return out


def build_face(caster):
    objs = []
    s = HS
    mz = HEAD_C.z - 0.058 * s          # mouth line
    bz = HEAD_C.z + 0.03 * s           # brow line
    ex = EYE_X

    def brows(name, inner_dz, outer_dz, bend, width=0.0068 * s):
        parts = []
        for f in (1, -1):
            pts = [(f * (0.012 * s + (ex + 0.034 * s - 0.012 * s) * t),
                    bz + inner_dz + (outer_dz - inner_dz) * t + bend * math.sin(math.pi * t))
                   for t in [i / 9 for i in range(10)]]
            parts.append(strip_decal(f"{name}_{f}", pts,
                                     lambda t: width * (1.15 - 0.55 * t), caster,
                                     offset=0.0018, thickness=0.0025, mat="Brow"))
        return join(parts, name)

    objs.append(brows("Brows_neutral", 0.0, 0.0, 0.006 * s))
    objs.append(brows("Brows_focused", -0.004 * s, 0.003 * s, 0.002 * s))
    objs.append(brows("Brows_angry", -0.011 * s, 0.006 * s, 0.0))
    objs.append(brows("Brows_raised", 0.012 * s, 0.006 * s, 0.009 * s))

    w = 0.024 * s
    objs.append(strip_decal("Mouth_line", arc(-w, w, mz, 0.0), 0.0042 * s, caster))
    objs.append(strip_decal("Mouth_frown", arc(-w * 0.9, w * 0.9, mz - 0.003, 0.008 * s), 0.0045 * s, caster))
    objs.append(strip_decal("Mouth_smirk", arc(-w * 0.75, w * 0.95, mz + 0.002, -0.004 * s, skew=0.007 * s),
                            0.0042 * s, caster))
    # Open smile: flat-ish top, round bottom, with a row of teeth.
    top = arc(-w * 1.05, w * 1.05, mz + 0.006 * s, -0.004 * s, n=10)
    bottom = [(w * 1.05 * math.cos(a), mz + 0.002 * s - 0.016 * s * math.sin(a))
              for a in [math.pi * i / 12 for i in range(1, 12)]]
    grin = poly_decal("Mouth_grin_lips", top + bottom, caster, "Mouth")
    teeth_top = arc(-w * 0.85, w * 0.85, mz + 0.0045 * s, -0.003 * s, n=8)
    teeth = poly_decal("Mouth_grin_teeth",
                       teeth_top + [(w * 0.8, mz - 0.0015 * s), (-w * 0.8, mz - 0.0015 * s)],
                       caster, "Teeth", offset=0.0016)
    objs.append(join([grin, teeth], "Mouth_grin"))
    oh = [(0.009 * s * math.cos(a), mz - 0.004 * s + 0.012 * s * math.sin(a))
          for a in [2 * math.pi * i / 20 for i in range(20)]]
    objs.append(poly_decal("Mouth_O", oh, caster, "Mouth"))

    # Sunglasses: two lenses, a bridge, arms back to the ears.
    bm = bmesh.new()
    for f in (1, -1):
        loc, n = caster.hit(ex * f, EYE_Z + 0.002)
        lc = loc + V(0, 1, 0) * 0.012
        add_ellipsoid(bm, lc, (0.025 * s, 0.006, 0.018 * s), rot=(0, 0, -0.22 * f), seg=(16, 8))
        add_limb(bm, lc + V(0.024 * s * f, -0.006, 0.006), 0.0028,
                 hp(0.088 * f, -0.03, 0.002), 0.0025, seg=6)
    add_limb(bm, hp(-0.012, 0.109, 0.01), 0.003, hp(0.012, 0.109, 0.01), 0.003, seg=8)
    sun = mesh_object("Sunglasses", bm)
    set_material(sun, "Lens")
    shade_smooth(sun)
    objs.append(sun)
    return objs


def join(objs, name):
    activate(objs[0])
    for o in objs[1:]:
        o.select_set(True)
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    return ob


# --------------------------------------------------------------------------
# Hair and headwear
# --------------------------------------------------------------------------

def scalp_dir(p, center, semi):
    d = p - center
    return V(d.x / semi[0], d.y / semi[1], d.z / semi[2]).normalized()


def hairline(d, front=0.42, side=-0.12, back=-0.6):
    """Height (as d.z on the unit scalp) where hair starts, by direction."""
    phi = math.atan2(d.x, d.y)        # 0 = front, +-pi = back
    # h(phi) = a + b cos(phi) + c cos(2 phi), through front, side and back.
    b = (front - back) / 2
    a = ((front + back) / 2 + side) / 2
    c = ((front + back) / 2 - side) / 2
    return a + b * math.cos(phi) + c * math.cos(2 * phi)


def shell(name, semi_pad, keep, thickness, center=None, bulge=0.0):
    """A cap of hair (or a hat) over the cranium, cut along `keep`."""
    s = HS
    c = center or hp(0, -0.014, 0.024)
    semi = (0.089 * s + semi_pad, 0.103 * s + semi_pad, 0.104 * s + semi_pad + bulge)
    bm = bmesh.new()
    add_ellipsoid(bm, c, semi, seg=(48, 32))
    kill = [f for f in bm.faces if not keep(scalp_dir(f.calc_center_median(), c, semi))]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    ob = mesh_object(name, bm)
    sol = ob.modifiers.new("s", "SOLIDIFY")
    sol.thickness = thickness
    sol.offset = -1
    sol.use_rim = True
    apply_modifiers(ob)
    return ob


def plane_shell(name, pad, planes, thickness, bulge=0.0):
    """A shell over the cranium cut by planes: (point, normal, keep_above)."""
    s = HS
    c = hp(0, -0.014, 0.024)
    semi = (0.089 * s + pad, 0.103 * s + pad, 0.104 * s + pad + bulge)
    bm = bmesh.new()
    add_ellipsoid(bm, c, semi, seg=(40, 26))
    for co, no, above in planes:
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=V(no).normalized(),
                               clear_inner=above, clear_outer=not above)
    ob = mesh_object(name, bm)
    sol = ob.modifiers.new("s", "SOLIDIFY")
    sol.thickness = thickness
    sol.offset = -1
    sol.use_rim = True
    apply_modifiers(ob)
    return ob


def hair_cap(name, front, side, back, pad, bulge, width=None):
    """
    A closed hair volume over the cranium. Below the hairline the surface is
    tucked smoothly under the scalp, so the hairline is a soft clean curve
    rather than the staircase you get from deleting faces.
    """
    s = HS
    c = hp(0, -0.014, 0.024)
    semi = (0.089 * s + pad, 0.103 * s + pad, 0.104 * s + pad + bulge)
    bm = bmesh.new()
    add_ellipsoid(bm, c, semi, seg=(64, 40))
    for v in bm.verts:
        d = scalp_dir(v.co, c, semi)
        k = smoothstep(hairline(d, front, side, back) - 0.1, hairline(d, front, side, back) + 0.02, d.z)
        if width is not None:
            k *= 1 - smoothstep(width, width + 0.1, abs(d.x))
        v.co = c + (v.co - c) * (0.8 + 0.2 * k)
    return mesh_object(name, bm)


def hair_style(name, extra=None, front=0.42, side=-0.12, back=-0.6, pad=0.009, bulge=0.012,
               voxel=0.0045, faces=1800, width=None, smooth=3):
    base = hair_cap(name, front, side, back, pad, bulge, width)
    if extra:
        bm = bmesh.new()
        bm.from_mesh(base.data)
        extra(bm)
        bm.to_mesh(base.data)
        bm.free()
    fuse(base, voxel=voxel, smooth_iters=smooth, smooth_factor=0.5, target_faces=faces)
    set_material(base, "Hair")
    return base


def build_hair():
    s = HS
    out = []
    def locks(bm):
        c = hp(0, -0.014, 0.024)
        for i in range(11):
            x = (i - 5) / 5
            # Locks start at the hairline and sweep back and to the side,
            # with a raised quiff over the forehead.
            d0 = V(x * 0.6, 0.66, 0.48).normalized()
            d1 = V(x * 0.85 - 0.2, -0.3, 0.7).normalized()
            p0 = c + V(d0.x * 0.1 * s, d0.y * 0.112 * s, d0.z * 0.12 * s)
            mid = c + (V(d0.x, d0.y, d0.z) + V(d1.x, d1.y, d1.z)).normalized() * 0.109 * s
            p1 = c + V(d1.x * 0.098 * s, d1.y * 0.11 * s, d1.z * 0.114 * s)
            r = 0.019 * s * (1.0 - 0.35 * abs(x))
            add_chain(bm, [(p0, r * 0.75), (mid, r), (p1, r * 0.8)])
        for f in (1, -1):   # sideburns
            add_limb(bm, hp(0.087 * f, 0.042, 0.005), 0.008 * s, hp(0.085 * f, 0.046, -0.025), 0.005, seg=10)
    out.append(hair_style("Hair_short", locks, side=-0.05, pad=0.005, bulge=0.006, smooth=2))

    def spikes(bm):
        for i in range(14):
            a = i * 2.39996
            r = math.sqrt((i + 0.5) / 14)
            d = V(math.sin(a) * r * 0.75, math.cos(a) * r * 0.75 - 0.2, 1.0).normalized()
            base = hp(0, -0.014, 0.024) + V(d.x * 0.09 * s, d.y * 0.1 * s, d.z * 0.1 * s)
            tip = base + (d + V(0, -0.35, 0.25)).normalized() * 0.07 * s
            add_limb(bm, base, 0.024 * s, tip, 0.003, seg=10)
    out.append(hair_style("Hair_spiky", spikes, faces=3000))

    def long_hair(bm):
        add_ellipsoid(bm, hp(0, -0.065, -0.07), (0.088 * s, 0.05 * s, 0.13 * s))
        add_ellipsoid(bm, hp(0, -0.06, -0.17), (0.095 * s, 0.045 * s, 0.07 * s))
        for f in (1, -1):
            add_ellipsoid(bm, hp(0.082 * f, -0.02, -0.06), (0.028 * s, 0.06 * s, 0.1 * s))
    out.append(hair_style("Hair_long", long_hair, side=-0.05, faces=3000))

    def ponytail(bm):
        add_sphere(bm, hp(0, -0.098, 0.05), 0.022 * s)
        add_chain(bm, [(hp(0, -0.11, 0.05), 0.03 * s), (hp(0, -0.155, -0.02), 0.034 * s),
                       (hp(0, -0.16, -0.11), 0.024 * s), (hp(0, -0.14, -0.18), 0.008 * s)])
    out.append(hair_style("Hair_ponytail", ponytail, faces=2800))

    def afro(bm):
        c = hp(0, -0.02, 0.04)
        add_ellipsoid(bm, c, (0.122 * s, 0.128 * s, 0.118 * s))
        for i in range(40):
            z = 1 - 2 * (i + 0.5) / 40
            r = math.sqrt(1 - z * z)
            a = i * 2.39996
            d = V(math.cos(a) * r, math.sin(a) * r, z)
            add_sphere(bm, c + V(d.x * 0.12 * s, d.y * 0.125 * s, d.z * 0.115 * s), 0.034 * s, seg=(12, 8))
    afro_ob = hair_style("Hair_afro", afro, faces=3200)
    # Carve the face back out of the afro.
    bm = bmesh.new()
    bm.from_mesh(afro_ob.data)
    c = hp(0, -0.014, 0.024)
    kill = []
    for f in bm.faces:
        d = scalp_dir(f.calc_center_median(), c, (0.089 * s, 0.103 * s, 0.104 * s))
        if d.y > 0.25 and d.z < 0.45 and abs(d.x) < 0.75:
            kill.append(f)
        elif d.z < -0.25 and d.y > -0.6:
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(afro_ob.data)
    bm.free()
    sol = afro_ob.modifiers.new("s", "SOLIDIFY")
    sol.thickness = 0.006
    apply_modifiers(afro_ob)
    out.append(afro_ob)

    def mohawk(bm):
        for i in range(9):
            t = i / 8
            # From the forehead (60 deg forward of vertical) over to the nape.
            ang = math.radians(60 - 190 * t)
            d = V(0, math.sin(ang), math.cos(ang))
            base = hp(0, -0.014, 0.024) + V(0, d.y * 0.1 * s, d.z * 0.1 * s)
            tip = base + (d + V(0, -0.5, 0.2)).normalized() * (0.055 + 0.03 * math.sin(math.pi * t)) * s
            add_limb(bm, base, 0.02 * s, tip, 0.004, seg=10)
    out.append(hair_style("Hair_mohawk", mohawk, pad=0.004, bulge=0.004, width=0.16))

    # Stubble buzz for "bald" players is just skin; nothing to build.
    return out


def build_headwear():
    s = HS
    # Crown cut on a plane tilted so it sits above the brow and low at the back.
    cap = plane_shell("Cap_crown", 0.016, [(hp(0, 0, 0.012), V(0, -0.33, 1), True)], 0.006, bulge=0.004)
    bm = bmesh.new()
    bm.from_mesh(cap.data)
    # Brim: a flattened disc slice sticking out over the brow.
    add_ellipsoid(bm, hp(0, 0.1, 0.03), (0.075 * s, 0.075 * s, 0.006), rot=(0.22, 0, 0), seg=(32, 8))
    add_sphere(bm, hp(0, -0.014, 0.14), 0.01)
    bm.to_mesh(cap.data)
    bm.free()
    cap.name = "Cap"
    set_material(cap, "Accent")
    shade_smooth(cap)

    band = plane_shell("Headband", 0.009, [(hp(0, 0, 0.034), V(0, -0.3, 1), True),
                                           (hp(0, 0, 0.058), V(0, -0.3, 1), False)], 0.005)
    set_material(band, "Accent")
    shade_smooth(band)

    bm = bmesh.new()
    for f in (1, -1):
        X = V(f, 1, 1)
        w = WRIST.lerp(ELBOW, 0.14)
        a = V(w.x * f, w.y, w.z)
        d = (WRIST - ELBOW).normalized()
        d = V(d.x * f, d.y, d.z)
        m = Matrix.Translation(a) @ align_z(d)
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=20,
                              radius1=0.037, radius2=0.035, depth=0.06, matrix=m)
    bands = mesh_object("Wristbands", bm)
    set_material(bands, "Accent")
    shade_smooth(bands)
    return cap, band, bands


# --------------------------------------------------------------------------
# Hands, shoes, racket
# --------------------------------------------------------------------------

# How the racket sits in a hand, expressed at the rest pose. The handle runs
# across the palm with the thumb side toward the racket head.
HAND_DIR = (HAND_TIP - WRIST).normalized()
THUMB = V(0, 1, 0)
PALM_N = THUMB.cross(HAND_DIR).normalized()          # palm faces the thigh
GRIP_R = WRIST + HAND_DIR * 0.058 - PALM_N * 0.004


def grip_frame(f=1):
    """Rest-pose racket frame for hand side f: Z up the shaft, X out of the face."""
    hand_dir = V(HAND_DIR.x * f, HAND_DIR.y, HAND_DIR.z)
    palm = V(PALM_N.x * f, PALM_N.y, PALM_N.z)
    shaft = (THUMB * 0.93 + hand_dir * 0.36).normalized()
    x = (palm - shaft * palm.dot(shaft)).normalized()
    y = shaft.cross(x)
    m = Matrix((x, y, shaft)).transposed().to_4x4()
    m.translation = V(GRIP_R.x * f, GRIP_R.y, GRIP_R.z)
    return m


def build_hands():
    bm = bmesh.new()
    for f in (1, -1):
        g = grip_frame(f)
        # Fist around the handle, knuckles out along the hand direction.
        add_ellipsoid(bm, g @ V(-0.006, 0.0, 0.0), (0.03, 0.04, 0.046), rot=g.to_3x3().to_4x4())
        add_ellipsoid(bm, g @ V(0.0, -0.022, 0.0), (0.024, 0.016, 0.042), rot=g.to_3x3().to_4x4())
        add_limb(bm, g @ V(0.018, 0.0, 0.026), 0.012, g @ V(0.014, 0.022, 0.03), 0.01, seg=12)  # thumb
        wr = V(WRIST.x * f, WRIST.y, WRIST.z)
        add_limb(bm, wr, 0.03, g @ V(-0.004, -0.02, -0.004), 0.03)
    ob = mesh_object("Hands", bm)
    fuse(ob, voxel=0.004, smooth_iters=3, target_faces=1400)
    set_material(ob, "Skin")
    return ob


def build_shoes():
    parts = []
    for f in (1, -1):
        bm = bmesh.new()
        x = 0.095 * f
        add_ellipsoid(bm, (x, -0.005, 0.055), (0.046, 0.062, 0.052))        # heel
        add_ellipsoid(bm, (x + 0.004 * f, 0.085, 0.042), (0.05, 0.085, 0.04))  # toe box
        add_ellipsoid(bm, (x, 0.02, 0.09), (0.04, 0.055, 0.045))             # tongue/instep
        add_limb(bm, (x, -0.012, 0.09), 0.04, (x, 0.0, 0.11), 0.038)          # collar
        # Sole slab
        add_ellipsoid(bm, (x, 0.05, 0.016), (0.056, 0.15, 0.018), seg=(32, 10))
        ob = mesh_object(f"Shoe{f}", bm)
        fuse(ob, voxel=0.004, smooth_iters=4, target_faces=1600)
        set_material(ob, "Shoes", "Sole")
        for p in ob.data.polygons:
            p.material_index = 1 if p.center.z < 0.026 else 0
        # A swoosh-free accent stripe along the side, in the sole colour.
        for p in ob.data.polygons:
            side = abs(p.center.x - x) > 0.035
            if side and 0.04 < p.center.z < 0.052 and -0.03 < p.center.y < 0.1:
                p.material_index = 1
        parts.append(ob)
    return parts


RACKET_HEAD_LEN = 0.165     # semi-axis along the shaft
RACKET_HEAD_W = 0.128       # semi-axis across
HANDLE_BELOW = 0.075        # handle length below the grip point
SHAFT_TO_HEAD = 0.27        # grip point to the bottom of the head


def string_texture(mat):
    """One cell of string net, tiled by the UVs: lines on the cell's edges."""
    size = 32
    img = bpy.data.images.new("strings", size, size, alpha=True)
    px = []
    for y in range(size):
        for x in range(size):
            on = x < 3 or y < 3
            px += [0.93, 0.95, 0.96, 1.0 if on else 0.0]
    img.pixels = px
    img.pack()
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Closest"
    bsdf = nt.nodes["Principled BSDF"]
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    for attr, value in (("surface_render_method", "DITHERED"), ("blend_method", "HASHED")):
        try:
            setattr(mat, attr, value)
        except (AttributeError, TypeError):
            pass


def build_racket():
    """Built in its own frame (grip at origin, shaft +Z, face normal +X)."""
    bm = bmesh.new()
    hc = SHAFT_TO_HEAD + RACKET_HEAD_LEN   # head centre along Z
    # Frame: a ring of short capsules around an oval.
    n = 40
    ring = [V(0, RACKET_HEAD_W * math.sin(2 * math.pi * i / n),
              hc + RACKET_HEAD_LEN * math.cos(2 * math.pi * i / n)) for i in range(n)]
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        m = Matrix.Translation((a + b) / 2) @ align_z(b - a) @ Matrix.Diagonal((1.0, 0.55, 1, 1))
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=10,
                              radius1=0.0115, radius2=0.0115, depth=(b - a).length * 1.15, matrix=m)
    # Throat: two arms from the shaft top to the head.
    top = V(0, 0, 0.16)
    for f in (1, -1):
        a = V(0, 0.06 * f, SHAFT_TO_HEAD + 0.012)
        add_limb(bm, top, 0.011, a, 0.0105, seg=10)
    # Shaft and handle (octagonal grip).
    add_limb(bm, V(0, 0, 0.06), 0.012, top, 0.0115, seg=10)
    m = Matrix.Translation(V(0, 0, 0.0)) @ Matrix.Diagonal((1, 1, 1, 1))
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=8, radius1=0.0165,
                          radius2=0.0165, depth=HANDLE_BELOW + 0.12, matrix=Matrix.Translation(V(0, 0, (0.12 - HANDLE_BELOW) / 2)))
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=8, radius1=0.019,
                          radius2=0.017, depth=0.012, matrix=Matrix.Translation(V(0, 0, -HANDLE_BELOW)))
    ob = mesh_object("Racket", bm)
    # Smooth shading also keeps the file small: flat faces cannot share
    # vertices, which made the racket a quarter of the whole model.
    shade_smooth(ob)
    set_material(ob, "RacketFrame", "Grip")
    for p in ob.data.polygons:
        if p.center.z < 0.06 and abs(p.center.x) < 0.03:
            p.material_index = 1
    # Strings: a flat oval with a UV grid the game textures with a string net.
    bm = bmesh.new()
    verts = [bm.verts.new((0, RACKET_HEAD_W * 0.93 * math.sin(2 * math.pi * i / 32),
                           hc + RACKET_HEAD_LEN * 0.93 * math.cos(2 * math.pi * i / 32))) for i in range(32)]
    bm.faces.new(verts)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    strings = mesh_object("Strings", bm)
    set_material(strings, "Strings")
    string_texture(MATS["Strings"])
    uv = strings.data.uv_layers.new(name="UVMap")
    for loop in strings.data.loops:
        co = strings.data.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = ((co.y / RACKET_HEAD_W + 1) / 2 * 6, (co.z - hc) / RACKET_HEAD_LEN * 7)
    return ob, strings


# --------------------------------------------------------------------------
# Clothing: shells lifted off the body with clean hems.
# --------------------------------------------------------------------------

SEGMENTS = {
    "torso": (V(0, 0, 0.9), V(0, 0, 1.47)),
    "neck": (V(0, 0, 1.47), V(0, 0, 1.62)),
}
for s, f in (("R", 1), ("L", -1)):
    X = lambda p: V(p.x * f, p.y, p.z)
    SEGMENTS[f"ua.{s}"] = (X(SH), X(ELBOW))
    SEGMENTS[f"fa.{s}"] = (X(ELBOW), X(WRIST))
    SEGMENTS[f"th.{s}"] = (X(HIP), X(KNEE))
    SEGMENTS[f"sh.{s}"] = (X(KNEE), X(ANKLE))


def nearest_segment(p):
    best = None
    for name, (a, b) in SEGMENTS.items():
        ab = b - a
        t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
        d = (p - (a + ab * t)).length
        # Torso is wide, so measure it with a slightly favourable bias.
        if name == "torso":
            d -= 0.06
        if best is None or d < best[1]:
            best = (name, d, t)
    return best


SLEEVE_T = 0.5
COLLAR_R = 0.064
SHIRT_HEM_Z = 0.925
SHORTS_TOP_Z = 0.99
SHORTS_HEM_Z = 0.6
SOCK_TOP_Z = 0.19
COLLAR_N = V(0, 0.42, 1).normalized()
COLLAR_P = V(0, 0, 1.475)


def arm_part(p):
    """'ua'/'fa' with the param along it if p belongs to an arm, else None."""
    name, _, t = nearest_segment(p)
    if name.startswith(("ua.", "fa.")) and p.z > 0.95:
        return name[:2], t
    return None


def in_collar(p, margin=0.0):
    """The neck hole: a round opening that dips at the front."""
    r = math.hypot(p.x, p.y - 0.005)
    lip = 1.462 - 0.022 * max(0.0, p.y / 0.1)
    return p.z > lip - margin and r < COLLAR_R + margin


def in_shirt(p, margin=0.0):
    arm = arm_part(p)
    if arm:
        return arm[0] == "ua" and arm[1] < SLEEVE_T - margin * 3
    if in_collar(p, margin):
        return False
    return SHIRT_HEM_Z + margin < p.z < 1.62


def in_shorts(p, margin=0.0):
    if arm_part(p):
        return False
    return SHORTS_HEM_Z + margin < p.z < SHORTS_TOP_Z - margin


def bisect_all(bm):
    """Cut every hem line into the body so the shells get straight edges."""
    everywhere = lambda c: True
    near_neck = lambda c: c.z > 1.36 and math.hypot(c.x, c.y) < 0.16
    planes = [(V(0, 0, SHIRT_HEM_Z), V(0, 0, 1), everywhere),
              (V(0, 0, SHORTS_TOP_Z), V(0, 0, 1), everywhere),
              (V(0, 0, SHORTS_HEM_Z), V(0, 0, 1), everywhere),
              (V(0, 0, SOCK_TOP_Z), V(0, 0, 1), everywhere)]
    # The collar: a ring of vertical planes plus the lip, which dips in front.
    for i in range(16):
        a = 2 * math.pi * i / 16
        n = V(math.sin(a), math.cos(a), 0)
        planes.append((V(0, 0.005, 0) + n * COLLAR_R, n, near_neck))
    planes.append((V(0, 0, 1.462), V(0, 0, 1), lambda c: near_neck(c) and c.y < 0))
    planes.append((V(0, 0, 1.462), V(0, 0.22, 1).normalized(), lambda c: near_neck(c) and c.y >= 0))
    for f in (1, -1):
        a, b = SEGMENTS["ua.R" if f == 1 else "ua.L"]
        mid = a.lerp(b, SLEEVE_T)
        planes.append((mid, (b - a).normalized(), lambda c, m=mid: (c - m).length < 0.12))
    for co, no, where in planes:
        faces = [f for f in bm.faces if where(f.calc_center_median())]
        edges = list({e for f in faces for e in f.edges})
        verts = list({v for f in faces for v in f.verts})
        bmesh.ops.bisect_plane(bm, geom=verts + edges + faces, plane_co=co, plane_no=no)


def garment(body, name, region, push, mat):
    """Copy the body faces in `region`, push them out along the normals."""
    me = body.data.copy()
    ob = link(bpy.data.objects.new(name, me))
    bm = bmesh.new()
    bm.from_mesh(me)
    kill = [f for f in bm.faces if not region(f.calc_center_median())]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    # Fabric drapes over muscles instead of shrink-wrapping them: smooth the
    # inside of the shell, leaving the hem edges where they were cut.
    inner = [v for v in bm.verts if not v.is_boundary]
    for _ in range(10):
        bmesh.ops.smooth_vert(bm, verts=inner, factor=0.5,
                              use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.normal_update()
    for v in bm.verts:
        v.co = v.co + v.normal * push(v.co)
    bm.to_mesh(me)
    bm.free()
    sol = ob.modifiers.new("s", "SOLIDIFY")
    sol.thickness = 0.005
    sol.offset = -1
    sol.use_rim = True
    apply_modifiers(ob)
    set_material(ob, mat)
    shade_smooth(ob)
    return ob


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def build_clothes(body):
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bisect_all(bm)
    bm.to_mesh(body.data)
    bm.free()

    def shirt_push(p):
        arm = arm_part(p)
        if arm:
            return 0.012 + 0.012 * (arm[1] / SLEEVE_T) ** 2
        return 0.012 + 0.014 * smoothstep(1.06, SHIRT_HEM_Z, p.z)

    def shorts_push(p):
        return 0.012 + 0.022 * smoothstep(0.8, SHORTS_HEM_Z, p.z)

    shirt = garment(body, "Shirt", in_shirt, shirt_push, "Shirt")
    shorts = garment(body, "Shorts", in_shorts, shorts_push, "Shorts")

    # Shirt UVs for the printed designs: wrap around the torso, front centre at
    # u=0.5. The torso fills v 0..0.9 (hem to shoulders); the sleeves get the
    # band above it, v 0.92..0.97, so a chest print never lands on a sleeve.
    uv = shirt.data.uv_layers.new(name="UVMap")
    for loop in shirt.data.loops:
        p = shirt.data.vertices[loop.vertex_index].co
        name, _, t = nearest_segment(p)
        if name.startswith("ua."):
            a, b = SEGMENTS[name]
            ax = (b - a).normalized()
            r = p - (a + (b - a) * t)
            ang = math.atan2(r.dot(V(0, 1, 0)), r.dot(V(0, 0, 1).cross(ax).normalized()))
            uv.data[loop.index].uv = (0.5 + ang / (2 * math.pi), 0.97 - 0.05 * t / SLEEVE_T)
        else:
            u = 0.5 + math.atan2(p.x, p.y) / (2 * math.pi)
            v = 0.9 * (p.z - SHIRT_HEM_Z) / (1.5 - SHIRT_HEM_Z)
            uv.data[loop.index].uv = (u, max(0.0, min(0.9, v)))
    # Fix the seam at the back so faces do not smear the whole texture.
    for poly in shirt.data.polygons:
        us = [uv.data[i].uv[0] for i in poly.loop_indices]
        if max(us) - min(us) > 0.5:
            for i in poly.loop_indices:
                if uv.data[i].uv[0] < 0.5:
                    uv.data[i].uv[0] += 1.0

    # Body: socks get their own material; skin hidden under clothes is removed.
    set_material(body, "Skin", "Socks")
    bm = bmesh.new()
    bm.from_mesh(body.data)
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        if in_shirt(c, margin=0.03) or in_shorts(c, margin=0.035):
            kill.append(f)
        elif c.z < SOCK_TOP_Z:
            f.material_index = 1
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(body.data)
    bm.free()
    return shirt, shorts


# --------------------------------------------------------------------------
# Rig
# --------------------------------------------------------------------------

def build_armature():
    arm = bpy.data.armatures.new("Rig")
    ob = link(bpy.data.objects.new("Rig", arm))
    activate(ob)
    bpy.ops.object.mode_set(mode="EDIT")
    for name, head, tail, parent in BONES:
        eb = arm.edit_bones.new(name)
        eb.head, eb.tail = head, tail
        if parent:
            eb.parent = arm.edit_bones[parent]
            eb.use_connect = False
    for eb in arm.edit_bones:
        eb.roll = 0.0
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in ob.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return ob


def bind_auto(ob, rig):
    activate(rig)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


def bind_rigid(ob, rig, bone):
    vg = ob.vertex_groups.new(name=bone)
    vg.add(range(len(ob.data.vertices)), 1.0, "REPLACE")
    ob.parent = rig
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = rig


def place(ob, matrix):
    ob.data.transform(matrix)


# --------------------------------------------------------------------------
# Posing: key poses, sampled per frame with IK for feet and hands.
# --------------------------------------------------------------------------

def rest3(pb):
    return pb.bone.matrix_local.to_3x3()


def posed_rot(pb):
    """Armature-space rotation of a posed bone relative to its rest."""
    return pb.matrix.to_3x3() @ rest3(pb).inverted()


def set_world(pb, R, head):
    m = (R @ rest3(pb)).to_4x4()
    m.translation = head
    pb.matrix = m
    bpy.context.view_layer.update()


def fk(pb, euler):
    """Rotate a bone by `euler` (armature axes), on top of its parent."""
    R = Euler(euler).to_matrix()
    parent = posed_rot(pb.parent) if pb.parent else Matrix.Identity(3)
    head = pb.parent.matrix @ (pb.parent.bone.matrix_local.inverted() @ pb.bone.head_local) \
        if pb.parent else pb.bone.head_local
    set_world(pb, parent @ R, head)


def two_bone(root, target, l1, l2, pole):
    d = target - root
    dist = min(d.length, (l1 + l2) * 0.999)
    dn = d.normalized()
    a = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)
    a = max(-1.0, min(1.0, a))
    ang = math.acos(a)
    side = (pole - dn * pole.dot(dn)).normalized()
    elbow = root + (dn * math.cos(ang) + side * math.sin(ang)) * l1
    return elbow, root + dn * dist


def aim_bone(pb, direction, head, twist_ref=None):
    rest_dir = (pb.bone.tail_local - pb.bone.head_local).normalized()
    R = rest_dir.rotation_difference(direction.normalized()).to_matrix()
    set_world(pb, R, head)


RACKET_OFFSET = {}   # hand bone rest -> grip frame, filled after the rig exists


def racket_frame(grip, shaft, ref, tilt):
    shaft = V(shaft).normalized()
    n = V(ref).cross(shaft)
    if n.length < 1e-4:
        n = V(1, 0, 0)
    n.normalize()
    n = Quaternion(shaft, tilt) @ n
    y = shaft.cross(n)
    m = Matrix((n, y, shaft)).transposed().to_4x4()
    m.translation = V(grip)
    return m


def solve_arm(rig, side, wrist_target, hand_world, pole):
    pb = rig.pose.bones
    ua, fa, hd = pb[f"upper_arm.{side}"], pb[f"forearm.{side}"], pb[f"hand.{side}"]
    root = ua.head.copy()
    l1 = (ua.bone.tail_local - ua.bone.head_local).length
    l2 = (fa.bone.tail_local - fa.bone.head_local).length
    elbow, wrist = two_bone(root, wrist_target, l1, l2, V(pole))
    aim_bone(ua, elbow - root, root)
    aim_bone(fa, wrist - elbow, elbow)
    # Spread the hand's roll over the forearm so the wrist does not wrap.
    want = hand_world.to_3x3() @ hd.bone.matrix_local.to_3x3().inverted()
    fa_rot = posed_rot(fa)
    axis = (wrist - elbow).normalized()
    probe = (fa_rot @ rest3(fa)) @ V(1, 0, 0)
    target = (want @ rest3(hd)) @ V(1, 0, 0)
    p1 = (probe - axis * probe.dot(axis)).normalized()
    p2 = (target - axis * target.dot(axis)).normalized()
    ang = math.atan2(axis.dot(p1.cross(p2)), p1.dot(p2))
    set_world(fa, Quaternion(axis, ang * 0.5).to_matrix() @ fa_rot, elbow)
    m = hand_world.copy()
    m.translation = wrist
    hd.matrix = m
    bpy.context.view_layer.update()


def solve_leg(rig, side, ankle, yaw, pitch, pole):
    pb = rig.pose.bones
    th, sh, ft = pb[f"thigh.{side}"], pb[f"shin.{side}"], pb[f"foot.{side}"]
    root = th.head.copy()
    l1 = (th.bone.tail_local - th.bone.head_local).length
    l2 = (sh.bone.tail_local - sh.bone.head_local).length
    knee, a = two_bone(root, V(ankle), l1, l2, V(pole))
    aim_bone(th, knee - root, root)
    aim_bone(sh, a - knee, knee)
    R = Euler((pitch, 0, yaw)).to_matrix()
    set_world(ft, R, a)


DEFAULT = dict(
    hip=(0, 0, 0), hipr=(0, 0, 0), spine=(0, 0, 0), chest=(0, 0, 0), neck=(0, 0, 0), head=(0, 0, 0),
    clavR=(0, 0, 0), clavL=(0, 0, 0),
    ankR=(0.11, 0.0, 0.085), ankL=(-0.11, 0.0, 0.085), footR=(0, -0.08), footL=(0, 0.08),
    kneeR=(0.2, 1, 0), kneeL=(-0.2, 1, 0),
    grip=(0.3, 0.3, 0.95), shaft=(0, 0.6, 0.8), ref=(0, 0, 1), tilt=0.0, elbowR=(0.6, -0.3, -1),
    lhOn=1.0, lhSlide=0.2, lhFree=(-0.3, 0.2, 0.95), elbowL=(-0.6, -0.3, -1),
)


def apply_pose(rig, P):
    pb = rig.pose.bones
    for b in pb:
        b.rotation_quaternion = (1, 0, 0, 0)
        b.location = (0, 0, 0)
    bpy.context.view_layer.update()
    hips = pb["hips"]
    set_world(hips, Euler(P["hipr"]).to_matrix(), hips.bone.head_local + V(P["hip"]))
    for name in ("spine", "chest", "neck", "head"):
        fk(pb[name], P[name])
    fk(pb["shoulder.R"], P["clavR"])
    cl = P["clavL"]
    fk(pb["shoulder.L"], (cl[0], -cl[1], -cl[2]))

    for side in ("R", "L"):
        ank = P["ank" + side]
        yaw, pitch = P["foot" + side]
        solve_leg(rig, side, ank, yaw, pitch, P["knee" + side])

    # Racket hand: desired racket frame -> hand frame -> arm IK.
    W = racket_frame(P["grip"], P["shaft"], P["ref"], P["tilt"])
    hand_R = W @ RACKET_OFFSET["R"].inverted()
    solve_arm(rig, "R", hand_R.translation.copy(), hand_R, P["elbowR"])

    # Off hand: on the racket throat, or free.
    shaft = V(P["shaft"]).normalized()
    on = max(0.0, min(1.0, P["lhOn"]))
    W_on = racket_frame(V(P["grip"]) + shaft * P["lhSlide"], P["shaft"], P["ref"], P["tilt"])
    flip = Matrix.Diagonal((-1, -1, 1, 1))
    hand_on = W_on @ flip @ RACKET_OFFSET["L"].inverted()
    free_pos = V(P["lhFree"])
    hd = pb["hand.L"]
    # A free hand just carries on from the forearm.
    tmp_target = hand_on.translation.lerp(free_pos, 1 - on)
    if on > 0.999:
        solve_arm(rig, "L", hand_on.translation.copy(), hand_on, P["elbowL"])
    else:
        ua = pb["upper_arm.L"]
        root = ua.head.copy()
        l1 = (ua.bone.tail_local - ua.bone.head_local).length
        l2 = (pb["forearm.L"].bone.tail_local - pb["forearm.L"].bone.head_local).length
        elbow, wrist = two_bone(root, tmp_target, l1, l2, V(P["elbowL"]))
        free_m = Matrix.Translation(wrist) @ (
            (wrist - elbow).normalized().to_track_quat("Y", "Z").to_matrix().to_4x4())
        # Hand matrix that keeps the rest roll relative to the forearm.
        fa_dir_rest = (pb["forearm.L"].bone.tail_local - pb["forearm.L"].bone.head_local).normalized()
        Rf = fa_dir_rest.rotation_difference((wrist - elbow).normalized()).to_matrix()
        free_hand = (Rf @ rest3(hd)).to_4x4()
        free_hand.translation = wrist
        q_on = hand_on.to_quaternion()
        q_free = free_hand.to_quaternion()
        q = q_free.slerp(q_on, on)
        hm = q.to_matrix().to_4x4()
        hm.translation = wrist
        solve_arm(rig, "L", tmp_target, hm, P["elbowL"])


def lerp_pose(a, b, t):
    out = {}
    for k in a:
        va, vb = a[k], b[k]
        if isinstance(va, tuple):
            out[k] = tuple(x + (y - x) * t for x, y in zip(va, vb))
        else:
            out[k] = va + (vb - va) * t
    return out


def catmull(p0, p1, p2, p3, t):
    t2, t3 = t * t, t * t * t
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)


def sample(keys, t, loop, length):
    """Catmull-Rom through the key poses at time t."""
    times = [k[0] for k in keys]
    poses = [k[1] for k in keys]
    n = len(keys)
    if loop:
        t = t % length
    i = 0
    while i < n - 1 and times[i + 1] <= t:
        i += 1
    if not loop and i >= n - 1:
        return poses[-1]
    j = (i + 1) % n
    t0 = times[i]
    t1 = times[j] if j > i else times[j] + length
    u = (t - t0) / (t1 - t0) if t1 > t0 else 0
    ip = (i - 1) % n if loop else max(0, i - 1)
    jn = (j + 1) % n if loop else min(n - 1, j + 1)
    out = {}
    for k in poses[i]:
        va = [poses[ip][k], poses[i][k], poses[j][k], poses[jn][k]]
        if isinstance(va[1], tuple):
            out[k] = tuple(catmull(*(v[c] for v in va), u) for c in range(len(va[1])))
        else:
            out[k] = catmull(*va, u)
    return out


def pose(**kw):
    p = dict(DEFAULT)
    p.update({k: tuple(v) if isinstance(v, (list, tuple)) else v for k, v in kw.items()})
    return p


def bake(rig, name, keys, length, loop):
    ad = rig.animation_data or rig.animation_data_create()
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ad.action = act
    frames = int(round(length * FPS)) + (0 if loop else 1)
    prev = {}
    for f in range(frames + (1 if loop else 0)):
        t = f / FPS
        P = sample(keys, t, loop, length)
        apply_pose(rig, P)
        for b in rig.pose.bones:
            q = b.rotation_quaternion.copy()
            if b.name in prev and prev[b.name].dot(q) < 0:
                q.negate()
                b.rotation_quaternion = q
            prev[b.name] = q
            b.keyframe_insert("rotation_quaternion", frame=f + 1)
            if b.name == "hips":
                b.keyframe_insert("location", frame=f + 1)
    ad.action = None
    track = ad.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, act)
    strip.name = name
    return act


# --------------------------------------------------------------------------
# The animations
# --------------------------------------------------------------------------

READY = pose(
    hip=(0, 0.01, -0.085), hipr=(-0.12, 0, 0), spine=(-0.06, 0, 0), chest=(-0.04, 0, 0),
    neck=(0.1, 0, 0), head=(0.06, 0, 0),
    ankR=(0.25, 0.02, 0.085), ankL=(-0.25, 0.02, 0.085), footR=(-0.25, 0), footL=(0.25, 0),
    kneeR=(0.35, 1, 0), kneeL=(-0.35, 1, 0),
    grip=(0.06, 0.34, 0.98), shaft=(-0.18, 0.62, 0.78), ref=(0, 0, 1), tilt=0.0,
    elbowR=(0.8, -0.2, -0.8), lhOn=1.0, lhSlide=0.2, elbowL=(-0.8, -0.2, -0.8),
)


def idle_keys():
    up = lerp_pose(READY, pose(**{**READY, "hip": (0, 0.01, -0.07)}), 1.0)
    low = pose(**{**READY, "hip": (0, 0.012, -0.1), "grip": (0.06, 0.34, 0.965)})
    sway = pose(**{**READY, "hip": (0.012, 0.01, -0.08), "hipr": (-0.12, 0, 0.04), "chest": (-0.04, 0, -0.04)})
    return [(0.0, up), (0.3, low), (0.6, up), (0.9, sway)], 1.2


def run_keys():
    """Running forward with the racket carried; a 2-step loop."""
    L = 0.6
    keys = []
    N = 8
    for i in range(N):
        t = i / N
        ph = 2 * math.pi * t
        def foot(ph):
            # Stance while moving back (cos falling), flight forward and up.
            y = 0.32 * math.cos(ph)
            lift = max(0.0, math.sin(ph - math.pi)) if True else 0
            z = 0.085 + 0.2 * lift ** 1.4
            return y - 0.02, z
        yr, zr = foot(ph)
        yl, zl = foot(ph + math.pi)
        bob = -0.075 + 0.03 * math.cos(2 * ph + 0.6)
        swing = math.sin(ph)
        keys.append((t * L, pose(
            hip=(0, 0.04, bob), hipr=(-0.22, 0, 0.12 * swing), spine=(-0.06, 0, -0.08 * swing),
            chest=(-0.04, 0, -0.1 * swing), neck=(0.2, 0, 0.06 * swing), head=(0.1, 0, 0.04 * swing),
            ankR=(0.1, yr, zr), ankL=(-0.1, yl, zl),
            footR=(0.0, -0.5 * max(0, math.sin(ph - math.pi)) + 0.25 * max(0, math.cos(ph))),
            footL=(0.0, -0.5 * max(0, math.sin(ph)) + 0.25 * max(0, math.cos(ph + math.pi))),
            kneeR=(0.05, 1, 0), kneeL=(-0.05, 1, 0),
            grip=(0.27, 0.16 - 0.14 * swing, 0.96 + 0.03 * abs(swing)),
            shaft=(0.25, 0.9, 0.05 - 0.15 * swing), ref=(0, 0, 1), tilt=1.2,
            elbowR=(0.5, -0.6, -0.6),
            lhOn=0.0, lhFree=(-0.24, 0.22 + 0.16 * swing, 1.02 + 0.03 * abs(swing)), elbowL=(-0.4, -0.7, -0.6),
        )))
    return keys, L


def forehand_keys():
    back = pose(
        hip=(0.05, -0.02, -0.08), hipr=(-0.1, 0, -0.55), spine=(-0.04, 0, -0.25), chest=(-0.02, 0.05, -0.35),
        neck=(0.1, 0, 0.5), head=(0.05, 0, 0.4),
        ankR=(0.3, -0.08, 0.085), ankL=(-0.18, 0.18, 0.085), footR=(-0.9, 0), footL=(-0.3, 0),
        kneeR=(0.6, 1, 0), kneeL=(-0.2, 1, 0),
        grip=(0.42, -0.36, 1.12), shaft=(0.25, -0.55, 0.8), ref=(0, 0, 1), tilt=-0.4, elbowR=(0.6, -0.5, -0.6),
        lhOn=0.0, lhFree=(0.05, 0.42, 1.2), elbowL=(-0.3, -0.6, -0.6),
    )
    drop = pose(**{**back,
                   "grip": (0.5, -0.12, 0.9), "shaft": (0.55, -0.75, -0.1), "tilt": -0.2,
                   "hipr": (-0.1, 0, -0.4), "chest": (-0.02, 0.05, -0.25)})
    contact = pose(
        hip=(0.03, 0.03, -0.085), hipr=(-0.1, 0, -0.05), spine=(-0.04, 0, 0.0), chest=(-0.02, 0, 0.05),
        neck=(0.1, 0, 0.1), head=(0.05, 0, 0.05),
        ankR=(0.3, -0.08, 0.085), ankL=(-0.18, 0.18, 0.085), footR=(-0.7, -0.35), footL=(-0.3, 0),
        kneeR=(0.5, 1, 0), kneeL=(-0.2, 1, 0),
        grip=(0.42, 0.4, 0.98), shaft=(0.8, 0.55, 0.15), ref=(0, 0, 1), tilt=0.0, elbowR=(0.5, -0.6, -0.6),
        lhOn=0.0, lhFree=(-0.28, 0.25, 1.1), elbowL=(-0.5, -0.5, -0.6),
    )
    finish = pose(
        hip=(0.0, 0.05, -0.07), hipr=(-0.1, 0, 0.45), spine=(-0.04, 0, 0.2), chest=(-0.02, -0.05, 0.35),
        neck=(0.1, 0, -0.35), head=(0.05, 0, -0.25),
        ankR=(0.26, -0.04, 0.11), ankL=(-0.18, 0.18, 0.085), footR=(-0.6, -0.6), footL=(-0.3, 0),
        kneeR=(0.4, 1, 0), kneeL=(-0.2, 1, 0),
        grip=(-0.2, 0.22, 1.45), shaft=(-0.55, -0.5, 0.55), ref=(0, 0, 1), tilt=0.2, elbowR=(0.2, -0.3, -0.9),
        lhOn=0.0, lhFree=(-0.16, 0.16, 1.32), elbowL=(-0.7, -0.4, -0.4),
    )
    return [(0.0, back), (0.08, drop), (0.15, contact), (0.32, finish), (0.5, finish), (0.85, READY)], 0.85


def backhand_keys():
    """Two-handed: both hands on the grip, turn from the left."""
    back = pose(
        hip=(-0.05, -0.02, -0.08), hipr=(-0.1, 0, 0.6), spine=(-0.04, 0, 0.25), chest=(-0.02, -0.05, 0.4),
        neck=(0.1, 0, -0.55), head=(0.05, 0, -0.4),
        ankR=(0.16, 0.2, 0.085), ankL=(-0.3, -0.08, 0.085), footR=(0.3, 0), footL=(0.9, 0),
        kneeR=(0.2, 1, 0), kneeL=(-0.6, 1, 0),
        grip=(-0.36, -0.28, 1.1), shaft=(-0.3, -0.55, 0.78), ref=(0, 0, 1), tilt=0.3, elbowR=(-0.2, -0.6, -0.6),
        lhOn=1.0, lhSlide=0.085, elbowL=(-0.7, -0.4, -0.6),
    )
    drop = pose(**{**back, "grip": (-0.42, -0.08, 0.9), "shaft": (-0.6, -0.7, -0.1), "tilt": 0.2,
                   "hipr": (-0.1, 0, 0.45), "chest": (-0.02, -0.05, 0.3)})
    contact = pose(
        hip=(-0.03, 0.03, -0.085), hipr=(-0.1, 0, 0.05), spine=(-0.04, 0, 0.0), chest=(-0.02, 0, -0.05),
        neck=(0.1, 0, -0.1), head=(0.05, 0, -0.05),
        ankR=(0.16, 0.2, 0.085), ankL=(-0.3, -0.08, 0.085), footR=(0.3, 0), footL=(0.7, 0.35),
        kneeR=(0.2, 1, 0), kneeL=(-0.5, 1, 0),
        grip=(-0.3, 0.42, 0.98), shaft=(-0.8, 0.55, 0.15), ref=(0, 0, 1), tilt=0.0, elbowR=(-0.2, -0.6, -0.6),
        lhOn=1.0, lhSlide=0.085, elbowL=(-0.6, -0.5, -0.6),
    )
    finish = pose(
        hip=(0.0, 0.05, -0.07), hipr=(-0.1, 0, -0.45), spine=(-0.04, 0, -0.2), chest=(-0.02, 0.05, -0.35),
        neck=(0.1, 0, 0.35), head=(0.05, 0, 0.25),
        ankR=(0.16, 0.2, 0.085), ankL=(-0.26, -0.04, 0.11), footR=(0.3, 0), footL=(0.6, 0.6),
        kneeR=(0.2, 1, 0), kneeL=(-0.4, 1, 0),
        grip=(0.22, 0.2, 1.42), shaft=(0.55, -0.5, 0.55), ref=(0, 0, 1), tilt=-0.2, elbowR=(0.3, -0.3, -0.9),
        lhOn=1.0, lhSlide=0.085, elbowL=(-0.2, -0.3, -0.9),
    )
    return [(0.0, back), (0.08, drop), (0.15, contact), (0.32, finish), (0.5, finish), (0.85, READY)], 0.85


def serve_keys():
    """Overhead: from the trophy position, up through the ball, down across."""
    trophy = pose(
        hip=(0, -0.02, -0.1), hipr=(0.05, 0, -0.5), spine=(0.1, 0, -0.2), chest=(0.12, 0.15, -0.3),
        neck=(0.3, 0, 0.3), head=(0.25, 0, 0.2),
        ankR=(0.2, -0.12, 0.085), ankL=(-0.12, 0.16, 0.085), footR=(-0.9, 0), footL=(-0.5, 0),
        kneeR=(0.5, 1, 0), kneeL=(-0.3, 1, 0),
        grip=(0.32, -0.12, 1.55), shaft=(0.0, -0.35, -0.94), ref=(1, 0, 0), tilt=0.0, elbowR=(1, -0.2, 0.4),
        lhOn=0.0, lhFree=(-0.12, 0.25, 1.95), elbowL=(-0.4, 0, -0.4),
    )
    contact = pose(
        hip=(0, 0.05, -0.04), hipr=(-0.08, 0, -0.05), spine=(-0.04, 0, 0.0), chest=(-0.06, 0.0, 0.05),
        neck=(0.35, 0, 0.0), head=(0.3, 0, 0.0),
        ankR=(0.16, -0.02, 0.13), ankL=(-0.12, 0.16, 0.12), footR=(-0.5, -0.5), footL=(-0.4, -0.4),
        kneeR=(0.3, 1, 0), kneeL=(-0.3, 1, 0),
        grip=(0.22, 0.22, 2.05), shaft=(0.0, 0.45, 0.89), ref=(-1, 0, 0), tilt=0.0, elbowR=(1, 0, 0),
        lhOn=0.0, lhFree=(-0.15, 0.25, 1.35), elbowL=(-0.6, -0.4, -0.4),
    )
    finish = pose(
        hip=(0, 0.1, -0.12), hipr=(-0.35, 0, 0.35), spine=(-0.15, 0, 0.15), chest=(-0.15, 0.0, 0.25),
        neck=(0.25, 0, -0.2), head=(0.1, 0, -0.1),
        ankR=(0.16, 0.2, 0.15), ankL=(-0.12, 0.16, 0.085), footR=(-0.2, -0.7), footL=(-0.3, 0),
        kneeR=(0.3, 1, 0), kneeL=(-0.3, 1, 0),
        grip=(-0.18, 0.3, 0.85), shaft=(-0.4, -0.3, -0.85), ref=(0, 1, 0), tilt=0.0, elbowR=(0.5, -0.2, -0.8),
        lhOn=0.0, lhFree=(-0.25, 0.05, 1.0), elbowL=(-0.6, -0.4, -0.6),
    )
    return [(0.0, trophy), (0.14, contact), (0.36, finish), (0.55, finish), (0.95, READY)], 0.95


def cheer_keys():
    """Fist pump after winning a point."""
    a = pose(**{**READY, "lhOn": 0.0, "lhFree": (-0.28, 0.12, 1.0), "elbowL": (-0.6, -0.3, -0.7),
                "grip": (0.3, 0.1, 1.0), "shaft": (0.2, 0.3, -0.93), "ref": (0, 1, 0), "elbowR": (0.7, -0.3, -0.6),
                "hip": (0, 0.0, -0.05), "hipr": (0.0, 0, 0), "spine": (0.0, 0, 0)})
    pump = pose(**{**a, "lhFree": (-0.24, 0.16, 1.62), "elbowL": (-0.8, -0.3, -0.3),
                   "chest": (-0.12, 0, 0.1), "neck": (0.15, 0, 0), "head": (0.1, 0, 0), "hip": (0, 0.02, -0.11),
                   "hipr": (-0.1, 0, 0)})
    low = pose(**{**pump, "lhFree": (-0.22, 0.28, 1.12), "elbowL": (-0.8, -0.6, -0.4)})
    return [(0.0, READY), (0.2, a), (0.45, pump), (0.65, low), (0.85, pump), (1.25, a), (1.6, READY)], 1.6


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

print("building body")
body = build_body()
print("  body faces", len(body.data.polygons))
head = build_head()
caster = FaceCaster(head)
eyes, lids = build_eyes(caster)
face_parts = build_face(caster)
hands = build_hands()
shoes = build_shoes()
hair = build_hair()
cap, band, bands = build_headwear()
racket, strings = build_racket()

rig = build_armature()

# Racket in the right hand at rest; remember the hand -> racket offset.
for side, f in (("R", 1), ("L", -1)):
    hand_rest = rig.data.bones[f"hand.{side}"].matrix_local
    RACKET_OFFSET[side] = hand_rest.inverted() @ grip_frame(f)
place(racket, grip_frame(1))
place(strings, grip_frame(1))

print("binding body")
bind_auto(body, rig)
shirt, shorts = build_clothes(body)
for garment_ob in (shirt, shorts):
    # The shells were copied from the weighted body, so they deform with it.
    garment_ob.parent = rig
    if not any(m.type == "ARMATURE" for m in garment_ob.modifiers):
        mod = garment_ob.modifiers.new("Armature", "ARMATURE")
        mod.object = rig

# Rigid parts. Head pieces follow the head bone, and so on.
shoeR, shoeL = shoes
rigid = [(head, "head"), (eyes, "head"), (lids, "head"), (shoeR, "foot.R"), (shoeL, "foot.L"),
         (racket, "hand.R"), (strings, "hand.R"), (cap, "head"), (band, "head")]
rigid += [(o, "head") for o in face_parts + hair]
for ob, bone in rigid:
    bind_rigid(ob, rig, bone)

# Hands and wristbands deform with both the forearm and hand.
for ob in (hands, bands):
    for side, f in (("R", 1), ("L", -1)):
        vg_h = ob.vertex_groups.get(f"hand.{side}") or ob.vertex_groups.new(name=f"hand.{side}")
        vg_f = ob.vertex_groups.get(f"forearm.{side}") or ob.vertex_groups.new(name=f"forearm.{side}")
        for v in ob.data.vertices:
            if v.co.x * f <= 0:
                continue
            t = (v.co - WRIST * V(f, 1, 1)).dot(HAND_DIR * V(f, 1, 1))
            w = smoothstep(-0.02, 0.015, t)
            vg_h.add([v.index], w, "REPLACE")
            vg_f.add([v.index], 1 - w, "REPLACE")
    ob.parent = rig
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = rig

# Merge the always-visible pieces into one body mesh: fewer draw calls.
activate(body)
for ob in (head, eyes, lids, shoeR, shoeL, hands, shirt, shorts):
    ob.select_set(True)
bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = "Body"
racket = join([racket, strings], "Racket")

print("animating")
anims = {
    "Idle": (idle_keys, True),
    "Run": (run_keys, True),
    "Forehand": (forehand_keys, False),
    "Backhand": (backhand_keys, False),
    "Serve": (serve_keys, False),
    "Cheer": (cheer_keys, False),
}
ACTIONS = {}
for name, (fn, loop) in anims.items():
    keys, length = fn()
    ACTIONS[name] = bake(rig, name, keys, length, loop)
    print("  ", name, length)

# Back to rest for export.
for b in rig.pose.bones:
    b.rotation_quaternion = (1, 0, 0, 0)
    b.location = (0, 0, 0)

# Tidy for export: valid meshes, at most four bone influences per vertex.
for ob in bpy.data.objects:
    if ob.type == "MESH":
        ob.data.validate()
activate(body)
bpy.ops.object.vertex_group_limit_total(limit=4)
bpy.ops.object.vertex_group_normalize_all(lock_active=False)

counts = {o.name: len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH"}
print("FACES", sum(counts.values()), counts)

if OUT_GLB:
    os.makedirs(os.path.dirname(os.path.abspath(OUT_GLB)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB, export_format="GLB", export_animations=True,
        export_animation_mode="NLA_TRACKS", export_force_sampling=True,
        export_skins=True, export_all_influences=False, export_yup=True,
        export_apply=False, export_materials="EXPORT", export_cameras=False,
        export_lights=False, export_extras=False, export_morph=False,
        export_texcoords=True, export_normals=True,
    )
    print("exported", OUT_GLB, os.path.getsize(OUT_GLB))

if OUT_BLEND:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(OUT_BLEND))

if OUT_RENDERS:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import render_previews  # noqa: E402  (lives next to this file)
    render_previews.render_all(OUT_RENDERS, rig, ACTIONS, MATS)
