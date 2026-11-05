"""Build the research-18 Qwen-Image-Edit 2511 graph for one or more edits, enqueue it, wait, fetch.

usage: [EDIT_SIZE=768] edit.py <spec.json>   spec: {name, image (in ComfyUI input), items: [{prefix, prompt, seed}]}
Writes workflows/<name>.json (API format) and poses/<prefix>_00001_.png.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HOST = "http://127.0.0.1:8000"
SIZE = int(os.environ.get("EDIT_SIZE", "0"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def graph(image, items):
    g = {
        "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": "qwen-image-edit-2511-Q6_K.gguf"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["2", 0], "shift": 3.1}},
        "4": {"class_type": "CFGNorm", "inputs": {"model": ["3", 0], "strength": 1.0}},
        "5": {"class_type": "CLIPLoaderGGUF", "inputs": {"clip_name": "Qwen2.5-VL-7B-Instruct-Q8_0.gguf", "type": "qwen_image"}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "7": {"class_type": "LoadImage", "inputs": {"image": image}},
        "8": ({"class_type": "ImageScale", "inputs": {"image": ["7", 0], "upscale_method": "lanczos", "width": SIZE, "height": SIZE, "crop": "disabled"}} if SIZE else {"class_type": "FluxKontextImageScale", "inputs": {"image": ["7", 0]}}),
        "9": {"class_type": "VAEEncode", "inputs": {"pixels": ["8", 0], "vae": ["6", 0]}},
    }
    for i, (prefix, prompt, seed) in enumerate(items):
        b = 20 + i * 10
        g[str(b)] = {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["5", 0], "prompt": prompt, "vae": ["6", 0], "image1": ["8", 0]}}
        g[str(b + 1)] = {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": [str(b), 0]}}
        g[str(b + 2)] = {"class_type": "KSampler", "inputs": {"model": ["4", 0], "positive": [str(b), 0], "negative": [str(b + 1), 0], "latent_image": ["9", 0], "seed": seed, "steps": 4, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}}
        g[str(b + 3)] = {"class_type": "VAEDecode", "inputs": {"samples": [str(b + 2), 0], "vae": ["6", 0]}}
        g[str(b + 4)] = {"class_type": "SaveImage", "inputs": {"images": [str(b + 3), 0], "filename_prefix": f"mascot/{prefix}"}}
    return g


def run(name, image, items):
    g = graph(image, items)
    json.dump(g, open(f"{ROOT}/workflows/{name}.json", "w"), indent=2)
    req = urllib.request.Request(f"{HOST}/prompt", data=json.dumps({"prompt": g}).encode(), headers={"Content-Type": "application/json"})
    pid = json.load(urllib.request.urlopen(req))["prompt_id"]
    t0 = time.time()
    while True:
        h = json.load(urllib.request.urlopen(f"{HOST}/history/{pid}"))
        if pid in h:
            break
        time.sleep(3)
    h = h[pid]
    status = h.get("status", {})
    if status.get("status_str") != "success":
        print(json.dumps(status)[:2000])
        sys.exit(1)
    out = []
    os.makedirs(f"{ROOT}/poses", exist_ok=True)
    for node, o in h["outputs"].items():
        for im in o.get("images", []):
            q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im["subfolder"], "type": im["type"]})
            data = urllib.request.urlopen(f"{HOST}/view?{q}").read()
            dest = f"{ROOT}/poses/{im['filename']}"
            open(dest, "wb").write(data)
            out.append(dest)
    print(f"{name}: {time.time() - t0:.0f}s ->", *out, sep="\n  ")


if __name__ == "__main__":
    spec = json.load(open(sys.argv[1]))
    run(spec["name"], spec["image"], [(i["prefix"], i["prompt"], i["seed"]) for i in spec["items"]])
