# Cloud10

Cloud10 is a mountain weather dashboard for Stevens Pass, Crystal Mountain, Summit Central and Mt. Baker. Compare the next morning’s snow across all four resorts, then open a resort for its 15-day outlook, hourly model forecasts, nearby weather station and WSDOT road report. The interface supports English and Simplified Chinese. [Open the club forecast](https://forecast.cloud10snow.com/)

## Run locally

The app uses Node.js 22.13 or newer, its built-in SQLite module and prebuilt browser assets. From the repository root, run

```sh
npm start
```

Open the [resort comparison](http://127.0.0.1:4173/) or the [Stevens Pass forecast](http://127.0.0.1:4173/location/stevenspass/snow-summary). The collector starts with the server. On a fresh database, source cards show their first readings as collection succeeds. [Collector health](http://127.0.0.1:4173/api/health)

| Setting | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address the Node server listens on |
| `PORT` | `4173` | HTTP port |
| `DATABASE_PATH` | `data/weather.sqlite` | Forecast cache, collection history and retry state |
| `NWAC_ENABLED` | `false` | Enables additional Stevens Pass feeds. Each resort already collects its nearby station. |

## Reading the forecast

- **Tomorrow** covers 6 pm to 6 am Pacific. During the night it shows the remaining full hours. Model agreement reflects the spread of complete overnight totals. Snow-quality estimates also use the resort’s NWS snow-level guidance.
- **The 15-day outlook** adds hourly snowfall across Pacific calendar days. For the first 48 full hours, ECMWF and HRRR share 80% of the blend. Afterward ECMWF receives 80%. Other available models share the remaining 20%. Weights redistribute when a model is missing. Uncovered hours leave a period incomplete.
- **Hourly snow accumulation** covers 36 hours starting at the next whole Pacific hour. Three 12-hour windows share one running snowfall total. A missing hour leaves subsequent totals unavailable. The row beneath the totals shows the modeled altitude of the freezing level. Green means forecast rain, purple means likely wet snow at the resort elevation, and blue means snow. Each hour also names its precipitation type. [Desktop preview](docs/hourly-snow-desktop.jpg) · [Phone view at the final hour](docs/hourly-snow-phone.jpg) · [Open-Meteo freezing-level data](https://open-meteo.com/en/docs)
- **Detailed forecasts** compare ECMWF, GFS, ICON, GDPS and HRRR over 24, 72 or 120 hours. Short-range models end at their published horizon. Charts cover snowfall, liquid precipitation, temperature, wind and cloud cover.
- **Observations and roads** show the station’s 24-hour snow-board reading, total snow depth and air temperature when available. Each measurement carries its own observation time. Road reports identify their update time when the provider supplies one.

The local collector refreshes Open-Meteo forecasts and WSDOT reports every 30 minutes, and collects NWS snow levels and nearby NWAC stations hourly. Page views read the saved data. A failed collection preserves the last successful snapshot and its retrieval time.

## Tests and deployment

```sh
npm test
npm run package:nas
```

The NAS command writes a source archive and SHA-256 manifest under `dist/`. The Cloudflare version serves the same dashboard using static assets, scheduled Workers and D1. [Synology setup](docs/deployment/nas.md) · [Cloudflare setup](docs/deployment/cloudflare-production.md)

For a preview with synthetic data, run `node tests/preview-overnight.mjs` on port 4174 or `node tests/preview-resort-comparison.mjs` on port 4176. The Python scripts under `scripts/` are historical authoring tools that take local research captures as inputs. The checked-in pages in `public/` run directly.

## Sources and credits

Forecasts use Open-Meteo data, normalized and aggregated by Cloud10. Snow levels come from NOAA/NWS, station measurements from NWAC and pass reports from WSDOT. [Open-Meteo](https://open-meteo.com/) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) · [NOAA/NWS](https://www.weather.gov/) · [NWAC](https://nwac.us/weather/stations) · [WSDOT](https://wsdot.com/travel/real-time/mountainpasses)

The project includes the Cloud10 Ski Club emblem, Intel’s Clear Sans fonts, Heroicons and Phosphor icons. The Rainy Lake photograph is credited to USFWS. [Project license](LICENSE) · [Clear Sans license](public/clone/assets/Clear-Sans-LICENSE.txt) · [Heroicons license](public/clone/icons/LICENSE.txt) · [Phosphor license](public/clone/icons/phosphor/LICENSE) · [Photo credit](https://commons.wikimedia.org/wiki/File:Rainy_Lake_im_North_Cascades_National_Park.jpg)
