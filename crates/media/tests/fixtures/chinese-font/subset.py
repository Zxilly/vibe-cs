"""Regenerate the test fixture with fonttools==4.60.1 and the pinned source TTF."""
import hashlib
from pathlib import Path
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

source = Path(sys.argv[1])
font = TTFont(source, recalcTimestamp=False)
options = subset.Options()
options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
options.name_legacy = True
options.name_languages = [0x409]
subsetter = subset.Subsetter(options=options)
subsetter.populate(text="中文高光 · NiKo")
subsetter.subset(font)
font = instantiateVariableFont(font, {"wght": 400}, inplace=True)
for record in font["name"].names:
    if record.nameID in (1, 3, 4, 6, 16):
        record.string = "VibeCSTestChinese".encode(record.getEncoding())
output = Path(__file__).with_name("VibeCSTestChinese.ttf")
font.save(output)
print(f"source sha256: {hashlib.sha256(source.read_bytes()).hexdigest()}")
print(f"fixture sha256: {hashlib.sha256(output.read_bytes()).hexdigest()}")
print(f"fixture bytes: {output.stat().st_size}")
assert set(map(ord, "中文高光 · NiKo")) <= font.getBestCmap().keys()
