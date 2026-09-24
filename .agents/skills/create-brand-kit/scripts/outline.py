"""Outline text from any TTF (variable or static) into SVG path data with real kerning.

usage: python outline.py <font.ttf> <text> [weight] [upem_target] [tracking_em]
Emits JSON: per-glyph "d" path data plus positions, normalised so baseline=0 and y grows
DOWNWARD (SVG convention). GPOS pair kerning applied. Measure true ink extremes with
BoundsPen before setting a viewBox — font metrics lie about actual ascender/descender ink.
Requires: pip install fonttools brotli
"""
import sys, json
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

def build(font_path, text, weight=600, upem_target=1000.0, tracking_em=0.0):
    f = TTFont(font_path)
    if "fvar" in f:
        f = instancer.instantiateVariableFont(f, {"wght": weight}, inplace=False)
    upem = f["head"].unitsPerEm
    cmap = f.getBestCmap()
    gs = f.getGlyphSet()
    hmtx = f["hmtx"]

    # kern pairs from GPOS
    kern = {}
    try:
        from fontTools.ttLib.tables.otTables import PairPos
        for lookup in f["GPOS"].table.LookupList.Lookup:
            for st in lookup.SubTable:
                if getattr(st, "LookupType", None) == 2 or isinstance(st, PairPos):
                    if getattr(st, "Format", None) == 1 and hasattr(st, "PairSet"):
                        for i, first in enumerate(st.Coverage.glyphs):
                            for rec in st.PairSet[i].PairValueRecord:
                                v = getattr(rec.Value1, "XAdvance", 0) or 0
                                if v:
                                    kern[(first, rec.SecondGlyph)] = v
    except Exception:
        pass

    scale = upem_target / upem
    pen_paths = []
    x = 0.0
    advances = []
    prev = None
    for ch in text:
        g = cmap.get(ord(ch))
        if g is None:
            raise SystemExit("no glyph for " + repr(ch))
        if prev is not None:
            x += kern.get((prev, g), 0)
            x += tracking_em * upem
        spen = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}")
        # flip Y (font y-up -> svg y-down) and scale
        tp = TransformPen(spen, Transform(scale, 0, 0, -scale, x * scale, 0))
        gs[g].draw(tp)
        d = spen.getCommands()
        if d:
            pen_paths.append(d)
        adv = hmtx[g][0]
        advances.append({"char": ch, "glyph": g, "x": round(x * scale, 2), "adv": round(adv * scale, 2), "d": d})
        x += adv
        prev = g

    total_w = x * scale
    os2 = f["OS/2"]
    return {
        "d": " ".join(pen_paths),
        "width": round(total_w, 2),
        "capHeight": round(getattr(os2, "sCapHeight", 700) * scale, 2),
        "xHeight": round(getattr(os2, "sxHeight", 500) * scale, 2),
        "ascender": round(f["hhea"].ascender * scale, 2),
        "descender": round(f["hhea"].descender * scale, 2),
        "upem": upem_target,
        "glyphs": advances,
    }

if __name__ == "__main__":
    font = sys.argv[1]
    text = sys.argv[2]
    weight = float(sys.argv[3]) if len(sys.argv) > 3 else 600
    upem = float(sys.argv[4]) if len(sys.argv) > 4 else 1000
    tracking = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
    print(json.dumps(build(font, text, weight, upem, tracking)))
