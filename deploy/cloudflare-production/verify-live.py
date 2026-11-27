"""Verify the public responses against the manifest exported by build-assets.mjs."""
import argparse
import concurrent.futures
import datetime
import json
import pathlib

import live_checks

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("origin")
parser.add_argument("manifest", type=pathlib.Path)
parser.add_argument("output", type=pathlib.Path)
parser.add_argument("expected_release", nargs="?")
parser.add_argument("--public-edge", action="store_true",
                    help="Check zone-injected HTML against the original assets beside the manifest.")
args = parser.parse_args()
origin = args.origin
manifest = json.loads(args.manifest.read_text())
asset_dir = args.manifest.parent / "assets" if args.public_edge else None


def fetch(path, method="GET"):
    return live_checks.fetch(origin, path, method)


def check_asset(entry):
    return live_checks.check_asset(origin, entry, asset_dir)


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    sizes = list(pool.map(check_asset, manifest))
status, body = fetch("/api/health")
health = json.loads(body)
assert status == 200 and health["ok"] and health["currentForecasts"] == 4, health
assert health["storage"] == "Cloudflare D1", health
if args.expected_release is not None:
    assert health["release"] == args.expected_release, health
status, body = fetch("/api/resorts")
assert status == 200
resorts = json.loads(body)["resorts"]
assert {r["id"] for r in resorts} == {"stevenspass", "crystalmountain", "summitcentral", "mtbaker"}
records = []
for resort in resorts:
    resort_id = resort["id"]
    status, body = fetch("/api/resorts/" + resort_id + "/dashboard")
    assert status == 200
    data = json.loads(body)
    assert data["resort"]["id"] == resort_id and len(data["models"]) == 5
    assert all(len(model["points"]) == 384 for model in data["models"]), resort_id
    assert data["advice"] and data["snowLevels"] and data["morning"]["road"]["passName"], resort_id
    station = data["morning"]["station"]
    assert any(station.get(k, None) and station[k].get("observedAt") for k in ["depth", "temperature", "snowfall24h"]), resort_id
    sources = {s["id"]: {"status": s["status"], "fetchedAt": s["fetchedAt"]} for s in data["sources"]
               if s["id"] in ("forecast", "nws", "nwac", "wsdot")}
    records.append({"resort": resort_id, "models": len(data["models"]), "hours": 384, "station": station["name"],
                    "road": data["morning"]["road"]["passName"], "sources": sources})
assert fetch("/api/dashboard?resort=mtbaker")[0] == 200
assert fetch("/location/unknown/snow-summary")[0] == 404
assert fetch("/api/resorts/unknown/dashboard")[0] == 404
assert fetch("/api/dashboard", "POST")[0] == 405
summary = {"verifiedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "origin": origin,
           "matchingRoutesAndAssets": len(sizes), "matchingBytes": sum(sizes), "health": health, "resorts": records}
file = args.output
file.parent.mkdir(parents=True, exist_ok=True)
file.write_text(json.dumps(summary, indent=2) + "\n")
print(f"{origin}: {len(sizes)} matching assets/routes, four 15-day dashboards, stations, roads, 404/405 and healthy D1.")
