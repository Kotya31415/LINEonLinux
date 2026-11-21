# line-window-fix.py — adapted from xullul/line-linux lib/hide-shadows.py (MIT).
# Hides LINE's shadow windows under Wine/X11. See README.md for credits.
"""Make LINE's drop-shadow windows invisible while LINE runs under Wine.

LINE draws the shadow around each of its windows with eight thin, untitled
ARGB popup windows. Wine maps most of them as override-redirect X windows,
which GNOME keeps above every normal window, and some as separate dialogs, so
after switching apps the shadows stay on screen as a dark or transparent
frame over the other app. The same windows are LINE's resize handles: LINE
shows the resize cursor over them and resizes the window when they are
dragged.

A shadow window is recognized by where it is: an untitled 32-bit LINE window,
at most MAX_THICKNESS thick, lying along the outside edge of a titled LINE
window without overlapping it. Tooltips and menus don't match. This watcher
sets each one's opacity to 0, so it is never drawn. While its LINE window is
the active window, a shadow keeps its normal shape so it can be dragged to
resize. Otherwise it gets an empty X shape, so clicks pass through to
whatever app is underneath. The watcher re-applies this when the active
window changes or Wine changes the opacity or shape. The windows still exist,
so Wine and LINE are unaffected.

  python3 hide-shadows.py          watch until LINE exits
  python3 hide-shadows.py --once   hide current shadows and exit
"""
import ctypes
import ctypes.util
import fcntl
import os
import select
import sys
import time

MAX_THICKNESS = 40          # main windows use 11 px shadows, dialogs 20 px
MAX_FRAME_DEPTH = 3         # levels below the root to look for reparented windows

x = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
xext = ctypes.CDLL(ctypes.util.find_library("Xext") or "libXext.so.6")

Display = ctypes.c_void_p
Window = ctypes.c_ulong


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int), ("y", ctypes.c_int),
        ("width", ctypes.c_int), ("height", ctypes.c_int),
        ("border_width", ctypes.c_int), ("depth", ctypes.c_int),
        ("visual", ctypes.c_void_p), ("root", Window),
        ("class_", ctypes.c_int), ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int), ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong), ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int), ("colormap", ctypes.c_ulong),
        ("map_installed", ctypes.c_int), ("map_state", ctypes.c_int),
        ("all_event_masks", ctypes.c_long), ("your_event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int), ("screen", ctypes.c_void_p),
    ]


class XClassHint(ctypes.Structure):
    _fields_ = [("res_name", ctypes.c_void_p), ("res_class", ctypes.c_void_p)]


class XMapEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int), ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int), ("display", Display),
        ("event", Window), ("window", Window), ("override_redirect", ctypes.c_int),
    ]


class XPropertyEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int), ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int), ("display", Display),
        ("window", Window), ("atom", ctypes.c_ulong),
        ("time", ctypes.c_ulong), ("state", ctypes.c_int),
    ]


class XEvent(ctypes.Union):
    _fields_ = [("type", ctypes.c_int), ("xmap", XMapEvent), ("xproperty", XPropertyEvent),
                ("pad", ctypes.c_long * 24)]


ErrorHandler = ctypes.CFUNCTYPE(ctypes.c_int, Display, ctypes.c_void_p)
x.XOpenDisplay.restype = Display
x.XDefaultRootWindow.restype = Window
x.XDefaultRootWindow.argtypes = [Display]
x.XGetWindowAttributes.argtypes = [Display, Window, ctypes.POINTER(XWindowAttributes)]
x.XGetClassHint.argtypes = [Display, Window, ctypes.POINTER(XClassHint)]
x.XQueryTree.argtypes = [Display, Window, ctypes.POINTER(Window), ctypes.POINTER(Window),
                         ctypes.POINTER(ctypes.POINTER(Window)), ctypes.POINTER(ctypes.c_uint)]
x.XSelectInput.argtypes = [Display, Window, ctypes.c_long]
x.XNextEvent.argtypes = [Display, ctypes.POINTER(XEvent)]
x.XPending.argtypes = [Display]
x.XConnectionNumber.argtypes = [Display]
x.XFlush.argtypes = [Display]
x.XFree.argtypes = [ctypes.c_void_p]
x.XSetErrorHandler.argtypes = [ErrorHandler]
xext.XShapeCombineRectangles.argtypes = [Display, Window, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                         ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int]
xext.XShapeCombineMask.argtypes = [Display, Window, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                   ctypes.c_ulong, ctypes.c_int]

SHAPE_BOUNDING, SHAPE_INPUT, SHAPE_SET = 0, 2, 0
SHAPE_NOTIFY_MASK = 1
SUBSTRUCTURE_NOTIFY = 1 << 19
PROPERTY_CHANGE = 1 << 22
MAP_NOTIFY = 19
CONFIGURE_NOTIFY = 22
PROPERTY_NOTIFY = 28
ANY_PROPERTY_TYPE = 0
XA_CARDINAL = 6
XA_WINDOW = 33
XA_WM_NAME = 39

