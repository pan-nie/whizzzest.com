"""Build the original Blender scene, individual glTF models, and select-screen portraits."""

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "models"
OUT.mkdir(exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
material_cache = {}


def linear(value):
    value /= 255
    return value / 12.92 if value < 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def material(color, roughness=0.74, metal=0, emission=0):
    key = (color, roughness, metal, emission)
    if key not in material_cache:
        mat = bpy.data.materials.new(color)
        mat.use_nodes = True
        rgb = tuple(linear(int(color[i:i + 2], 16)) for i in (0, 2, 4))
        shader = mat.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = (*rgb, 1)
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Metallic"].default_value = metal
        shader.inputs["Emission Color"].default_value = (*rgb, 1)
        shader.inputs["Emission Strength"].default_value = emission
        mat.diffuse_color = (*rgb, 1)
        material_cache[key] = mat
    return material_cache[key]


def attach(obj, parent, loc):
    obj.parent = parent
    obj.location = loc
    return obj


def joint(name, loc=(0, 0, 0), parent=None):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.empty_display_size = .10
    return attach(obj, parent, loc)


def finish(color, loc, parent, smooth=False):
    obj = bpy.context.object
    attach(obj, parent, loc)
    obj.data.materials.append(color)
    if smooth:
        for face in obj.data.polygons:
            face.use_smooth = True
    return obj


def box(loc, size, color, parent, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    obj.dimensions = size
    if bevel:
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        mod = obj.modifiers.new("Soft edges", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        obj.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
    return finish(color, loc, parent)


def sphere(loc, size, color, parent):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10)
    bpy.context.object.scale = size
    return finish(color, loc, parent, True)


def segment(a, b, r0, r1, color, parent, vertices=12, squash=1):
    a, b = Vector(a), Vector(b)
    vec = b - a
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=r0, radius2=r1, depth=vec.length)
    obj = finish(color, (a + b) * .5, parent, vertices > 8)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = vec.to_track_quat("Z", "Y")
    obj.scale.y = squash
    return obj


def polygon(name, verts, color, parent, thickness=.02, faces=None):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces if faces is not None else [list(range(len(verts)))])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    attach(obj, parent, (0, 0, 0))
    mesh.materials.append(color)
    if thickness:
        mod = obj.modifiers.new("Thickness", "SOLIDIFY")
        mod.thickness = thickness
    return obj


GOLD = material("D9A855", .42, .27)
DARK_GOLD = material("795239", .55, .16)
INK = material("181721")
CREAM = material("F9DDA3")
SKIN = material("E5A57F")
LIP = material("9C3531")
STEEL = material("D5D9D9", .28, .55)
BLACK = material("271918")
LACQUER = material("632A27", .56)
WOOD = material("382121")
RUBY = material("772828")
LANTERN = material("FFC675", .62, 0, 1.8)


