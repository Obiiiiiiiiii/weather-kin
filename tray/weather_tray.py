"""
weather-kin tray: shows current weather in the Windows system tray.

Uses the same providers and env variables as index.js (Open-Meteo or
Visual Crossing). The tray icon shows the current temperature; hover for
conditions, right-click for details, refresh, and start-with-Windows.

Run with `pythonw weather_tray.py` to keep the console window hidden.
"""

import json
import os
import sys
import threading
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

import pystray
from PIL import Image, ImageDraw, ImageFont

APP_NAME = "weather-kin tray"
SCRIPT_DIR = Path(__file__).resolve().parent


# --- Config ---

def load_env_file():
    """Load KEY=VALUE pairs from tray/.env, falling back to the repo-root .env.
    Real environment variables win over the file."""
    for candidate in (SCRIPT_DIR / ".env", SCRIPT_DIR.parent / ".env"):
        if not candidate.exists():
            continue
        for line in candidate.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        return candidate
    return None


ENV_FILE = load_env_file()


def required_env(name):
    value = os.environ.get(name)
    if not value:
        fail(f"Missing required setting: {name}\n\nAdd it to {SCRIPT_DIR / '.env'}")
    return value


def fail(message):
    # pythonw has no console, so show a message box on Windows.
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, message, APP_NAME, 0x10)
    else:
        print(message, file=sys.stderr)
    sys.exit(1)


CONFIG = {
    "location_name": os.environ.get("LOCATION_NAME", ""),
    "location_region": os.environ.get("LOCATION_REGION", ""),
    "latitude": required_env("LATITUDE"),
    "longitude": required_env("LONGITUDE"),
    "provider": os.environ.get("WEATHER_PROVIDER", "openmeteo").lower(),
    "vc_key": os.environ.get("VISUALCROSSING_API_KEY", ""),
    "temperature_unit": os.environ.get("TEMPERATURE_UNIT", "celsius"),
    "wind_speed_unit": os.environ.get("WIND_SPEED_UNIT", "kmh"),
    "refresh_minutes": max(1, int(os.environ.get("REFRESH_MINUTES", "15"))),
}

if CONFIG["provider"] not in ("openmeteo", "visualcrossing"):
    fail(f'Invalid WEATHER_PROVIDER: "{CONFIG["provider"]}" (must be openmeteo or visualcrossing)')
if CONFIG["provider"] == "visualcrossing" and not CONFIG["vc_key"]:
    fail("VISUALCROSSING_API_KEY is required when WEATHER_PROVIDER=visualcrossing")

TEMP_SYMBOL = "°F" if CONFIG["temperature_unit"] == "fahrenheit" else "°C"
WIND_SYMBOL = "mph" if CONFIG["wind_speed_unit"] == "mph" else "km/h"


# --- WMO weather codes (mirrors WMO_CONDITIONS in index.js) ---

WMO_CONDITIONS = {
    0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
    45: "foggy", 48: "foggy",
    51: "drizzling", 53: "drizzling", 55: "drizzling",
    56: "freezing drizzle", 57: "freezing drizzle",
    61: "rainy", 63: "rainy", 65: "rainy",
    66: "freezing rain", 67: "freezing rain",
    71: "snowing", 73: "snowing", 75: "snowing", 77: "snowing lightly",
    80: "showery", 81: "showery", 82: "showery",
    85: "snowing heavily", 86: "snowing heavily",
    95: "thunderstorming", 96: "thunderstorming with hail", 99: "thunderstorming with hail",
}

VC_ICON_TO_WMO = {
    "clear-day": 0, "clear-night": 0,
    "partly-cloudy-day": 2, "partly-cloudy-night": 2,
    "cloudy": 3, "fog": 45, "wind": 1,
    "rain": 63, "showers-day": 80, "showers-night": 80,
    "snow": 73, "snow-showers-day": 85, "snow-showers-night": 85,
    "sleet": 66,
    "thunder-rain": 95, "thunder-showers-day": 95, "thunder-showers-night": 95,
    "hail": 99,
}


