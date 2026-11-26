"""Verify the public responses against the manifest exported by build-assets.mjs."""
import concurrent.futures
import datetime
import hashlib
import json
import pathlib
import subprocess
import sys

origin, manifest_path, output = sys.argv[1:]
manifest = json.loads(pathlib.Path(manifest_path).read_text())


def fetch(path, method="GET"):
    # The client retries transport failures and returns the final HTTP status.
    command = ["curl", "-4", "-sS", "--compressed", "--retry", "2", "--connect-timeout", "6",
               "--max-time", "20", "-X", method, "-w", "\n%{http_code}", origin.rstrip("/") + path]
    body, code = subprocess.check_output(command).rsplit(b"\n", 1)
    return int(code), body


def check_asset(entry):
    status, body = fetch(entry["route"])
    digest = hashlib.sha256(body).hexdigest()
    if status != 200 or digest != entry["sha256"]:
        raise ValueError((entry["route"], status, digest, entry["sha256"]))
    return len(body)


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    sizes = list(pool.map(check_asset, manifest))
status, body = fetch("/api/health")
health = json.loads(body)
assert status == 200 and health["ok"] and health["currentForecasts"] == 4, health
assert health["storage"] == "Cloudflare D1", health
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
file = pathlib.Path(output)
file.parent.mkdir(parents=True, exist_ok=True)
file.write_text(json.dumps(summary, indent=2) + "\n")
print(f"{origin}: {len(sizes)} matching assets/routes, four 15-day dashboards, stations, roads, 404/405 and healthy D1.")
