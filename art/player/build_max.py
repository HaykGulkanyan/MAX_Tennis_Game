"""
Turns Max.glb (a static, AI-generated sculpt) into a game character with the
same animations as the default player.

    blender -b --factory-startup --python art/player/build_max.py -- \
        --src Max.glb --glb public/models/max.glb --renders art/player/renders/max

What it does:

1. Shrinks the 1.9M-triangle sculpt to a game mesh, unwraps it afresh and
   bakes the sculpt's colour and surface detail onto it, so it looks the same
   at a fraction of the size.
2. Gives it the default player's skeleton (same bone names), fitted to Max's
   child proportions.
3. Bakes the default player's animations onto that skeleton by running the
   SAME key poses and IK (build_player.py), with every position rescaled to
   Max's shorter arms and legs. Feet stay planted and both hands still meet
   on the racket.

The joint positions below were measured from Max.glb's cross-sections (in its
own units: 0.98 tall, facing -Y). A different sculpt needs new landmarks.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_player as bp  # noqa: E402  (resets the scene, defines the rig tools)

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


SRC = os.path.abspath(arg("--src", "Max.glb"))
OUT_GLB = arg("--glb")
OUT_RENDERS = arg("--renders")

HEIGHT = 1.65            # in game metres: a kid, a little shorter than the default player
SRC_HEIGHT = 0.98
K = HEIGHT / SRC_HEIGHT
TARGET_TRIS = 22000
TEX = 2048
RACKET_SCALE = 0.85      # a junior racket

V = bp.V


def P(x, y, z):
    """A landmark measured on the sculpt (facing -Y), in build space (facing +Y)."""
    return Vector((x, -y, z)) * K


# Right-side joints. The sculpt's own right is -X; turned to face +Y it is +X.
HIP = P(0.07, 0.0, 0.37)
KNEE = P(0.085, -0.005, 0.20)
ANKLE = P(0.097, 0.03, 0.07)
TOE = P(0.11, -0.075, 0.02)
SHOULDER = P(0.115, 0.01, 0.70)
ELBOW = P(0.14, 0.005, 0.595)
WRIST = P(0.146, -0.013, 0.50)
HAND_TIP = P(0.15, -0.045, 0.43)


def bones():
    out = [
        ("hips", P(0, 0, 0.38), P(0, 0, 0.47), None),
        ("spine", P(0, 0, 0.47), P(0, 0, 0.6), "hips"),
        ("chest", P(0, 0, 0.6), P(0, 0, 0.745), "spine"),
        ("neck", P(0, 0, 0.745), P(0, -0.005, 0.79), "chest"),
        ("head", P(0, -0.005, 0.79), P(0, -0.005, 0.98), "neck"),
    ]
    for s, f in (("R", 1), ("L", -1)):
        X = lambda p: Vector((p.x * f, p.y, p.z))
        out += [
            (f"shoulder.{s}", X(P(0.025, 0, 0.71)), X(SHOULDER + V(0, 0, 0.01)), "chest"),
            (f"upper_arm.{s}", X(SHOULDER), X(ELBOW), f"shoulder.{s}"),
            (f"forearm.{s}", X(ELBOW), X(WRIST), f"upper_arm.{s}"),
            (f"hand.{s}", X(WRIST), X(HAND_TIP), f"forearm.{s}"),
            (f"thigh.{s}", X(HIP), X(KNEE), "hips"),
            (f"shin.{s}", X(KNEE), X(ANKLE), f"thigh.{s}"),
            (f"foot.{s}", X(ANKLE), X(TOE), f"shin.{s}"),
        ]
    return out


# --------------------------------------------------------------------------
# Mesh: import, shrink, unwrap, bake
# --------------------------------------------------------------------------

def import_sculpt():
    bpy.ops.import_scene.gltf(filepath=SRC)
    hi = [o for o in bpy.context.scene.objects if o.type == "MESH"][0]
    hi.name = "MaxSculpt"
    # Face +Y like the rig, at game scale, standing on the ground.
    hi.matrix_world = Matrix.Rotation(math.pi, 4, "Z") @ Matrix.Diagonal((K, K, K, 1)) @ hi.matrix_world
    bp.activate(hi)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return hi


def make_low(hi):
    lo = bp.link(bpy.data.objects.new("Body", hi.data.copy()))
    # The import splits the surface at every UV seam, and decimation will not
    # collapse across a split, so weld it back into one surface first.
    bm = bmesh.new()
    bm.from_mesh(lo.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bm.to_mesh(lo.data)
    bm.free()
    tris = sum(len(p.vertices) - 2 for p in lo.data.polygons)
    d = lo.modifiers.new("decimate", "DECIMATE")
    d.ratio = TARGET_TRIS / tris
    d.use_collapse_triangulate = True
    bp.apply_modifiers(lo)
    bp.shade_smooth(lo)
    lo.data.materials.clear()
    for uv in list(lo.data.uv_layers):
        lo.data.uv_layers.remove(uv)
    lo.data.uv_layers.new(name="UVMap")
    bp.activate(lo)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.002)
    bpy.ops.object.mode_set(mode="OBJECT")
    print("  low-poly tris", sum(len(p.vertices) - 2 for p in lo.data.polygons))
    return lo


def bake_textures(hi, lo):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 4
    color = bpy.data.images.new("Max_color", TEX, TEX)
    normal = bpy.data.images.new("Max_normal", TEX, TEX, is_data=True)
    normal.colorspace_settings.name = "Non-Color"

    mat = bpy.data.materials.new("Max")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.78
    tex_c = nt.nodes.new("ShaderNodeTexImage")
    tex_c.image = color
    tex_n = nt.nodes.new("ShaderNodeTexImage")
    tex_n.image = normal
    lo.data.materials.append(mat)

    def bake(kind, node, **kw):
        nt.nodes.active = node
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        hi.select_set(True)
        lo.select_set(True)
        bpy.context.view_layer.objects.active = lo
        bpy.ops.object.bake(type=kind, use_selected_to_active=True, cage_extrusion=0.012,
                            max_ray_distance=0.04, margin=8, **kw)

    print("  baking colour")
    bake("DIFFUSE", tex_c, pass_filter={"COLOR"})
    print("  baking normals")
    bake("NORMAL", tex_n, normal_space="TANGENT")

    for img in (color, normal):
        img.pack()
    # Wire the baked maps into the material the game will load.
    nt.links.new(tex_c.outputs["Color"], bsdf.inputs["Base Color"])
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tex_n.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    scene.render.engine = "BLENDER_EEVEE"


# --------------------------------------------------------------------------
# Animation retargeting: the default player's key poses, rescaled
# --------------------------------------------------------------------------

LEG_S = (HIP.z - ANKLE.z) / (bp.HIP.z - bp.ANKLE.z)
ARM_S = ((SHOULDER - ELBOW).length + (ELBOW - WRIST).length) / (bp.UA_LEN + bp.FA_LEN)


def to_max(p):
    """Map one key pose from the default player's proportions to Max's."""
    q = dict(p)

    def leg(a):
        x, y, z = a
        side = 1 if x >= 0 else -1
        return (side * (HIP.x + (abs(x) - bp.HIP.x) * LEG_S), y * LEG_S,
                ANKLE.z + (z - bp.ANKLE.z) * LEG_S)

    def arm(a, side):
        # Relative to the shoulder on that side: Max's shoulders are about as
        # wide as the default player's, but his arms are much shorter.
        x, y, z = a
        return (side * SHOULDER.x + (x - side * bp.SH.x) * ARM_S,
                SHOULDER.y + (y - bp.SH.y) * ARM_S,
                SHOULDER.z + (z - bp.SH.z) * ARM_S)

    hx, hy, hz = p["hip"]
    q["hip"] = (hx * LEG_S, hy * LEG_S, hz * LEG_S)
    q["ankR"] = leg(p["ankR"])
    q["ankL"] = leg(p["ankL"])
    q["grip"] = clear_of_torso(arm(p["grip"], 1), 1)
    q["lhFree"] = clear_of_torso(arm(p["lhFree"], -1), -1)
    q["lhSlide"] = p["lhSlide"] * RACKET_SCALE

    # The default player rests his left hand on the racket's throat. Max's arms
    # are too short for his chest: reaching across, the left arm goes straight
    # through his body. So unless the racket is on his left (a two-handed
    # backhand), his left hand rests in front of his left hip instead.
    if q["grip"][0] > -0.02 and p["lhOn"] > 0:
        q["lhOn"] = 0.0
        q["lhFree"] = OFF_HAND_REST
        q["elbowL"] = (-0.9, -0.3, -0.6)
        # That is the ready stance. The default player holds the racket upright
        # under his chin; on Max, whose head is bigger and lower, upright covers
        # his face. Hold it out to the right and angled forward instead.
        gx, gy, gz = q["grip"]
        q["grip"] = (gx + 0.09, max(gy, 0.28), gz - 0.02)
        q["shaft"] = (0.1, 0.75, 0.65)
        q["tilt"] = 0.0
    return q


# Max's torso, as an ellipse seen from above (build space, metres), with room
# for the arm's own thickness. An arm passing through it is inside his body.
TORSO_A = 0.21
TORSO_B = 0.17
OFF_HAND_REST = (-0.25, 0.16, 0.9)


def clear_of_torso(target, side):
    """
    Push a hand target forward until the straight reach from that shoulder to
    it no longer cuts through Max's chest or belly. Only matters below
    shoulder height; overhead the arm is clear of the body anyway.
    """
    sx, sy, sz = side * SHOULDER.x, SHOULDER.y, SHOULDER.z
    x, y, z = target
    for _ in range(40):
        inside = False
        for t in (0.2, 0.35, 0.5, 0.65, 0.8, 1.0):
            px, py, pz = sx + (x - sx) * t, sy + (y - sy) * t, sz + (z - sz) * t
            if pz < sz + 0.05 and (px / TORSO_A) ** 2 + (py / TORSO_B) ** 2 < 1:
                inside = True
                break
        if not inside:
            break
        y += 0.01
    return (x, y, z)


def grip_frame(f=1):
    """Where the racket sits in Max's hand at rest (arms hanging, thumb forward)."""
    X = lambda p: Vector((p.x * f, p.y, p.z))
    wrist, tip = X(WRIST), X(HAND_TIP)
    hand_dir = (tip - wrist).normalized()
    thumb = Vector((0, 1, 0))
    palm = thumb.cross(hand_dir).normalized() * f
    shaft = (thumb * 0.93 + hand_dir * 0.36).normalized()
    x = (palm - shaft * palm.dot(shaft)).normalized()
    y = shaft.cross(x)
    m = Matrix((x, y, shaft)).transposed().to_4x4()
    m.translation = wrist + hand_dir * (tip - wrist).length * 0.55
    return m


