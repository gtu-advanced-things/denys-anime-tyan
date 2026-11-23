"""Export the portrait camera, idle rig, and facial morphs as a browser-ready GLB."""
import sys
from pathlib import Path

import bpy

target = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
scene = bpy.context.scene
bpy.ops.object.select_all(action="DESELECT")
for obj in scene.objects:
    if obj.type in {"MESH", "ARMATURE", "CAMERA"} and not obj.hide_render:
        obj.select_set(True)

bpy.ops.export_scene.gltf(
    filepath=str(target),
    use_selection=True,
    export_format="GLB",
    export_cameras=True,
    export_animations=True,
    export_animation_mode="ACTIVE_ACTIONS",
    export_morph=True,
    export_yup=True,
)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fix_sleeves import fix_sleeves
fix_sleeves(target)