def make_stage():
    stage = joint("Crossroads Stage")
    box((0, .15, -.39), (13.7, 8.2, .68), WOOD, stage, .10)
    box((0, -3.92, -.27), (13.8, .28, .45), LACQUER, stage, .035)
    for i in range(23):
        plank = material(("7F5743", "755140", "825B42", "6F4B3D", "886148")[i % 5])
        for k in range(3):
            box(((k - 1) * 4.53, -3.76 + i * .304, -.045), (4.52, .299, .10), plank, stage)
    for x in range(-6, 7):
        box((x, -4.09, -.25), (.70, .025, .088), DARK_GOLD, stage, .014)
    box((0, -4.09, -.11), (13.7, .04, .034), GOLD, stage)

    wall = material("372021")
    silk = material("643338")
    panel = material("55312B")
    box((0, 3.62, 2.52), (13.1, .22, 5.12), wall, stage)
    box((0, 3.43, 1.20), (12.9, .15, .13), DARK_GOLD, stage, .018)
    box((0, 3.39, .27), (13.1, .21, .46), WOOD, stage, .032)

    for direction in (-1, 1):
        for x in (2.53, 4.77):
            xpos = x * direction
            box((xpos, 3.48, 2.7), (1.74, .14, 2.93), LACQUER, stage, .03)
            box((xpos, 3.39, 2.7), (1.54, .047, 2.76), panel, stage)
            for j in range(-3, 4):
                box((xpos + j * .235, 3.35, 2.72), (.030, .030, 2.65), DARK_GOLD, stage)
            for j in range(-4, 5):
                box((xpos, 3.34, 2.71 + j * .285), (1.48, .032, .029), DARK_GOLD, stage)
            box((xpos, 3.30, 4.31), (1.36, .13, .36), BLACK, stage, .03)
            box((xpos, 3.218, 4.31), (1.23, .038, .235), RUBY, stage, .012)
        for x in (1.50, 3.58, 5.92):
            xpos = x * direction
            segment((xpos, 3.01, .16), (xpos, 3.01, 5.15), .155, .126, LACQUER, stage, 18)
            for z in (.16, .43, 4.88, 5.12):
                segment((xpos, 3.01, z), (xpos, 3.01, z + .09), .183, .183, DARK_GOLD, stage, 16)
            box((xpos, 3.01, .11), (.46, .46, .22), WOOD, stage, .028)
        x = 5.20 * direction
        segment((x, 2.67, 4.22), (x, 2.67, 5.02), .018, .018, GOLD, stage)
        sphere((x, 2.67, 3.82), (.25, .25, .35), LANTERN, stage)
        for z in (3.51, 4.12):
            segment((x, 2.67, z), (x, 2.67, z + .055), .13, .13, LACQUER, stage)
        segment((x, 2.67, 3.30), (x, 2.67, 3.51), .044, .027, RUBY, stage)

    box((0, 3.28, 2.45), (2.72, .19, 3.29), BLACK, stage, .03)
    for i in range(28):
        x = -1.33 + i * .098
        depth = .09 * math.cos(i * 1.45)
        segment((x, 3.08 + depth, .85), (x, 3.08 + depth * .65, 4.12), .073, .064,
                material(("71393C", "723439", "8D4346")[i % 3]), stage)
    for x in (-1.28, 1.28):
        box((x, 2.97, 2.46), (.054, .042, 3.25), DARK_GOLD, stage)
    for z in (4.66, 4.91, 5.28):
        box((0, 3.15, z), (13.4, .42, .12), LACQUER if z != 4.91 else GOLD, stage, .021)
    box((0, 3.18, 4.72), (2.77, .23, .68), GOLD, stage, .030)
    box((0, 3.042, 4.72), (2.63, .064, .534), BLACK, stage, .017)

    for side in (-1, 1):
        vertices = []
        for i in range(41):
            t = i / 40
            x = side * (.14 + 6.49 * t)
            ripple = math.cos(t * math.tau * 10) * .098
            hem = 4.86 + .44 * (abs(t - .46) / .55) ** 1.56
            vertices.extend([(x, 2.67 + ripple, 5.56), (x, 2.76 + ripple, hem)])
        faces = [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(40)]
        polygon("Folded silk valance", vertices, silk, stage, .019, faces)
        for i in range(40):
            segment(vertices[2 * i + 1], vertices[2 * i + 3], .014, .014, GOLD, stage, 6)

    tx, ty = 3.43, 2.37
    box((tx, ty, .99), (1.74, .83, .14), LACQUER, stage, .035)
    box((tx, ty - .44, .75), (1.56, .085, .32), WOOD, stage, .025)
    box((tx, ty - .495, .81), (1.34, .034, .055), DARK_GOLD, stage, .01)
    for a in (-.72, .72):
        for b in (-.30, .30):
            box((tx + a, ty + b, .51), (.11, .11, .94), LACQUER, stage, .013)
    segment((tx + .43, ty, 1.06), (tx + .43, ty, 1.12), .11, .09, GOLD, stage)
    segment((tx + .43, ty, 1.12), (tx + .43, ty, 1.38), .036, .033, CREAM, stage)
    sphere((tx + .43, ty, 1.43), (.04, .034, .105), LANTERN, stage)
    for x in (-5.98, 5.98):
        box((x, -.86, .093), (.22, 3.9, .16), DARK_GOLD, stage, .024)
    return stage


def weapon(kind, hand, red):
    if kind == "gao":
        segment((0, .45, .0), (0, -1.17, .0), .045, .036, material("9A5236"), hand)
        for y in (.41, -.94, -1.13):
            segment((0, y + .042, 0), (0, y - .04, 0), .056, .056, GOLD, hand)
        polygon("Spear head", [(0, -1.52, 0), (-.10, -1.22, 0), (0, -1.08, 0), (.10, -1.22, 0)], STEEL, hand, .05)
        for k in range(5):
            segment((0, -1.08, 0), ((k - 2) * .036, -.81, -.12 - .014 * k),
                    .031, .006, red, hand, 8)
    else:
        length = .86 if kind == "ren" else .59
        segment((0, .17, 0), (0, -.16, 0), .057, .052, INK, hand)
        box((0, -.13, .0), (.21, .083, .10), GOLD, hand, .015)
        polygon("Dao blade", [(-.039, -.158, 0), (-.052, -length + .13, 0),
                (0, -length, .01), (.095, -length + .12, .04), (.071, -.15, 0)], STEEL, hand, .034)
        segment((0, .14, 0), (.048, .25, -.15), .04, .016, red, hand)


