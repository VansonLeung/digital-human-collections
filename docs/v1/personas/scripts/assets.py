#!/usr/bin/env python3
"""Fetch pinned persona assets or verify and inspect the local collection (stdlib only)."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import struct
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def local_path(relative):
    target = (ROOT / relative).resolve()
    if not target.is_relative_to(ROOT):
        raise ValueError(f"Path escapes collection: {relative}")
    return target


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fetch(item):
    target = local_path(item["path"])
    if target.exists():
        data = target.read_bytes()
    else:
        request = urllib.request.Request(item["url"], headers={"User-Agent": "digital-human-personas/1"})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read(64 * 1024 * 1024 + 1)
        if len(data) > 64 * 1024 * 1024:
            raise ValueError(f"Asset exceeds 64 MiB: {item['path']}")
    if len(data) != item["bytes"] or digest(data) != item["sha256"]:
        raise ValueError(f"Checksum/size mismatch: {item['path']}; existing files are preserved")
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + ".partial")
        partial.write_bytes(data)
        partial.replace(target)
    return item["path"]


def inspect_glb(path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", data)
    if magic != b"glTF" or version != 2 or length != len(data):
        raise ValueError(f"Invalid GLB header: {path}")
    size, kind = struct.unpack_from("<I4s", data, 12)
    if kind != b"JSON":
        raise ValueError(f"Missing GLB JSON chunk: {path}")
    document = json.loads(data[20:20 + size])
    offset = 12
    while offset < length:
        chunk_size, _ = struct.unpack_from("<I4s", data, offset)
        offset += 8 + chunk_size
    if offset != length:
        raise ValueError(f"Invalid GLB chunk lengths: {path}")
    external = [entry["uri"] for field in ("buffers", "images")
                for entry in document.get(field, [])
                if "uri" in entry and not entry["uri"].startswith("data:")]
    if external:
        raise ValueError(f"GLB requires external resources: {external}")
    meshes = []
    triangles = 0
    for mesh in document.get("meshes", []):
        target_count = max((len(p.get("targets", [])) for p in mesh["primitives"]), default=0)
        if target_count:
            meshes.append({"name": mesh.get("name"), "target_count": target_count,
                           "target_names": mesh.get("extras", {}).get("targetNames", [])})
        for primitive in mesh["primitives"]:
            if primitive.get("mode", 4) == 4:
                accessor = primitive.get("indices", primitive["attributes"]["POSITION"])
                triangles += document["accessors"][accessor]["count"] // 3
    vrm = document.get("extensions", {}).get("VRMC_vrm", {})
    presets = vrm.get("expressions", {}).get("preset", {})
    return {"format": "VRM 1.0" if vrm else "GLB 2.0", "bytes": length,
            "triangles_all_mesh_primitives": triangles,
            "mesh_count": len(document.get("meshes", [])),
            "skin_count": len(document.get("skins", [])),
            "material_count": len(document.get("materials", [])),
            "image_count": len(document.get("images", [])),
            "extensions_required": document.get("extensionsRequired", []),
            "morph_meshes": meshes, "vrm_meta": vrm.get("meta"),
            "vrm_expression_presets": presets,
            "vrm_custom_expressions": vrm.get("expressions", {}).get("custom", {})}


def inspect_live2d(path):
    model = json.loads(path.read_text())
    refs = model["FileReferences"]
    dependencies = [refs["Moc"], *refs.get("Textures", [])]
    dependencies += [refs[k] for k in ("Physics", "Pose", "DisplayInfo", "UserData") if refs.get(k)]
    dependencies += [e["File"] for e in refs.get("Expressions", [])]
    for motions in refs.get("Motions", {}).values():
        for motion in motions:
            dependencies.append(motion["File"])
            if motion.get("Sound"):
                dependencies.append(motion["Sound"])
    for dependency in dependencies:
        resolved = (path.parent / dependency).resolve()
        if not resolved.is_relative_to(path.parent.resolve()) or not resolved.is_file():
            raise ValueError(f"Missing/unsafe Live2D resource: {dependency}")
    moc = path.parent / refs["Moc"]
    if moc.read_bytes()[:4] != b"MOC3":
        raise ValueError(f"Invalid MOC3 header: {moc}")
    info_path = path.parent / refs.get("DisplayInfo", "")
    info = json.loads(info_path.read_text()) if info_path.is_file() else {}
    return {"format": "Live2D Cubism runtime", "dependencies_checked": len(dependencies),
            "texture_count": len(refs.get("Textures", [])),
            "motion_count": sum(len(v) for v in refs.get("Motions", {}).values()),
            "motion_files_present": len(list((path.parent / "motions").glob("*.motion3.json"))),
            "expression_count": len(refs.get("Expressions", [])),
            "parameter_ids": [p["Id"] for p in info.get("Parameters", [])],
            "groups": model.get("Groups", []),
            "note": "Cubism Core execution and visual lip-sync have not been tested."}


def verify(manifest):
    for item in manifest["files"]:
        data = local_path(item["path"]).read_bytes()
        if len(data) != item["bytes"] or digest(data) != item["sha256"]:
            raise ValueError(f"Checksum/size mismatch: {item['path']}")
    report = {"research_date": manifest["research_date"],
              "files_verified": len(manifest["files"]),
              "downloaded_bytes": sum(i["bytes"] for i in manifest["files"]),
              "scope": "Checksums, container structure and declared resources; no rendered performance or speech-quality claim.",
              "models": {}}
    for model in manifest["models"]:
        path = local_path(model["entrypoint"])
        report["models"][model["id"]] = inspect_live2d(path) if path.name.endswith(".model3.json") else inspect_glb(path)
    (ROOT / "inspection.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(f"Verified {report['files_verified']} files ({report['downloaded_bytes'] / 1048576:.2f} MiB), {len(report['models'])} models. See inspection.json.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("fetch", "verify"))
    args = parser.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text())
    if args.action == "fetch":
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for path in pool.map(fetch, manifest["files"]):
                print(path)
    verify(manifest)


if __name__ == "__main__":
    main()
