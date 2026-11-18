"""
Preview renders of the player model: a few looks in a few poses, plus a
contact sheet. Called from build_player.py after the export.
"""

import math
import os

import bpy
from mathutils import Vector


def srgb(hex_):
    hex_ = hex_.lstrip("#")
    c = [int(hex_[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1.0]


LOOKS = [
    dict(name="default", pose=("Idle", 0.0), hair="Hair_short", face="happy", acc=None,
         colors=dict(Skin="#d9a377", Shirt="#2f7fe8", Shorts="#f4f7fa", Shoes="#f4f7fa",
                     Hair="#4a2f1d", Accent="#f4f7fa", RacketFrame="#22262e")),
    dict(name="forehand", pose=("Forehand", 0.15), hair="Hair_ponytail", face="focused", acc="Headband",
         colors=dict(Skin="#f6d3b3", Shirt="#e8503a", Shorts="#1c2230", Shoes="#f4f7fa",
                     Hair="#d8b46a", Accent="#f4f7fa", RacketFrame="#e8503a")),
    dict(name="serve", pose=("Serve", 0.14), hair=None, face="cool", acc="Cap",
         colors=dict(Skin="#b97f55", Shirt="#f0b429", Shorts="#1c2230", Shoes="#1c2230",
                     Hair="#1c1814", Accent="#1c2230", RacketFrame="#f0b429")),
    dict(name="backhand", pose=("Backhand", 0.15), hair="Hair_afro", face="angry", acc="Wristbands",
         colors=dict(Skin="#5e3b26", Shirt="#37b46b", Shorts="#f4f7fa", Shoes="#c8f24a",
                     Hair="#1c1814", Accent="#f4f7fa", RacketFrame="#2f7fe8")),
    dict(name="run", pose=("Run", 0.1), hair="Hair_spiky", face="surprised", acc=None,
         colors=dict(Skin="#e8b48f", Shirt="#e05aa8", Shorts="#24365c", Shoes="#2f7fe8",
                     Hair="#b5502b", Accent="#f4f7fa", RacketFrame="#22262e")),
    dict(name="cheer", pose=("Cheer", 0.45), hair="Hair_long", face="happy", acc=None,
         colors=dict(Skin="#d9a377", Shirt="#8b5cf6", Shorts="#f4f7fa", Shoes="#f4f7fa",
                     Hair="#1c1814", Accent="#f4f7fa", RacketFrame="#22262e")),
]

FACES = {
    "happy": ("Brows_neutral", "Mouth_grin"),
    "focused": ("Brows_focused", "Mouth_line"),
    "angry": ("Brows_angry", "Mouth_frown"),
    "surprised": ("Brows_raised", "Mouth_O"),
    "cool": ("Brows_neutral", "Mouth_smirk"),
}
VARIANTS = ("Hair_", "Brows_", "Mouth_", "Sunglasses", "Cap", "Headband", "Wristbands")


def set_color(mats, name, hex_):
    bsdf = mats[name].node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = srgb(hex_)


def apply_look(look, mats):
    brows, mouth = FACES[look["face"]]
    show = {brows, mouth}
    if look["hair"]:
        show.add(look["hair"])
    if look["acc"]:
        show.add(look["acc"])
    if look["face"] == "cool":
        show.add("Sunglasses")
    for ob in bpy.data.objects:
        if ob.type == "MESH" and ob.name.startswith(VARIANTS):
            hidden = ob.name not in show
            ob.hide_render = hidden
            ob.hide_viewport = hidden
    for k, v in look["colors"].items():
        set_color(mats, k, v)
    # Brows follow the hair, a shade darker.
    set_color(mats, "Brow", look["colors"]["Hair"] if look["hair"] else "#2a1d14")


def set_pose(rig, actions, name, t):
    ad = rig.animation_data
    for track in ad.nla_tracks:
        track.mute = True
    ad.action = actions[name]
    bpy.context.scene.frame_set(int(round(t * bpy.context.scene.render.fps)) + 1)


def setup_stage():
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 760
    scene.render.resolution_y = 1000
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    try:
        scene.eevee.use_shadows = True
        scene.eevee.taa_render_samples = 64
        scene.eevee.use_raytracing = True
    except AttributeError:
        pass

    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = srgb("#bcd3e6")
    bg.inputs["Strength"].default_value = 0.7

    # Court floor: the game's blue hard court with a white line.
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
    floor = bpy.context.active_object
    m = bpy.data.materials.new("Court")
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = srgb("#2d6fb8")
    m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.85
    floor.data.materials.append(m)
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, -0.55, 0.001))
    line = bpy.context.active_object
    line.scale = (6, 0.03, 1)
    lm = bpy.data.materials.new("Line")
    lm.use_nodes = True
    lm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = srgb("#f4f7fa")
    line.data.materials.append(lm)

    def light(kind, loc, energy, color="#ffffff", size=1.0, rot=None):
        data = bpy.data.lights.new(kind + "L", kind)
        data.energy = energy
        data.color = srgb(color)[:3]
        if kind == "AREA":
            data.size = size
        ob = bpy.data.objects.new(kind, data)
        bpy.context.scene.collection.objects.link(ob)
        ob.location = loc
        if rot:
            ob.rotation_euler = rot
        else:
            d = Vector((0, 0, 1.1)) - Vector(loc)
            ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        return ob

    light("SUN", (3, 4, 6), 3.2, "#fff4e2", rot=(math.radians(40), 0, math.radians(150)))
    light("AREA", (-3, 3, 2.5), 250, "#cfe3ff", size=3)
    light("AREA", (0, -3, 3), 350, "#ffffff", size=2)

    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 70
    cam = bpy.data.objects.new("Cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def aim_camera(cam, yaw_deg, dist=5.6, height=1.25, target=(0, 0.05, 0.98)):
    yaw = math.radians(yaw_deg)
    t = Vector(target)
    cam.location = t + Vector((math.sin(yaw) * dist, math.cos(yaw) * dist, height - t.z + 0.15))
    cam.rotation_euler = (t - cam.location).to_track_quat("-Z", "Y").to_euler()


def render_all(out_dir, rig, actions, mats):
    # Blender resolves relative render paths against the drive root, not the
    # working directory, so make it absolute first.
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    cam = setup_stage()
    scene = bpy.context.scene
    paths = []
    yaws = {"default": 28, "forehand": 40, "serve": 25, "backhand": -30, "run": 70, "cheer": 18}
    for look in LOOKS:
        apply_look(look, mats)
        set_pose(rig, actions, *look["pose"])
        target = (0, 0.05, 1.12) if look["name"] == "serve" else (0, 0.05, 0.98)
        dist = 6.4 if look["name"] == "serve" else 5.6
        aim_camera(cam, yaws[look["name"]], dist=dist, target=target)
        path = os.path.join(out_dir, f"{look['name']}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        paths.append(path)
        print("rendered", path)

    # Close-up of the face and back view for the default look.
    apply_look(LOOKS[0], mats)
    set_pose(rig, actions, "Idle", 0.0)
    aim_camera(cam, 15, dist=1.5, height=1.62, target=(0, 0.06, 1.6))
    path = os.path.join(out_dir, "face.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    paths.append(path)

    # The in-game view: behind and above, far away.
    cam.data.lens = 40
    cam.location = Vector((0.0, -9.5, 4.2))
    cam.rotation_euler = (Vector((0, 0, 0.9)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    path = os.path.join(out_dir, "ingame.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    paths.append(path)

    contact_sheet(paths[:6], os.path.join(out_dir, "sheet.png"), cols=3)


def contact_sheet(paths, out, cols=3):
    import numpy as np  # bundled with Blender

    imgs = [bpy.data.images.load(p) for p in paths]
    w, h = imgs[0].size
    rows = math.ceil(len(imgs) / cols)
    sheet = bpy.data.images.new("sheet", w * cols, h * rows)
    px = np.zeros((h * rows, w * cols, 4), dtype=np.float32)
    for i, img in enumerate(imgs):
        src = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(src)
        # Blender images are stored bottom row first.
        c, r = i % cols, rows - 1 - i // cols
        px[r * h:(r + 1) * h, c * w:(c + 1) * w] = src.reshape(h, w, 4)
    sheet.pixels.foreach_set(px.ravel())
    sheet.filepath_raw = out
    sheet.file_format = "PNG"
    sheet.save()
    print("sheet", out)
