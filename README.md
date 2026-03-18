# weather-kin

Polls [Open-Meteo](https://open-meteo.com/) for live weather data and updates a [Kindroid](https://kindroid.ai/) AI's **Current Setting** with a natural-language scene description.

No weather API key is needed — Open-Meteo is free and requires no account.

## Example output

> It's currently 12°C and rainy in Seabreak. It's windy outside.

## Requirements

- Node.js 18+
- A Kindroid API key and AI ID

## Setup

1. Copy the example env file and fill in your values:

   ```sh
   cp .env.example .env
   ```

2. Edit `.env`:

   | Variable | Required | Default | Description |
   |---|---|---|---|
   | `KINDROID_API_KEY` | Yes | | Your Kindroid API key |
   | `KINDROID_AI_ID` | Yes | | The AI ID of the kin to update |
   | `LOCATION_NAME` | Yes | | Display name used in the scene (e.g. `Seabreak`) |
   | `LATITUDE` | Yes | | Location latitude (e.g. `49.16`) |
   | `LONGITUDE` | Yes | | Location longitude (e.g. `-123.94`) |
   | `TEMPERATURE_UNIT` | No | `celsius` | `celsius` or `fahrenheit` |
   | `WIND_SPEED_UNIT` | No | `kmh` | `kmh` or `mph` |
   | `INTERVAL_HOURS` | No | `6` | Hours between weather updates |

## Running

### Directly

```sh
npm start
```

### With Docker

```sh
docker build -t weather-kin .
docker run --env-file .env weather-kin
```

## How it works

1. Fetches current weather from Open-Meteo for the configured coordinates.
2. Converts the WMO weather code, temperature, and wind speed into a short natural-language sentence.
3. Pushes that sentence to the kin's Current Setting via the Kindroid API.
4. Repeats on the configured interval (default: every 6 hours).

If a fetch fails, the last successful scene is retained until the next successful update.

## License

MIT
