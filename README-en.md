[English](README-en.md) | [日本語](README-ja.md)
# LINEonLinux

This is a tool for running the official Windows version of LINE on Linux using **Wine**.

> This is an unofficial project. It is not affiliated with LY Corporation or LINE.
> The LINE application itself is not included; you must download it from the official, verify it, and then run it.

## System Requirements

- Linux (x86_64). Testing was conducted on Fedora with KDE Plasma.
- osslsigncode, openssl, curl, python3, xz, and the Noto Sans CJK font
  (`deps.sh` will verify and provide installation instructions for each distribution. For other tools and
  the font, please verify them yourself and install the packages.)

## Installation

```bash
./installer.sh            # Normal
./installer.sh --dpi 144  # For high-DPI displays (150%)
```

DPI refers to Wine’s LogPixels; the default is 120 (125%). 96 = 100%, 144 = 150%,
and 192 = 200%. The specified value is saved in `~/.linewine/dpi` and is also
used at startup. If you only want to change it at startup, the environment variable takes precedence:
`LINEWINE_DPI=120 line-wine`. Changing the DPI will automatically reapply the registry’s
compatibility profile the next time the program is launched.

## Uninstall

```bash
./uninstall.sh          # Remove launcher entry (data remains)
./uninstall.sh --purge  # Delete everything in ~/.linewine (including chat and login data; please verify)
```

## Japanese Input

Since Wine’s X11 driver receives Japanese input via XIM, upon startup,
`launch-line.sh` automatically configures the following:

- Detects the currently running IME and sets `XMODIFIERS` (fcitx-based → `@im=fcitx`, IBus → `@im=ibus`)
- If the locale is not Japanese, sets `LC_ALL=ja_JP.UTF-8`.

On the host side, IBus or fcitx5 must be running alongside Mozc, Anthy, or similar IME software.
You can check the IME detection status and whether the ja locale is set using `./diagnose.sh`.
Any `XMODIFIERS` settings you have already configured yourself will not be overwritten.
To disable automatic configuration entirely, set `LINEWINE_NO_IME_ENV=1`.

## Usage

```bash
line-wine            # Start (If the signature is outdated due to a Wine update, it will be automatically re-signed)
./update.sh          # Update the kit and re-sign (LINE itself is updated automatically)
./diagnose.sh        # Check status (signature, fonts, version, etc.)
```

## Changes Made

| Issue | Solution |
|---|---|
| Launch fails due to signature check in LINE 26.x | Signed the DLL in the prefix (`compat.sh`) with a local certificate |
| Crashes with emojis after logging in | Dedicated fontconfig view to hide the color emoji font from Wine + replace `Segoe UI Emoji` with `Symbola` |
| Window disappears when maximized | Disable WM decorations for `LINE.exe` |
| Image viewer crashes | Set `msvcp140_2` in `LineMediaPlayer.exe` to prioritize native |
| Window becomes transparent on Wayland | Lock Wine rendering to X11 driver + EGL disabled (unlock with `LINEWINE_KEEP_WAYLAND=1`) |
| Downloads get buried deep within the prefix | Link the Windows user folder to the actual XDG folder |
| Garbled text/square characters | Font substitution to Noto Sans CJK, DPI (default 120, can be changed with `--dpi`), RGB smoothing |

## Data Locations

```
~/.linewine/
  runners/   Portable Wine (wine-11.22-amd64, approx. 850 MB after extraction)
  prefix/    Wine prefix (LINE main application and chat data; subject to backup)
  signing/   Local signing certificates and keys (keys have 0600 permissions)
  cache/     Downloaded official installer
  state/     Font view, list of failed signatures, latest signature log
  app/       Complete set of installed launchers (will still work even if the kit folder is deleted)
```

## Environment Variables

- `LINEWINE_DIR` (default `~/.linewine`), `LINEWINE_PREFIX`
- `LINEWINE_WINE` — Specify this if you want to use your own Wine (version 9 or higher) instead of the runner
- `LINEWINE_DPI` — Temporarily override DPI (takes precedence over saved values)
- `LINE_INSTALLER` — Specify this if using your local `LineInst.exe`
- `LINEWINE_KEEP_WAYLAND=1` — Disable X11 lock
- `LINEWINE_NO_IME_ENV=1` — Disable automatic configuration of environment variables related to Japanese input
- `ASSUME_YES=1` — Skip confirmation for dependency installation

## Uninstallation

Simply remove the app menu entry and launcher, then delete the prefix directory to complete the process
(Chat data will also be deleted. Be sure to back it up first).

```bash
rm -f ~/.local/share/applications/line-wine.desktop ~/.local/bin/line-wine
rm -rf ~/.linewine
```

## Credits

- Portable Wine: [Kron4ek/Wine-Builds](https://github.com/Kron4ek/Wine-Builds)
  (Using wine-11.22-amd64 with a fixed SHA-256 hash)
