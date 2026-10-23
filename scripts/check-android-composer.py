"""Check an open Android chat without sending messages.
Usage: python3 scripts/check-android-composer.py emulator-5554 [--closed] [--empty]
"""
import re
import subprocess
import sys
import xml.etree.ElementTree as ET


def adb(*args):
    return subprocess.check_output(["adb", "-s", sys.argv[1], *args], text=True)


closed = "--closed" in sys.argv
window = adb("shell", "dumpsys", "window")
keyboard = re.search(r"type=ime frame=\[\d+,(\d+)\]\[\d+,\d+\].*visible=true", window)
assert bool(keyboard) != closed, "Keyboard visibility does not match the requested check"
adb("shell", "uiautomator", "dump", "/sdcard/moose-composer-check.xml")
root = ET.fromstring(adb("shell", "cat", "/sdcard/moose-composer-check.xml"))


def bounds(label):
    nodes = [n for n in root.iter("node") if n.get("content-desc") == label]
    assert len(nodes) == 1, f"Expected one {label}"
    value = list(map(int, re.findall(r"\d+", nodes[0].get("bounds", ""))))
    assert len(value) == 4 and value[3] > value[1], f"{label} is not visible"
    return value


density = int(re.findall(r"\d+", adb("shell", "wm", "density"))[-1]) / 160
send = bounds("Send message")
draft = bounds("Message")
assert send[3] - send[1] >= 44 * density - 2, f"Send is clipped: {send}"
if "--empty" in sys.argv:
    assert max(send[3], draft[3]) - min(send[1], draft[1]) <= 64 * density, "Empty composer should fit one compact row"
limit = bounds("Chat")[1] if closed else int(keyboard[1])
for label, value in (("Message", draft), ("Send message", send)):
    assert value[3] <= limit, f"{label} bottom {value[3]} overlaps lower boundary {limit}"
    print(f"{label}: {value}; lower boundary: {limit}")
if not closed:
    assert not any(n.get("content-desc") == "Settings" for n in root.iter("node")), "Tabs must hide while typing"
print("Draft and full 44-point Send target are visible above tabs/keyboard.")
