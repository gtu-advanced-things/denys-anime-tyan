"""Blender background export. Pass Amber.Fbx and the output GLB after --."""
import subprocess
import sys
import tempfile
from pathlib import Path

import bpy

source, target = map(Path, sys.argv[sys.argv.index("--") + 1:])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=str(source), use_anim=False)
morphs = {
    "V_Open": "jawOpen", "V_Tight_O": "mouthFunnel",
    "Eye_Blink_L": "eyeBlinkLeft", "Eye_Blink_R": "eyeBlinkRight",
    "Mouth_Up_Upper_L": "mouthUpperUpLeft", "Mouth_Up_Upper_R": "mouthUpperUpRight",
    "Eye_L_Look_R": "eyeLookInLeft", "Eye_L_Look_L": "eyeLookOutLeft",
    "Eye_R_Look_L": "eyeLookInRight", "Eye_R_Look_R": "eyeLookOutRight",
}
for obj in list(bpy.context.scene.objects):
    if obj.name in {"CC_Base_TearLine", "CC_Base_EyeOcclusion"}:
        bpy.data.objects.remove(obj, do_unlink=True)
    elif obj.type == "MESH" and obj.data.shape_keys:
        for key in list(obj.data.shape_keys.key_blocks)[1:]:
            if key.name in morphs:
                key.name = morphs[key.name]
            else:
                obj.shape_key_remove(key)

with tempfile.TemporaryDirectory() as scratch:
    folder = Path(scratch)
    for mat in bpy.data.materials:
        tree = mat.node_tree
        if not tree:
            continue
        images = [n.image for n in tree.nodes if n.type == "TEX_IMAGE" and n.image]
        diffuse = next((i for i in images if "_Diffuse" in i.name), None)
        if not diffuse:
            continue
        color = folder / "color"
        color.write_bytes(diffuse.packed_file.data)
        alpha = next((i for i in images if "_Opacity" in i.name), None)
        if mat.name.startswith("Female_Brow_Base"):
            alpha = bpy.data.images.get("Female_Brow_Base_Transparency_Opacity")
        transparent = "Transparency" in mat.name or mat.name == "Std_Eyelash"
        args = ["magick", str(color), "-thumbnail", "1024x1024>"]
        if alpha and transparent:
            mask = folder / "mask"
            mask.write_bytes(alpha.packed_file.data)
            args += ["(", str(mask), "-thumbnail", "1024x1024>", "-alpha", "off", ")", "-compose", "CopyOpacity", "-composite"]
        path = folder / (mat.name + (".png" if transparent else ".jpg"))
        subprocess.run(args + ["-quality", "85", str(path)], check=True)
        tree.nodes.clear()
        texture = tree.nodes.new("ShaderNodeTexImage")
        texture.image = bpy.data.images.load(str(path))
        shader = tree.nodes.new("ShaderNodeBsdfPrincipled")
        shader.inputs["Roughness"].default_value = 0.78
        tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
        if transparent:
            tree.links.new(texture.outputs["Alpha"], shader.inputs["Alpha"])
            mat.surface_render_method = "DITHERED"
        tree.links.new(shader.outputs[0], tree.nodes.new("ShaderNodeOutputMaterial").inputs["Surface"])
    bpy.ops.export_scene.gltf(filepath=str(target), export_animations=False, export_morph_normal=False)