ARM_BONES = ("upper_arm", "forearm", "hand")
TORSO_BONES = ("hips", "spine", "chest", "neck", "thigh")


def separate_arms(lo):
    """
    Max stands with his arms resting against his sides, so automatic weights
    glue shirt to arm and arm to shirt: lifting an arm drags a chunk of torso
    with it. Untangle them by surface direction: near an arm, a surface facing
    AWAY from the arm's axis is the arm itself, and one facing TOWARD it is
    the torso (or hip) the arm was resting on. Each then keeps only its own
    bones. The shoulder joint keeps its blended weights, so it still bends.
    """
    groups = {g.index: g.name for g in lo.vertex_groups}
    by_name = {g.name: g for g in lo.vertex_groups}
    moved = 0
    for f, s in ((1, "R"), (-1, "L")):
        X = lambda p: Vector((p.x * f, p.y, p.z))
        chain = [(X(SHOULDER), X(ELBOW), "upper_arm", 0.05 * K),
                 (X(ELBOW), X(WRIST), "forearm", 0.036 * K),
                 (X(WRIST), X(HAND_TIP) + (X(HAND_TIP) - X(WRIST)) * 0.3, "hand", 0.036 * K)]
        for v in lo.data.vertices:
            if v.co.x * f <= 0:
                continue
            best = None
            for a, b, bone, radius in chain:
                ab = b - a
                t = max(0.0, min(1.0, (v.co - a).dot(ab) / ab.length_squared))
                r = v.co - (a + ab * t)
                if best is None or r.length < best[0].length:
                    best = (r, bone, t, radius)
            r, bone, t, radius = best
            # Hands hang clear of the body, and curled fingers face every
            # way, so they keep the automatic weights.
            if r.length > radius or bone == "hand" or (bone == "upper_arm" and t < 0.3):
                continue
            # Deep inside the arm's radius is always arm (fingers, wrist). Only
            # the outer band, where arm and body touch, is decided by facing.
            is_arm = r.length < radius * 0.6 or v.normal.dot(r) > 0
            for g in list(v.groups):
                name = groups[g.group]
                arm_bone = name.startswith(ARM_BONES) and name.endswith(s)
                torso_bone = name.startswith(TORSO_BONES)
                if (is_arm and torso_bone) or (not is_arm and arm_bone):
                    lo.vertex_groups[g.group].remove([v.index])
                    moved += 1
            # Never leave a vertex with no bone at all: it would stay frozen at
            # its rest position and stretch into a spike when the body moves.
            if not any(g.weight > 1e-4 for g in v.groups):
                if is_arm:
                    by_name[f"{bone}.{s}"].add([v.index], 1.0, "REPLACE")
                else:
                    by_name[nearest_torso_bone(v.co)].add([v.index], 1.0, "REPLACE")
    print("  untangled arm weights", moved)