def refine_vc_weather_code(icon, conditions):
    base = VC_ICON_TO_WMO.get(icon, 0)
    if not conditions:
        return base
    c = conditions.lower()
    if "freezing drizzle" in c:
        return 56
    if "drizzle" in c:
        return 53
    if "rain showers" in c:
        return 80
    if "heavy rain" in c and "freezing" not in c:
        return 65
    if "light rain" in c and "freezing" not in c:
        return 61
    if "rain" in c and "freezing" not in c and "showers" not in c:
        return 63
    return base


def describe_wind(speed):
    is_kmh = CONFIG["wind_speed_unit"] == "kmh"
    light, moderate, strong = (15, 30, 50) if is_kmh else (9, 19, 31)
    if speed < light:
        return None
    if speed < moderate:
        return "light breeze"
    if speed < strong:
        return "strong winds"
    return "very strong winds"


# Icon background colour per condition, so the weather reads at a glance.
def condition_colour(code):
    if code in (0, 1):
        return (230, 160, 20)      # sunny amber
    if code in (2, 3, 45, 48):
        return (110, 120, 135)     # cloud grey
    if code in (71, 73, 75, 77, 85, 86):
        return (120, 180, 230)     # snow blue
    if code in (95, 96, 99):
        return (110, 70, 160)      # storm purple
    return (40, 100, 190)          # rain blue


# --- Fetching ---

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": APP_NAME})
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.load(res)


def fetch_open_meteo():
    params = {
        "latitude": CONFIG["latitude"],
        "longitude": CONFIG["longitude"],
        "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m",
        "daily": "temperature_2m_max,temperature_2m_min",
        "forecast_days": 1,
        "timezone": "auto",
        "temperature_unit": CONFIG["temperature_unit"],
        "wind_speed_unit": CONFIG["wind_speed_unit"],
    }
    data = fetch_json("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params))
    cur = data["current"]
    return {
        "temp": cur["temperature_2m"],
        "feels_like": cur.get("apparent_temperature"),
        "code": cur["weather_code"],
        "wind": cur["wind_speed_10m"],
        "humidity": cur.get("relative_humidity_2m"),
        "high": data["daily"]["temperature_2m_max"][0],
        "low": data["daily"]["temperature_2m_min"][0],
    }


def fetch_visual_crossing():
    unit_group = "us" if CONFIG["temperature_unit"] == "fahrenheit" else "metric"
    url = (
        "https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/"
        f"{CONFIG['latitude']},{CONFIG['longitude']}/today?"
        + urllib.parse.urlencode({
            "unitGroup": unit_group,
            "key": CONFIG["vc_key"],
            "include": "current,days",
            "iconSet": "icons2",
        })
    )
    vc = fetch_json(url)

    # VC ties the wind unit to unitGroup, so convert if the user mixed units.
    need_conversion = (
        (CONFIG["wind_speed_unit"] == "mph" and unit_group == "metric")
        or (CONFIG["wind_speed_unit"] == "kmh" and unit_group == "us")
    )

    def convert_wind(speed):
        if not need_conversion or speed is None:
            return speed
        return speed / 1.609 if unit_group == "metric" else speed * 1.609

    cur = vc["currentConditions"]
    day = (vc.get("days") or [{}])[0]
    return {
        "temp": cur["temp"],
        "feels_like": cur.get("feelslike"),
        "code": refine_vc_weather_code(cur.get("icon"), cur.get("conditions")),
        "wind": convert_wind(cur.get("windspeed") or 0),
        "humidity": cur.get("humidity"),
        "high": day.get("tempmax"),
        "low": day.get("tempmin"),
    }


def fetch_weather():
    if CONFIG["provider"] == "visualcrossing":
        return fetch_visual_crossing()
    return fetch_open_meteo()


# --- Rendering ---

def load_font(size):
    for name in ("segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def make_icon(text, colour):
    """Draw the temperature as big as it fits on a rounded, condition-coloured tile."""
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=12, fill=colour + (255,))

    font_size = 60
    while font_size > 10:
        font = load_font(font_size)
        left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
        if right - left <= size - 4 and bottom - top <= size - 4:
            break
        font_size -= 2

    x = (size - (right - left)) / 2 - left
    y = (size - (bottom - top)) / 2 - top
    draw.text((x, y), text, font=font, fill="white", stroke_width=2, stroke_fill=(0, 0, 0, 160))
    return img


def location_label():
    parts = [p for p in (CONFIG["location_name"], CONFIG["location_region"]) if p]
    return ", ".join(parts)


def summary_lines(w):
    conditions = WMO_CONDITIONS.get(w["code"], "unknown conditions")
    wind = describe_wind(w["wind"])
    headline = f"{round(w['temp'])}{TEMP_SYMBOL}, {conditions}"
    if wind:
        headline += f", {wind}"

    lines = [headline]
    if w.get("feels_like") is not None:
        lines.append(f"Feels like {round(w['feels_like'])}{TEMP_SYMBOL}")
    if w.get("high") is not None and w.get("low") is not None:
        lines.append(f"High {round(w['high'])}{TEMP_SYMBOL} / Low {round(w['low'])}{TEMP_SYMBOL}")
    details = f"Wind {round(w['wind'])} {WIND_SYMBOL}"
    if w.get("humidity") is not None:
        details += f" · Humidity {round(w['humidity'])}%"
    lines.append(details)
    return lines


# --- Start with Windows (HKCU Run key, no admin needed) ---

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def startup_command():
    exe = Path(sys.executable)
    pythonw = exe.with_name("pythonw.exe")
    return f'"{pythonw if pythonw.exists() else exe}" "{Path(__file__).resolve()}"'


def startup_enabled(_item=None):
    if sys.platform != "win32":
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.QueryValueEx(key, APP_NAME)
            return True
    except OSError:
        return False


def toggle_startup(_icon, _item):
    if sys.platform != "win32":
        return
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if startup_enabled():
            winreg.DeleteValue(key, APP_NAME)
        else:
            winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, startup_command())