def make_actor(kind):
    name, primary, secondary, pale, height = {
        "ren": ("Ren", "285567", "1E3545", "72C0BA", 1.00),
        "liu": ("Liu", "9C4133", "5D2727", "E39A6A", .88),
        "gao": ("Gao", "B22734", "591F2B", "DCC680", 1.09),
    }[kind]
    root = joint(name)
    suit, shadow, accent = material(primary), material(secondary), material(pale)
    red = material("D24538")
    body = joint("Torso", (0, 0, 1.04), root)
    body.scale = (height, height, height)
    segment((0, 0, .01), (0, 0, .55), .295, .379, suit, body, 12, .65)
    sphere((0, 0, .43), (.36, .226, .245), suit, body)
    segment((0, 0, .12), (0, 0, .20), .324, .317, INK, body, 12, .67)
    box((0, -.22, .158), (.19, .084, .124), GOLD, body, .027)
    for side in (-1, 1):
        segment((.225 * side, -.149, .635), (.035 * side, -.238, .32), .043, .028, accent, body)
        segment((.10 * side, -.207, .09), (.157 * side, -.192, -.16), .032, .025, DARK_GOLD, body)
    box((0, -.18, -.05), (.33, .12, .30), shadow, body, .045)

    head = joint("Head", (0, 0, .82), body)
    sphere((0, 0, -.10), (.12, .12, .15), SKIN, head)
    sphere((0, 0, .11), (.232, .193, .258), INK, head)
    sphere((0, -.059, .07), (.204, .181, .230), SKIN, head)
    for side in (-1, 1):
        sphere((.196 * side, -.029, .06), (.052, .049, .073), SKIN, head)
        polygon("Painted eyebrow", [(side * x, y, z) for x, y, z in [
            (.020, -.237, .126), (.077, -.244, .157), (.163, -.196, .17),
            (.129, -.224, .130), (.041, -.250, .100)]], INK, head, .011)
        sphere((.084 * side, -.221, .090), (.050, .021, .016), INK, head)
        sphere((.082 * side, -.238, .093), (.015, .01, .009), CREAM, head)
        if kind == "gao":
            sphere((.136 * side, -.188, .050), (.063, .033, .046), red, head)
    sphere((0, -.237, .033), (.044, .048, .063), SKIN, head)
    sphere((0, -.215, -.052), (.063, .024, .017), LIP, head)
    if kind == "liu":
        polygon("Chou makeup", [(-.074, -.237, .133), (.074, -.237, .133),
                (.094, -.262, .064), (.041, -.285, -.006),
                (-.048, -.285, -.008), (-.09, -.262, .064)], CREAM, head, .009)
        sphere((0, -.29, .038), (.043, .030, .049), SKIN, head)
        segment((-.066, -.222, -.068), (.066, -.222, -.068), .018, .018, INK, head)
    if kind == "ren":
        sphere((0, .006, .248), (.249, .207, .177), shadow, head)
        segment((-.21, -.135, .244), (.21, -.131, .244), .029, .029, accent, head)
        sphere((0, -.185, .262), (.053, .028, .054), GOLD, head)
        for x in (-.17, .17):
            segment((x, .128, .23), (x * 1.55, .28, .01), .027, .009, accent, head)
    elif kind == "liu":
        sphere((0, .025, .235), (.22, .206, .135), INK, head)
        segment((-.207, -.106, .216), (.207, -.106, .216), .031, .031, red, head)
        sphere((0, .024, .342), (.071, .068, .072), red, head)
        for x in (-.12, .12):
            segment((x, .147, .225), (x * 1.8, .278, .11), .034, .012, red, head)
    else:
        sphere((0, 0, .272), (.253, .226, .188), shadow, head)
        segment((-.222, -.158, .247), (.222, -.158, .247), .044, .044, GOLD, head)
        sphere((0, -.18, .316), (.074, .041, .101), GOLD, head)
        for x in (-.18, 0, .18):
            sphere((x, -.038, .443 - .065 * (x != 0)), (.071, .067, .071), red, head)
        for side in (-1, 1):
            sphere((side * .243, -.014, .279), (.064, .065, .065), red, head)
        box((0, -.25, .487), (.06, .065, .10), GOLD, head, .022)

    for side, tag in ((-1, "L"), (1, "R")):
        x = side * .365
        arm = joint("Arm" + tag, (x, 0, .505), body)
        segment((0, 0, -.32), (0, 0, 0), .107, .137, suit, arm)
        sphere((0, 0, .005), (.157, .16, .153), accent if kind == "gao" else suit, arm)
        fore = joint("Fore" + tag, (0, 0, -.294), arm)
        segment((0, 0, -.25), (0, 0, -.03), .071, .11, shadow, fore)
        segment((0, 0, -.238), (0, 0, -.195), .086, .090, accent, fore)
        hand = joint("Hand" + tag, (0, 0, -.265), fore)
        sphere((0, -.015, 0), (.068, .076, .084), SKIN, hand)
        if tag == "R":
            weapon(kind, hand, red)
        leg = joint("Leg" + tag, (.16 * side, 0, 1.055 if kind != "liu" else .97), root)
        segment((0, 0, -.46), (0, 0, 0), .123, .156, shadow, leg, 12, .86)
        shin = joint("Shin" + tag, (0, 0, -.445), leg)
        segment((0, 0, -.42 if kind != "liu" else -.342), (0, 0, 0), .086, .113, INK, shin)
        segment((0, 0, -.10), (0, 0, -.041), .13, .135, accent, shin)
        bottom = -.47 if kind != "liu" else -.395
        box((0, -.08, bottom), (.219, .35, .21), INK, shin, .058)
        box((0, -.086, bottom - .078), (.221, .36, .061), CREAM, shin, .020)

    if kind == "gao":
        for i in range(4):
            side = -1 if i < 2 else 1
            length = 1.08 - .14 * (i % 2)
            flag = joint("Flag" + str(i), (side * (.17 + .075 * (i % 2)), .16, .48), body)
            tip = (side * (.38 + .20 * (i % 2)), .12 + .10 * (i % 2), length)
            segment((0, 0, 0), tip, .033, .019, DARK_GOLD, flag)
            a, b, c = (tip[0], tip[1], tip[2] - .03), (tip[0] * .41, tip[1] * .55, .52), (
                tip[0] + side * .51, tip[1] + .045, tip[2] - .16)
            polygon("Embroidered pennant", [a, b, c], suit, flag)
            for first, second in ((a, b), (b, c), (c, a)):
                segment(first, second, .016, .016, GOLD, flag, 8)
    return root


