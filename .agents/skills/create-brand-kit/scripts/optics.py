"""Measure a rendered mark: ink %, centroid, tight bbox, and max ink radius from bbox centre.

usage: python optics.py <file.svg> [--grid 64]

Renders via headless Chrome at high resolution on a transparent ground, then measures the
alpha channel with Pillow (pip install pillow if missing). Reports in GRID units (default 64)
so numbers map directly onto the construction module.

Why these numbers matter:
  centroid vs bbox-centre -> optical centring in square containers (blend ~0.35 toward centroid)
  maxInkRadius            -> round-safe scaling: avatar r=27/32, adaptive r=20/32
  minimum clearances      -> measure with your own geometry; designers misreport them
"""
import sys, os, json, subprocess, tempfile, math

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe" if os.name == "nt" else "google-chrome"
N = 1024

def main():
    src = os.path.abspath(sys.argv[1])
    grid = float(sys.argv[sys.argv.index("--grid") + 1]) if "--grid" in sys.argv else 64.0
    svg = open(src, encoding="utf-8").read()
    with tempfile.TemporaryDirectory() as td:
        page = os.path.join(td, "p.html")
        png = os.path.join(td, "p.png")
        open(page, "w", encoding="utf-8").write(
            f'<html><head><style>html,body{{margin:0}}svg{{width:{N}px!important;height:{N}px!important;display:block}}</style></head>'
            f'<body>{svg}</body></html>')
        subprocess.run([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
                        "--force-device-scale-factor=1", "--default-background-color=00000000",
                        f"--screenshot={png}", f"--window-size={N},{N}",
                        "file:///" + page.replace("\\", "/")],
                       check=True, capture_output=True)
        from PIL import Image
        im = Image.open(png).convert("RGBA")
        a = im.getchannel("A")
        w, h = im.size
        data = a.load()
        n = sx = sy = 0
        x0, y0, x1, y1 = w, h, -1, -1
        pts = []
        for y in range(h):
            for x in range(w):
                if data[x, y] > 32:
                    n += 1; sx += x; sy += y
                    if x < x0: x0 = x
                    if x > x1: x1 = x
                    if y < y0: y0 = y
                    if y > y1: y1 = y
        if not n:
            print(json.dumps({"error": "no ink found — is the svg visible on transparent?"})); return
        # second pass: max radius from bbox centre (sampled on edge pixels for speed)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        maxr = 0.0
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if data[x, y] > 32:
                    r = math.hypot(x - cx, y - cy)
                    if r > maxr: maxr = r
        u = grid / w
        print(json.dumps({
            "file": os.path.basename(src),
            "inkPercent": round(n / (w * h) * 100, 2),
            "centroid": {"x": round(sx / n * u, 2), "y": round(sy / n * u, 2)},
            "bbox": {"x0": round(x0 * u, 2), "y0": round(y0 * u, 2),
                     "x1": round((x1 + 1) * u, 2), "y1": round((y1 + 1) * u, 2)},
            "bboxCentre": {"x": round(cx * u, 2), "y": round(cy * u, 2)},
            "maxInkRadiusFromBboxCentre": round(maxr * u, 2),
            "roundSafeScale": {"avatar_r27": round(27 / (maxr * u), 3),
                                "adaptive_r20": round(20 / (maxr * u), 3)},
        }, indent=1))

if __name__ == "__main__":
    main()