# --- App ---

class TrayApp:
    def __init__(self):
        self.lines = ["Loading weather..."]
        self.updated = None
        self.error = None
        self.stop_event = threading.Event()
        self.refresh_event = threading.Event()
        self.icon = pystray.Icon(
            APP_NAME,
            icon=make_icon("…", (110, 120, 135)),
            title="Loading weather...",
            menu=pystray.Menu(self.build_menu),
        )

    def build_menu(self):
        items = [pystray.MenuItem(line, None, enabled=False) for line in self.lines]
        if location_label():
            items.insert(0, pystray.MenuItem(location_label(), None, enabled=False))
        status = f"Updated {self.updated:%H:%M}" if self.updated else "Not updated yet"
        if self.error:
            status += " (last refresh failed)"
        items += [
            pystray.MenuItem(status, None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Refresh now", lambda: self.refresh_event.set(), default=True),
            pystray.MenuItem("Start with Windows", toggle_startup, checked=startup_enabled,
                             visible=sys.platform == "win32"),
            pystray.MenuItem("Quit", self.quit),
        ]
        return items

    def update(self):
        try:
            w = fetch_weather()
        except Exception as err:  # keep the last good reading on failure
            self.error = str(err)
            print(f"Weather fetch failed: {err}", file=sys.stderr)
            if self.updated is None:
                self.icon.title = f"Weather unavailable: {err}"[:127]
            self.icon.update_menu()
            return

        self.error = None
        self.updated = datetime.now()
        self.lines = summary_lines(w)
        self.icon.icon = make_icon(str(round(w["temp"])), condition_colour(w["code"]))
        tooltip = "\n".join(([location_label()] if location_label() else []) + self.lines[:2])
        self.icon.title = tooltip[:127]  # Windows caps tray tooltips at 128 chars
        self.icon.update_menu()

    def loop(self):
        while not self.stop_event.is_set():
            self.update()
            self.refresh_event.wait(CONFIG["refresh_minutes"] * 60)
            self.refresh_event.clear()

    def quit(self, icon, _item):
        self.stop_event.set()
        self.refresh_event.set()
        icon.stop()

    def run(self):
        def setup(icon):
            icon.visible = True
            threading.Thread(target=self.loop, daemon=True).start()
        self.icon.run(setup=setup)


if __name__ == "__main__":
    TrayApp().run()
