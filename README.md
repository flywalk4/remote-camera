# 🌕 Remote Camera

An iOS app that turns an iPhone on a tripod into a camera with **full manual control
from a MacBook**. Built primarily for photographing the Moon: ISO, shutter speed,
manual focus with a loupe, white balance, telephoto lens, RAW, and frame series for stacking.

```
 iPhone on a tripod (app)                         MacBook (any browser)
┌─────────────────────────────────┐   Wi-Fi /   ┌──────────────────────────┐
│ AVFoundation: manual camera     │  Personal   │ http://<iPhone IP>:8080  │
│ built-in HTTP server :8080 ─────┼──Hotspot───▶│ preview + histogram      │
│ photos in Documents/Photos      │             │ all settings, shutter    │
└─────────────────────────────────┘             └──────────────────────────┘
```

Nothing needs to be installed on the Mac: the remote opens in a browser and is served
by the iPhone app itself.

> Why a native app and not a website: Safari doesn't let web pages control ISO,
> shutter speed or focus — only native code via AVFoundation can.

## Features

**Camera**
- Lens selection: ultra wide / wide / **telephoto** (the longest one is best for the Moon) + digital zoom.
- **Exposure**: ISO and shutter speed via sliders and quick buttons (always visible; in auto mode
  they show the values chosen by the iPhone, and moving any slider switches to manual);
  EV compensation and click-to-meter in auto mode; exposure meter needle.
- **Focus**: auto (click the preview to set the focus point) or manual — lens position in 0.001 steps,
  ± buttons, `[` `]` keys; a **2×/4×/8× loupe** shows the center of the frame at full resolution
  for precise focusing.
- **White balance**: auto or manual (temperature and tint).
- Manual settings are kept when switching lenses.

**Capture**
- Formats: HEIF, JPEG, **RAW (DNG)**, **Apple ProRAW** (Pro models).
- Delay before the shot (2/5/10 s) so the tripod stops shaking after you press the button.
- **Series**: N frames at an interval — for stacking in AutoStakkert!, Siril, RegiStax, etc.
- Full sensor resolution (up to 48 MP on recent models) for HEIF/JPEG/ProRAW.
- Photos are stored on the iPhone (visible in Files → On My iPhone → Remote Camera),
  can be downloaded to the Mac from the remote, and optionally saved to Photos.

**Mac remote**
- Live preview, histogram with clipping indicator, grid.
- Red night mode — doesn't ruin your dark adaptation.
- iPhone status: battery, overheating.
- One-click "🌕 Moon preset".

**The iPhone app** shows the remote's address, a preview, a shutter button and a **settings
panel** ("Settings" button): lens, ISO, shutter speed, focus — kept in sync with the Mac remote.
The 🌙 button blacks out the screen (minimum brightness) while the app keeps running.

## Installing on the iPhone

You need a Mac with **Xcode 15+** and an iPhone on **iOS 17+**. A paid developer account is not
required — a regular Apple ID works (the app then runs for 7 days; just reinstall it from Xcode).

```bash
git clone -b claude/vigilant-fermat-af9osn https://github.com/flywalk4/remote-camera.git
cd remote-camera
brew install xcodegen      # Xcode project generator
xcodegen                   # creates RemoteCamera.xcodeproj
open RemoteCamera.xcodeproj
```

In Xcode:
1. Select the **RemoteCamera** project → **Signing & Capabilities** tab → **Team**: your Apple ID
   (add it under Xcode → Settings → Accounts if needed). If Xcode says the Bundle Identifier is
   taken, change `com.example.remotecamera` to something of your own, e.g. `com.yourname.remotecamera`.
2. Connect the iPhone with a cable, select it as the run destination at the top and press ▶︎ (⌘R).
3. On the iPhone, on first launch: **Settings → General → VPN & Device Management** →
   trust your developer certificate. Also enable **Developer Mode**
   (Settings → Privacy & Security) if iOS asks for it.
