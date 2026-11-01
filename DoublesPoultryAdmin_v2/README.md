# Doubles Poultry Admin (Android)

WebView app for the Doubles Poultry Farm Admin Terminal with offline UI fallback.

## Features
- User-editable server IP:PORT (saved in SharedPreferences)
- Loads bundled UI from assets when no server/IP
- Tries remote server first when configured
- Persistent UI - no blank screen
- Normal app (no kiosk lock)
- Cleartext HTTP allowed for local network
- Pull to refresh
- Change Server from menu

## Build
1. Open in Android Studio
2. Sync Gradle
3. Build APK: Build > Build Bundle(s)/APK(s) > Build APK(s)

## Usage
1. Install APK
2. If no server set, app shows offline UI with banner
3. Menu > Change Server → enter IP and Port (e.g. 192.168.1.100:3001)
4. App connects to Flask server
5. DB access requires server connection
