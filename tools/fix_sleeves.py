"""Keep the suit cuffs on the forearms when exporting Office-Studio."""
import json
import struct
import sys
from pathlib import Path


def fix_sleeves(path):
    data = bytearray(path.read_bytes())
    size = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + size])
    binary = 28 + size

    def layout(index):
        accessor = doc["accessors"][index]
        view = doc["bufferViews"][accessor["bufferView"]]
        fmt = "<4" + {5121: "B", 5123: "H", 5126: "f"}[accessor["componentType"]]
        start = binary + view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        return start, view.get("byteStride", struct.calcsize(fmt)), fmt, accessor["count"]

    suit = next(node for node in doc["nodes"] if node["name"] == "Outfit_original")
    names = [doc["nodes"][i]["name"] for i in doc["skins"][suit["skin"]]["joints"]]
    remap = {i: names.index(name.split("Hand")[0] + "ForeArm")
             for i, name in enumerate(names) if "Hand" in name}
    for primitive in doc["meshes"][suit["mesh"]]["primitives"]:
        attr = primitive["attributes"]
        start, stride, fmt, count = layout(attr["JOINTS_0"])
        ws, step, wf, _ = layout(attr["WEIGHTS_0"])
        for i in range(count):
            offset = start + i * stride
            joints = struct.unpack_from(fmt, data, offset)
            weights = struct.unpack_from(wf, data, ws + i * step)
            if any(j in remap and w for j, w in zip(joints, weights)):
                merged = {}
                for joint, weight in zip(joints, weights):
                    joint = remap.get(joint, joint)
                    merged[joint] = merged.get(joint, 0) + weight
                pairs = sorted(merged.items(), key=lambda pair: -pair[1])
                pairs += [(0, 0)] * (4 - len(pairs))
                struct.pack_into(fmt, data, offset, *(j for j, _ in pairs))
                struct.pack_into(wf, data, ws + i * step, *(w for _, w in pairs))
    path.write_bytes(data)


if __name__ == "__main__":
    fix_sleeves(Path(sys.argv[1]))
