# Systol

**A live heart-rate monitor that runs entirely in your browser.** Connect a Bluetooth heart-rate sensor to see your live BPM, training zones, a scrolling trace, and session stats; no app to install and no account to create. Your data never leaves your device.

> **Live demo:** _coming soon_ <!-- TODO: add https://jagrit-sharma.github.io/systol/ once GitHub Pages is enabled, then systol.js.org -->

Systol is **not a medical device.**

## Features

- **Live BPM** with a beating heart that matches your real tempo, plus min / avg / max, RR intervals, and sensor contact status.
- **Training zones:** Light, Moderate, Vigorous, Peak, with editable thresholds and a running "time in each zone" bar.
- **Scrolling trace** of the last 60 seconds, zone-colored, with a hover tooltip.
- **Monitor mode:** a distraction-free fullscreen readout that keeps the screen awake, for use as a bedside/desk display.
- **Target alerts:** pick a target zone and get a chime when you enter or leave it.
- **Audio:** an optional soft beep synced to each beat, with a few tone presets.
- **Export** your session as CSV or JSON, entirely on-device.
- **Themes:** dark or light, with three accent colors (green, blue, amber).
- **Accessibility:** respects reduced-motion, screen-reader zone announcements, keyboard-navigable, and a background-animation toggle.

## Requirements

Systol uses the **Web Bluetooth API**, which is only available in **Chromium-based browsers**: Chrome, Edge, Brave, Opera, Vivaldi, Arc, and Samsung Internet. Firefox and Safari have chosen not to implement Web Bluetooth, so Systol shows an unsupported notice there.

You'll need a **Bluetooth LE heart-rate sensor** that exposes the standard Heart Rate service (`0x180D`); most chest straps and many watches and armbands do.

Web Bluetooth also requires a **secure context**: the page must be served over `https://` or `http://localhost`. Opening the files directly via `file://` will not work.

## Running locally

There's no build step and no dependencies; Systol is plain HTML, CSS, and JavaScript.

### Installation

Clone the repository (or download it as a ZIP from GitHub and unzip it):

```sh
git clone https://github.com/jagrit-sharma/systol.git
cd systol
```

That's the whole install; there's nothing to compile and no packages to fetch.

### Serving

Web Bluetooth needs a secure context, so serve the folder over `localhost` rather than opening the files via `file://`:

```sh
# Python 3
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Any static file server works (`npx serve`, VS Code's Live Server, etc.); the only requirement is `localhost` (or HTTPS) so Web Bluetooth is available.

## Demo mode (no sensor needed)

Append `?demo` to the URL to run a scripted scenario through the real app; it cycles through rest → warm-up → cardio → peak → cool-down → signal-lost and repeats, so you can see every state without a device.

Lock to a single scenario for focused testing or screenshots:

| URL | Scenario |
|-----|----------|
| `?demo` | Full cycle through all phases |
| `?demo=peak` | Hold at a peak-zone heart rate |
| `?demo=flatline` | Signal lost (sensor silent / not worn) |
| `?demo=nopulse` | Sensor connected but reporting no pulse |
| `?demo=nocontact` | A real BPM with no skin contact and no RR data |
| `?demo&battery=5` | Pin the simulated battery to a specific level |

## Privacy

Everything happens on your device. There is **no server and no network calls**; Systol never uploads, transmits, or stores your heart-rate data anywhere off your machine. Your preferences (theme, zones, alerts) are saved in your browser's local storage on this device only, and can be cleared any time from **Settings → Session data → Restore defaults**.

## How it's built

Systol is a **static, client-side app** with no framework, no build system, and no server:

- `index.html`: the app (dashboard, intro pages, dialogs, footer)
- `app.js`: all behavior; Bluetooth pipeline, chart, zones, settings, monitor mode
- `style.css`: all styling, theming, and layout
- `systol-bgfx.js`: the animated ECG background
- `faq.html`: questions and privacy details
- `assets/`: icons and browser/platform logos

It connects over the Web Bluetooth Heart Rate service (`0x180D`), subscribes to the Heart Rate Measurement characteristic (`0x2A37`), and parses each reading per the Bluetooth spec. Battery level is read from the standard Battery service (`0x180F`) when the device exposes it.

## Future enhancements

- **Installable PWA:** offline support and add-to-home-screen.
- **Packaged distribution:** native builds for Android (Google Play), Windows (Microsoft Store), and Linux (Flathub).
- **Session history & recording:** save workouts over time with explicit record / pause / stop, rather than a single rolling session.

## License

Released under the [MIT License](LICENSE).
