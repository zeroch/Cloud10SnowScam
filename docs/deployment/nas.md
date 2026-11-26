# Cloud10 on Synology

The NAS edition uses Docker Compose and stores forecasts in a named SQLite volume. The image build runs the application tests before assembling the runtime image.

## Install

1. From the repository root, run `npm run package:nas`. Upload the ZIP from `dist/` and extract it into a dedicated folder on the NAS.
2. To reach Cloud10 from your LAN, create a `.env` file beside `compose.yaml`. Set `CLOUD10_BIND_ADDRESS` to the NAS’s LAN IP. The default is `127.0.0.1` for host-only access.
3. In Synology Container Manager, create a project named `cloud10`, select the extracted folder and use its `compose.yaml`. Build and start the project. On a Docker host you can also run `docker compose -p cloud10 up --build -d` from that folder.
4. Open `http://<NAS-LAN-IP>:4173/` on the same network. For a host-only installation, use `http://127.0.0.1:4173/` on the host.

## Operations

`/api/health` reports storage and collector health. `/api/resorts` lists the supported mountains. `/api/resorts/{id}/dashboard` reads the latest saved dashboard for one mountain. The collector runs independently of page visits.

Keep the same Compose project name and `weather-data` volume across upgrades. The database lives at `/app/data/weather.sqlite` inside the container. For a consistent backup, stop the app before copying the whole volume, including SQLite’s WAL files, or use SQLite’s online backup API. To roll back, use the earlier image with a compatible database schema.

For temporary public access through a separate Cloudflare Tunnel, see the [connector setup](https://github.com/zeroch/Cloud10SnowScam/tree/main/deploy/remote).
