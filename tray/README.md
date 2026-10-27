# weather-kin tray (Windows)

A little system-tray icon that shows the same weather your kin gets: the current temperature on a tile coloured by conditions (amber for clear, grey for cloud/fog, blue for rain, light blue for snow, purple for storms). Hover for conditions, right-click for details.

It calls Open-Meteo (or Visual Crossing) directly with the same settings as weather-kin, so it doesn't depend on Railway or Kindroid at all.

## Setup

1. Install [Python 3.10+](https://www.python.org/downloads/windows/) (tick **Add python.exe to PATH** in the installer).
2. Open a terminal in this `tray` folder and install the two dependencies:
   ```
   pip install -r requirements.txt
   ```
3. Copy `.env.example` to `.env` and fill in the same values you used on Railway (`LATITUDE`, `LONGITUDE`, units, provider...). Kindroid keys aren't needed.
4. Run it without a console window:
   ```
   pythonw weather_tray.py
   ```
   (Use `python weather_tray.py` instead if you want to see errors while testing.)

## Using it

- **Hover** the icon: location, conditions, and "feels like".
- **Right-click**: today's high/low, wind, humidity, last update time, **Refresh now**, **Start with Windows**, and **Quit**.
- **Start with Windows** adds the app to your user's startup programs (no admin needed). Click it again to remove it.
- Windows 11 tucks new tray icons into the `^` overflow. To keep it visible on the taskbar, go to **Settings → Personalization → Taskbar → Other system tray icons** and switch on **python** (or drag the icon out of the overflow).

## Settings

| Variable | Default | Description |
|---|---|---|
| `LATITUDE` / `LONGITUDE` | *(required)* | Your location |
| `LOCATION_NAME` / `LOCATION_REGION` | *(none)* | Shown at the top of the tooltip and menu |
| `WEATHER_PROVIDER` | `openmeteo` | `openmeteo` or `visualcrossing` |
| `VISUALCROSSING_API_KEY` | *(none)* | Required for `visualcrossing` |
| `TEMPERATURE_UNIT` | `celsius` | `celsius` or `fahrenheit` |
| `WIND_SPEED_UNIT` | `kmh` | `kmh` or `mph` |
| `REFRESH_MINUTES` | `15` | How often to refresh |

The app reads `tray/.env` first, then falls back to the repo-root `.env`. If a refresh fails, the last good reading stays up and the menu says the last refresh failed.