def export(root, filename):
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for obj in root.children_recursive:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT / filename), export_format="GLB",
                              use_selection=True, export_materials="EXPORT")


def area(name, loc, color, energy, size, target):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.color = color
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    return obj


def camera_at(name, loc, target, ortho):
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = ortho
    cam.location = loc
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    return cam


stage = make_stage()
actors = {kind: make_actor(kind) for kind in ("ren", "liu", "gao")}
# Node names are normalized in the browser only when they carry Blender's duplication suffix.
export(stage, "stage.glb")
for kind, actor in actors.items():
    export(actor, kind + ".glb")

scene.world = bpy.data.worlds.new("Theatre")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (.13, .075, .062, 1)
scene.world.node_tree.nodes["Background"].inputs[1].default_value = .30
area("Amber stage wash", (0, -4.5, 6), (1, .77, .54), 1250, 7, (0, 0, .8))
area("Cool side light", (3, -.7, 5), (.68, .83, 1), 520, 5, (0, 0, 1.2))
area("Footlight", (-3, -4, 2.4), (1, .79, .63), 260, 4, (0, 0, 1.3))

if "--portraits" in sys.argv:
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 12
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 200, 220
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = True
    for obj in stage.children_recursive:
        obj.hide_render = True
    for i, (kind, actor) in enumerate(actors.items()):
        for other in actors.values():
            for obj in other.children_recursive:
                obj.hide_render = other != actor
        actor.rotation_euler.z = math.radians(-11 if kind == "liu" else 14)
        torso = next(child for child in actor.children if child.name.startswith("Torso"))
        arm = next(child for child in torso.children if child.name.startswith("ArmR"))
        arm.rotation_euler.x = -.39
        arm.rotation_euler.y = -.16
        height = {"ren": 1.86, "liu": 1.77, "gao": 2.02}[kind]
        portrait = camera_at(kind + " portrait", (0, -6, height + .30), (0, -.03, height), 1.29)
        scene.render.filepath = str(OUT / (kind + ".png"))
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(portrait, do_unlink=True)
        arm.rotation_euler = (0, 0, 0)
    for obj in bpy.data.objects:
        obj.hide_render = False
    scene.render.film_transparent = False

for index, actor in enumerate(actors.values()):
    actor.location.x = (-2.0, 1.65, 3.95)[index]
    actor.rotation_euler.z = (math.radians(56), math.radians(-52), math.radians(-22))[index]
camera_at("Audience camera", (.6, -11.5, 6.05), (0, .4, 1.64), 12.8)
scene.render.resolution_x, scene.render.resolution_y = 1440, 936
scene.render.resolution_percentage = 100
bpy.ops.object.select_all(action="DESELECT")
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / "art" / "san-cha-kou.blend"))