x.XInternAtom.restype = ctypes.c_ulong
x.XInternAtom.argtypes = [Display, ctypes.c_char_p, ctypes.c_int]
x.XChangeProperty.argtypes = [Display, Window, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int,
                              ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
x.XGetWindowProperty.argtypes = [Display, Window, ctypes.c_ulong, ctypes.c_long, ctypes.c_long,
                                 ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
                                 ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
                                 ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p)]
xext.XShapeQueryExtension.argtypes = [Display, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
xext.XShapeSelectInput.argtypes = [Display, Window, ctypes.c_ulong]
# (display, window, bounding_shaped, x, y, w, h, clip_shaped, x, y, w, h)
xext.XShapeQueryExtents.argtypes = [Display, Window] + ([ctypes.POINTER(ctypes.c_int)] * 3
                                                       + [ctypes.POINTER(ctypes.c_uint)] * 2) * 2

# Windows can vanish between the event and our query; ignore those errors.
_ignore_errors = ErrorHandler(lambda d, e: 0)
x.XSetErrorHandler(_ignore_errors)


x.XTranslateCoordinates.argtypes = [Display, Window, Window, ctypes.c_int, ctypes.c_int,
                                    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
                                    ctypes.POINTER(Window)]
IS_VIEWABLE = 2


def line_window(dpy, root, win):
    """Return (titled, depth, (x, y, w, h)) for a viewable LINE window, else None."""
    attrs = XWindowAttributes()
    if not x.XGetWindowAttributes(dpy, win, ctypes.byref(attrs)) or attrs.map_state != IS_VIEWABLE:
        return None
    hint = XClassHint()
    if not x.XGetClassHint(dpy, win, ctypes.byref(hint)):
        return None
    cls = ctypes.string_at(hint.res_class).lower() if hint.res_class else b""
    for ptr in (hint.res_name, hint.res_class):
        if ptr:
            x.XFree(ptr)
    if cls != b"line.exe":
        return None
    # Not XFetchName: it only reads STRING titles, and Wine stores a title
    # outside Latin-1, such as a Thai chat name, as COMPOUND_TEXT.
    titled = get_property(dpy, win, XA_WM_NAME, ANY_PROPERTY_TYPE)[0] > 0
    rx, ry, child = ctypes.c_int(), ctypes.c_int(), Window()
    x.XTranslateCoordinates(dpy, win, root, 0, 0, ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(child))
    return titled, attrs.depth, (rx.value, ry.value, attrs.width, attrs.height)


def children(dpy, win):
    root_ret, parent = Window(), Window()
    kids, count = ctypes.POINTER(Window)(), ctypes.c_uint()
    if not x.XQueryTree(dpy, win, ctypes.byref(root_ret), ctypes.byref(parent),
                        ctypes.byref(kids), ctypes.byref(count)):
        return []
    result = [kids[i] for i in range(count.value)]
    if kids:
        x.XFree(kids)
    return result


def hugs(shadow, window):
    """True if `shadow` lies along the outside edge of `window`."""
    sx, sy, sw, sh = shadow
    wx, wy, ww, wh = window
    t = min(sw, sh)
    inside_band = wx - t <= sx and sx + sw <= wx + ww + t and wy - t <= sy and sy + sh <= wy + wh + t
    overlaps = sx < wx + ww and wx < sx + sw and sy < wy + wh and wy < sy + sh
    return inside_band and not overlaps


def get_property(dpy, win, atom, kind):
    """(item count, first item if 32-bit else None) of a window property.
    Reads at most one 32-bit unit, so an 8-bit property's count is capped
    at 4. The count is 0 if the property isn't set or has another type."""
    actual, fmt = ctypes.c_ulong(), ctypes.c_int()
    count, after, data = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
    x.XGetWindowProperty(dpy, win, atom, 0, 1, False, kind, ctypes.byref(actual),
                         ctypes.byref(fmt), ctypes.byref(count), ctypes.byref(after), ctypes.byref(data))
    value = None
    if data.value and count.value and fmt.value == 32:
        value = ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0]
    if data.value:
        x.XFree(data)
    return count.value, value


def prop32(dpy, win, atom, kind=XA_CARDINAL):
    """First value of a 32-bit property, or None if it isn't set."""
    return get_property(dpy, win, atom, kind)[1]


def active_window(dpy, root):
    return prop32(dpy, root, x.XInternAtom(dpy, b"_NET_ACTIVE_WINDOW", False), XA_WINDOW)


def shape_state(dpy, win):
    """'default' (no shape), 'empty', or 'other'."""
    shaped, bx, by, cx, cy = (ctypes.c_int() for _ in range(5))
    bw, bh, cw, ch = (ctypes.c_uint() for _ in range(4))
    cshaped = ctypes.c_int()
    xext.XShapeQueryExtents(dpy, win, ctypes.byref(shaped), ctypes.byref(bx), ctypes.byref(by),
                            ctypes.byref(bw), ctypes.byref(bh), ctypes.byref(cshaped),
                            ctypes.byref(cx), ctypes.byref(cy), ctypes.byref(cw), ctypes.byref(ch))
    if not shaped.value:
        return "default"
    return "empty" if bw.value == 0 and bh.value == 0 else "other"


