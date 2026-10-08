"""Send real X11 input: the embedded driver's JS mouse events cannot select text."""

import ctypes
import json
import sys

x11 = ctypes.CDLL("libX11.so.6")
xtest = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
xtest.XTestFakeMotionEvent.argtypes = [
    ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong,
]
xtest.XTestFakeButtonEvent.argtypes = [
    ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong,
]

display = x11.XOpenDisplay(None)
if not display:
    raise RuntimeError("Native selection tests need the app's X11 display")

try:
    event = json.loads(sys.argv[1])
    if "x" in event:
        xtest.XTestFakeMotionEvent(display, -1, round(event["x"]), round(event["y"]), 0)
    else:
        xtest.XTestFakeButtonEvent(display, 1, int(event["down"]), 0)
    x11.XSync(display, 0)
finally:
    x11.XCloseDisplay(display)