def smooth_weights(lo, iterations=4, factor=0.5):
    """
    Soften hard weight edges, so a loose sleeve stretches instead of tearing
    when an arm goes overhead: each vertex's weights are blended with its
    neighbours' a few times, then renormalised.
    """
    import numpy as np

    me = lo.data
    n, g = len(me.vertices), len(lo.vertex_groups)
    W = np.zeros((n, g), dtype=np.float32)
    for v in me.vertices:
        for e in v.groups:
            W[v.index, e.group] = e.weight
    edges = np.empty(len(me.edges) * 2, dtype=np.int32)
    me.edges.foreach_get("vertices", edges)
    a, b = edges[0::2], edges[1::2]
    degree = np.bincount(np.concatenate([a, b]), minlength=n).astype(np.float32)[:, None]
    degree[degree == 0] = 1
    for _ in range(iterations):
        S = np.zeros_like(W)
        np.add.at(S, a, W[b])
        np.add.at(S, b, W[a])
        W = (1 - factor) * W + factor * S / degree
    W[W < 0.01] = 0
    W /= np.maximum(W.sum(axis=1, keepdims=True), 1e-6)
    for gi, group in enumerate(lo.vertex_groups):
        col = W[:, gi]
        group.remove(range(n))
        for vi in np.nonzero(col)[0]:
            group.add([int(vi)], float(col[vi]), "REPLACE")