4. Allow the app access to the camera and to the **local network** (the Mac can't connect without it).

<details>
<summary>Without XcodeGen (create the project manually)</summary>

1. Xcode → File → New → Project → iOS **App**, Interface: SwiftUI, Language: Swift, name `RemoteCamera`.
2. Delete the generated `ContentView.swift` and `RemoteCameraApp.swift`, then drag all files from
   the `RemoteCamera/` folder into the project.
3. Drag in the `Web` folder and choose **Create folder references** (blue folder), with the target checked.
4. In Build Settings set **iOS Deployment Target 17.0** and **Swift Language Version 5**.
5. In the **Info** tab add the keys from `info.properties` in `project.yml`
   (at least `NSCameraUsageDescription`, `NSLocalNetworkUsageDescription`, `NSBonjourServices`,
   `NSPhotoLibraryAddUsageDescription`, `UIFileSharingEnabled`).
</details>

## Usage

1. Put the iPhone on a tripod and launch the app. The address is shown at the top, e.g.
   `http://192.168.1.23:8080`.
2. Open that address in a browser on the Mac (Safari or Chrome).
3. The iPhone and the Mac must be on the same network. **Outdoors without Wi-Fi**: turn on
   Personal Hotspot on the iPhone and connect the Mac to it via Wi-Fi or cable — the address will be
   `http://172.20.10.1:8080`.
4. Keep the app in the foreground: iOS turns off the camera for apps in the background. You can
   black out the screen with the 🌙 button.

### Remote keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Shoot (respecting delay/series settings) |
| `Esc` | Stop a series |
| `L` | Loupe 1× → 2× → 4× → 8× |
| `[` / `]` | Focus slightly nearer / farther (`Shift` for a bigger step) |
| `G` | Grid |
| `H` | Show/hide histogram |
| `N` | Red night mode |

## How to photograph the Moon

1. Press **🌕 Moon preset**: it selects the telephoto lens, manual exposure at ISO 50 and 1/250 s,
   white balance ~4800 K, and RAW format.
2. Aim the iPhone so the Moon is in the center (the `G` grid helps).
3. **Focus**: turn on the 4–8× loupe (`L`), switch focus to "Manual" and move the slider or use
   `[` `]` until the craters along the terminator (the light/shadow boundary) are as sharp as possible.
   Infinity on an iPhone is usually not exactly 1.0 — judge by the image.
4. **Exposure**: watch the histogram — the "clipped" warning should disappear. The Moon is lit by
   the Sun, so shutter speeds are short: typically ISO 50–100 and 1/250–1/1000 s.
   Slight underexposure is better — RAW can lift the shadows, but blown-out maria can't be recovered.
5. Set a 2 s delay (so the tripod settles) and a series, e.g. 50 frames at a 0.5 s interval.
6. Download the DNGs to the Mac and stack them in AutoStakkert!/Siril/RegiStax — noise goes down,
   detail goes up.

Exposure on an iPhone is limited to about 1 second — more than enough for the Moon, but this
approach won't work for stars or the Milky Way.

## Project layout

```
project.yml                        Xcode project definition for XcodeGen
RemoteCamera/
  RemoteCameraApp.swift            entry point, starts the camera and the server
  ContentView.swift                iPhone screen: remote address, preview, blackout
  CameraControlsView.swift         settings panel on the iPhone (lens, ISO, shutter, focus)
  CameraController.swift           AVFoundation: lenses, manual settings, capture, series, preview
  HTTPServer.swift                 mini HTTP server (Network.framework) and MJPEG stream
  WebAPI.swift                     API routes for the remote
  PhotoStore.swift                 photo storage
  Models.swift                     state/settings models (JSON)
  NetworkInfo.swift                iPhone IP addresses
Web/                               web remote (served by the app)
  index.html, app.js, style.css
```

### HTTP API

| Method | Path | Description |
|---|---|---|
| GET | `/api/state` | All current camera parameters and ranges |
| POST | `/api/settings` | `{lens, zoom, exposureMode, iso, shutter, bias, focusMode, lensPosition, wbMode, temperature, tint, point:{x,y}, loupe}` — any subset |
| POST | `/api/capture` | `{format: heif\|jpeg\|raw\|proraw, count, interval, delay, saveToPhotos}` |
| POST | `/api/cancel` | Cancel a series |
| GET | `/api/photos` | List photos |
| GET | `/photos/<name>` | File (`?download=1` to download) |
| POST | `/api/photos/delete` | `{name}` |
| GET | `/stream` | MJPEG preview |

So the camera can also be scripted, for example:
`curl -X POST http://172.20.10.1:8080/api/capture -d '{"format":"raw","count":100,"interval":1}'`.
