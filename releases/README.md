# Wolfman Releases

## Windows ARM64

`wolfman-windows-arm64-setup.exe` installs the Wolfman tray and overlay app on Windows ARM64. The installer includes the production Node runtime dependencies used for local provider discovery and optional Microsoft 365 Copilot authentication.

SHA-256: `0EB565AB31BCC9E3C0B80301595EBEA9AC032AA81FD5B6A6ABB9DB9B61EEDDBD`

## Android APK

`wolfman-android-debug.apk` — debug build of the standalone Android app, rebuilt and pushed here manually after each notable change (not automated).

## Install on another device

1. Copy `wolfman-android-debug.apk` to the phone (email, cloud drive, USB, etc.).
2. On the phone, enable "Install unknown apps" for whichever app you use to open the file (Settings > Apps > Special access > Install unknown apps).
3. Open the file on the phone and tap Install.

This is a debug build (not Play Store signed), so Android will warn that it's from an unknown source — that's expected for sideloading.