def nearest_torso_bone(p):
    """The torso bone a body vertex beside the arm should follow."""
    if p.z < P(0, 0, 0.47).z:
        return "hips"
    return "spine" if p.z < P(0, 0, 0.6).z else "chest"


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

def main():
    print("importing", SRC)
    hi = import_sculpt()
    lo = make_low(hi)
    bake_textures(hi, lo)
    bpy.data.objects.remove(hi, do_unlink=True)
    bpy.context.view_layer.update()

    bp.BONES = bones()
    rig = bp.build_armature()

    racket, strings = bp.build_racket()
    for ob in (racket, strings):
        ob.data.transform(Matrix.Diagonal((RACKET_SCALE,) * 3 + (1,)))
        ob.data.transform(grip_frame(1))
    for side, f in (("R", 1), ("L", -1)):
        hand_rest = rig.data.bones[f"hand.{side}"].matrix_local
        bp.RACKET_OFFSET[side] = hand_rest.inverted() @ grip_frame(f)

    print("binding")
    bp.bind_auto(lo, rig)
    separate_arms(lo)
    smooth_weights(lo)
    for ob in (racket, strings):
        bp.bind_rigid(ob, rig, "hand.R")
    racket = bp.join([racket, strings], "Racket")

    print("animating", f"legs x{LEG_S:.2f} arms x{ARM_S:.2f}")
    actions = {}
    for name, (fn, loop) in bp.ANIMS.items():
        keys, length = fn()
        keys = keep_face_clear(name, [(t, to_max(p)) for t, p in keys])
        actions[name] = bp.bake(rig, name, keys, length, loop)
    report_racket_over_face(rig, actions)

    for b in rig.pose.bones:
        b.rotation_quaternion = (1, 0, 0, 0)
        b.location = (0, 0, 0)
    lo.data.validate()
    bp.activate(lo)
    bpy.ops.object.vertex_group_limit_total(limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)

    if OUT_GLB:
        out = os.path.abspath(OUT_GLB)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        bpy.ops.export_scene.gltf(
            filepath=out, export_format="GLB", export_animations=True,
            export_animation_mode="NLA_TRACKS", export_force_sampling=True,
            export_skins=True, export_all_influences=False, export_yup=True,
            export_apply=False, export_materials="EXPORT", export_cameras=False,
            export_lights=False, export_extras=False, export_morph=False,
            export_texcoords=True, export_normals=True,
            export_image_format="JPEG", export_image_quality=88,
            export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
            export_draco_position_quantization=16, export_draco_normal_quantization=10,
            export_draco_texcoord_quantization=12,
        )
        print("exported", out, os.path.getsize(out))

    if OUT_RENDERS:
        import render_previews as rp
        out_dir = os.path.abspath(OUT_RENDERS)
        os.makedirs(out_dir, exist_ok=True)
        cam = rp.setup_stage()
        scene = bpy.context.scene
        paths = []
        shots = [("idle", "Idle", 0.0, 20), ("forehand", "Forehand", 0.15, 40), ("serve", "Serve", 0.14, 25),
                 ("backhand", "Backhand", 0.15, -30), ("run", "Run", 0.1, 70), ("cheer", "Cheer", 0.45, 18)]
        for name, action, t, yaw in shots:
            rp.set_pose(rig, actions, action, t)
            target = (0, 0.05, 1.0) if action == "Serve" else (0, 0.05, 0.85)
            rp.aim_camera(cam, yaw, dist=5.4 if action == "Serve" else 4.8, height=1.15, target=target)
            path = os.path.join(out_dir, f"{name}.png")
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            paths.append(path)
        rp.set_pose(rig, actions, "Idle", 0.0)
        rp.aim_camera(cam, 10, dist=1.4, height=1.42, target=(0, 0.05, 1.42))
        path = os.path.join(out_dir, "face.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        rp.contact_sheet(paths, os.path.join(out_dir, "sheet.png"), cols=3)

        if "--qa" in argv:
            qa_sheet(rig, actions, out_dir, cam)


def keep_face_clear(name, keys):
    """
    Max-only changes to the swings, so the racket never sweeps across his face.

    The default player twists his whole body round to finish a swing, which
    with Max's big, low head turns his face straight into the racket; and on
    the way back to the ready stance the racket passes right in front of it.
    So Max twists half as far, finishes with the racket out over his shoulder,
    and brings it back low, at waist height. The serve comes down his right
    side instead of across his face. `report_racket_over_face` checks the
    result frame by frame.
    """
    def finish(p, grip, shaft):
        q = dict(p)
        for k in ("hipr", "spine", "chest"):
            x, y, z = q[k]
            q[k] = (x, y, z * 0.5)
        q["grip"], q["shaft"], q["tilt"] = grip, shaft, 0.0
        return q

    def recover(ready, grip, shaft):
        q = dict(ready)
        q["grip"], q["shaft"], q["tilt"] = grip, shaft, 0.0
        return q

    def through(p, grip, shaft):
        """The swing-through after contact: low, across the waist."""
        q = dict(p)
        q["grip"], q["shaft"], q["tilt"] = grip, shaft, 0.0
        return q

    out = list(keys)
    ready = keys[-1][1]
    contact = keys[2][1]
    if name == "Forehand":
        out = [(t, finish(p, (-0.3, -0.04, 1.08), (-0.7, -0.55, 0.45)) if t >= 0.3 and t < 0.8 else p)
               for t, p in keys]
        out.insert(3, (0.23, through(contact, (0.05, 0.3, 0.95), (-0.6, 0.6, 0.1))))
        out.insert(-1, (0.67, recover(ready, (-0.1, 0.3, 0.82), (-0.45, 0.8, -0.25))))
    elif name == "Backhand":
        out = [(t, finish(p, (0.34, -0.04, 1.08), (0.7, -0.55, 0.45)) if t >= 0.3 and t < 0.8 else p)
               for t, p in keys]
        out.insert(3, (0.23, through(contact, (0.0, 0.3, 0.95), (0.6, 0.6, 0.1))))
        out.insert(-1, (0.67, recover(ready, (0.32, 0.26, 0.82), (0.35, 0.85, -0.25))))
    elif name == "Serve":
        # Loop the racket up BEHIND his head: blending straight from hanging
        # down his back to pointing up swings it through the front instead.
        loop = dict(keys[0][1])
        loop["grip"], loop["shaft"], loop["tilt"] = (0.28, -0.06, 1.42), (0.15, -0.9, 0.35), 0.0
        down = dict(keys[1][1])
        down["grip"], down["shaft"], down["tilt"] = (0.36, 0.18, 1.12), (0.45, 0.55, -0.65), 0.0
        out = [keys[0], (0.07, loop), keys[1], (0.25, down)] + keys[2:]
    elif name == "Cheer":
        # Pump the fist out by his side, not up beside his cheek.
        for t, p in out:
            x, y, z = p["lhFree"]
            if z > 1.1:
                p["lhFree"] = (x - 0.12, y - 0.08, z)
    return out


def report_racket_over_face(rig, actions):
    """
    Check every frame of every animation for the racket head passing in front
    of Max's face, and print the frames where it does. His head is big and
    low, so swings that clear the default player's face can cover his.
    """
    ad = rig.animation_data
    for track in ad.nla_tracks:
        track.mute = True
    scene = bpy.context.scene
    head_center = Vector((0, 0, (bp.SHAFT_TO_HEAD + bp.RACKET_HEAD_LEN) * RACKET_SCALE))
    bad = []
    for name, action in actions.items():
        ad.action = action
        start, end = (int(x) for x in action.frame_range)
        for f in range(start, end + 1):
            scene.frame_set(f)
            pb = rig.pose.bones
            racket = (pb["hand.R"].matrix @ bp.RACKET_OFFSET["R"]) @ head_center
            head = pb["head"]
            face = head.head.lerp(head.tail, 0.4)
            forward = (head.matrix.to_3x3() @ head.bone.matrix_local.to_3x3().inverted()) @ Vector((0, 1, 0))
            # Anywhere in the column in front of his face covers it from the
            # camera, however far out: test the sideways/vertical offset.
            d = racket - face
            ahead = d.dot(forward)
            across = (d - forward * ahead).length
            if -0.02 < ahead < 0.9 and across < 0.2:
                bad.append(f"{name}@{f}")
    ad.action = None
    for track in ad.nla_tracks:
        track.mute = False
    print("RACKET OVER FACE:", ", ".join(bad) if bad else "none")


def qa_sheet(rig, actions, out_dir, cam):
    """
    Every animation at five moments, from his left-front and from the front:
    the views where an arm going through the body shows up. Written to
    qa_left.png and qa_front.png; not committed, just for checking a build.
    """
    import render_previews as rp
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = 300, 400
    for view, yaw in (("left", -40), ("front", 0)):
        paths = []
        for name, action in actions.items():
            length = action.frame_range[1] / bp.FPS
            for i in range(5):
                rp.set_pose(rig, actions, name, length * i / 5)
                rp.aim_camera(cam, yaw, dist=5.2, height=1.1, target=(0, 0.05, 0.95))
                path = os.path.join(out_dir, f"qa_{view}_{name}_{i}.png")
                scene.render.filepath = path
                bpy.ops.render.render(write_still=True)
                paths.append(path)
        rp.contact_sheet(paths, os.path.join(out_dir, f"qa_{view}.png"), cols=5)
        for p in paths:
            os.remove(p)


main()
