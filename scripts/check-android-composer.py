"""Check an open Android chat with its software keyboard visible (no messages sent).
Usage: python3 scripts/check-android-composer.py emulator-5554
"""
import re
import subprocess
import sys
import xml.etree.ElementTree as ET


def adb(*args):
    return subprocess.check_output(["adb", "-s", sys.argv[1], *args], text=True)


window = adb("shell", "dumpsys", "window")
keyboard = re.search(r"type=ime frame=\[\d+,(\d+)\]\[\d+,\d+\].*visible=true", window)
assert keyboard, "Open the software keyboard before running this check"
keyboard_top = int(keyboard[1])
adb("shell", "uiautomator", "dump", "/sdcard/moose-composer-check.xml")
root = ET.fromstring(adb("shell", "cat", "/sdcard/moose-composer-check.xml"))
for label in ("Message", "Send message"):
    nodes = [n for n in root.iter("node") if n.get("content-desc") == label]
    assert len(nodes) == 1, f"Expected one {label}"
    bounds = list(map(int, re.findall(r"\d+", nodes[0].get("bounds", ""))))
    assert len(bounds) == 4 and bounds[3] > bounds[1], f"{label} is not visible"
    assert bounds[3] <= keyboard_top, f"{label} bottom {bounds[3]} overlaps keyboard top {keyboard_top}"
    print(f"{label}: {bounds}; keyboard top: {keyboard_top}")
assert not any(n.get("content-desc") == "Settings" for n in root.iter("node")), "Tabs must hide while typing"
print("Composer and send button are above the keyboard; tabs are hidden.")