def hide(dpy, win, clickable):
    """Make a shadow window invisible, and click-through unless `clickable`.
    Only writes what differs, so the change events it causes don't trigger
    it again."""
    atom = x.XInternAtom(dpy, b"_NET_WM_WINDOW_OPACITY", False)
    if prop32(dpy, win, atom) != 0:
        zero = ctypes.c_ulong(0)
        x.XChangeProperty(dpy, win, atom, XA_CARDINAL, 32, 0, ctypes.byref(zero), 1)
    # Both shapes change together; X clips the input shape to the bounding
    # one, so a clickable shadow needs both back to the full window.
    state = shape_state(dpy, win)
    for kind in (SHAPE_BOUNDING, SHAPE_INPUT):
        if clickable and state != "default":
            xext.XShapeCombineMask(dpy, win, kind, 0, 0, 0, SHAPE_SET)  # 0 = None: remove the shape
        elif not clickable and state != "empty":
            xext.XShapeCombineRectangles(dpy, win, kind, 0, 0, None, 0, SHAPE_SET, 0)
    # Hear about it if Wine changes the opacity or shape later.
    x.XSelectInput(dpy, win, PROPERTY_CHANGE)
    xext.XShapeSelectInput(dpy, win, SHAPE_NOTIFY_MASK)


def scan(dpy, root):
    """Hide every current LINE shadow window; return how many were found."""
    # Top-level windows, plus a few levels down: window managers reparent
    # titled windows into frames, GNOME's one level deep and KWin's two
    # (frame, then wrapper, then the client).
    windows, level = [], children(dpy, root)
    for _ in range(MAX_FRAME_DEPTH + 1):
        windows.extend(level)
        level = [kid for win in level for kid in children(dpy, win)]
    titled, candidates = [], []
    active = active_window(dpy, root)
    for win in windows:
        info = line_window(dpy, root, win)
        if info is None:
            continue
        is_titled, depth, rect = info
        if is_titled:
            titled.append((rect, win == active))
        elif depth == 32 and min(rect[2], rect[3]) <= MAX_THICKNESS:
            candidates.append((win, rect))
    hidden = 0
    for win, rect in candidates:
        owners = [is_active for owner, is_active in titled if hugs(rect, owner)]
        if owners:
            # Resizable only while its window is active: an inactive LINE
            # window can be covered by other apps, and its shadows, which
            # stay on top, would then catch their clicks.
            hide(dpy, win, clickable=any(owners))
            hidden += 1
    x.XFlush(dpy)
    return hidden


def open_lock(name):
    """Open a lock file in a private per-user folder, never through a symlink."""
    base = os.environ.get("XDG_RUNTIME_DIR") or os.path.join(
        os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "line-linux")
    os.makedirs(base, mode=0o700, exist_ok=True)
    fd = os.open(os.path.join(base, name), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    return os.fdopen(fd, "r+")


def line_running():
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    if b"\\LINE.exe" in f.read().split(b"\0")[0]:
                        return True
            except OSError:
                pass
    return False


def main():
    dpy = x.XOpenDisplay(None)
    if not dpy:
        sys.exit("cannot open X display")
    root = x.XDefaultRootWindow(dpy)
    if "--once" in sys.argv:
        print(f"hid {scan(dpy, root)} shadow windows")
        return

    with open_lock("line-linux-shadows.lock") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return  # another watcher is already running
        watch(dpy, root)


def watch(dpy, root):
    shape_event, shape_error = ctypes.c_int(), ctypes.c_int()
    xext.XShapeQueryExtension(dpy, ctypes.byref(shape_event), ctypes.byref(shape_error))
    x.XSelectInput(dpy, root, SUBSTRUCTURE_NOTIFY | PROPERTY_CHANGE)
    active_atom = x.XInternAtom(dpy, b"_NET_ACTIVE_WINDOW", False)
    scan(dpy, root)
    fd = x.XConnectionNumber(dpy)
    started = last_seen = time.monotonic()
    event = XEvent()
    while True:
        ready, _, _ = select.select([fd], [], [], 5)
        changed = False
        while x.XPending(dpy):
            x.XNextEvent(dpy, ctypes.byref(event))
            if event.type == PROPERTY_NOTIFY and event.xproperty.window == root:
                # The root has many busy properties; only focus matters.
                changed |= event.xproperty.atom == active_atom
            else:
                changed |= event.type in (MAP_NOTIFY, CONFIGURE_NOTIFY, PROPERTY_NOTIFY, shape_event.value)
        if changed:
            # A shadow can appear before its window, so rescan once per batch.
            scan(dpy, root)
        if not ready:
            # Allow time for LineLauncher to start LINE.exe, then exit with it.
            if line_running():
                last_seen = time.monotonic()
            elif time.monotonic() - max(started + 60, last_seen) > 10:
                return

if __name__ == "__main__":
    main()
