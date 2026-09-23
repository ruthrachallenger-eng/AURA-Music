# AURA V3 — Phone + PC

A dependency-free, local-first music player PWA.

## Included
- Responsive phone + PC interface
- Local audio import and IndexedDB storage
- Search
- Favorites
- Playlists
- Albums and artist grouping
- Queue
- Shuffle / repeat
- Seek / volume
- Keyboard shortcuts
- Media Session integration where supported
- PWA install shell + offline app shell
- Dark/light theme
- Library JSON export
- Defensive error handling and no third-party runtime dependencies

## Run
Do NOT open `index.html` with `file://` if you want PWA/service-worker features.

### Windows
If Python is installed:
```bash
py -m http.server 8080
```
Then open:
`http://localhost:8080`

### Node
```bash
npx serve .
```

For phone testing on the same Wi-Fi, use a LAN server such as:
```bash
py -m http.server 8080 --bind 0.0.0.0
```
Then open `http://YOUR-PC-LAN-IP:8080` from the phone. PWA installation normally requires HTTPS or localhost/127.0.0.1, so for real phone installation deploy the folder to an HTTPS host.

## Audio
The app stores imported audio blobs in IndexedDB. Browser codec support varies, so MP3/WAV/OGG are generally safer choices than uncommon formats.

## Important architecture note
AURA V3 is local-first by design. Real account/cloud sync requires a backend and authentication service; this build keeps the player stable without making cloud access a dependency.
