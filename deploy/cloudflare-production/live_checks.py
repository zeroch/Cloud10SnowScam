"""HTTP probes used to verify Cloud10 release assets."""
import hashlib
import re
import subprocess


RELEASE_USER_AGENT = "Cloud10-Release/1.0"
SCRIPT_TAG = re.compile(rb"<script(?=[\s>])([^>]*)>(.*?)</script\s*>\s*", re.I | re.S)
BEACON_SRC = re.compile(rb"""\ssrc\s*=\s*(["'])https://static\.cloudflareinsights\.com/beacon\.min\.js(?:/[^"']*)?\1""", re.I)


def fetch(origin, path, method="GET"):
    command = ["curl", "-4", "-sS", "--compressed", "--retry", "2", "--connect-timeout", "6",
               "--max-time", "20", "--user-agent", RELEASE_USER_AGENT,
               "-X", method, "-w", "\n%{http_code}", origin.rstrip("/") + path]
    body, code = subprocess.check_output(command).rsplit(b"\n", 1)
    return int(code), body


def matches_edge_html(served, released):
    # The zone appends its scripts immediately before </body>. Keep every original byte.
    if not released.lstrip()[:15].lower().startswith(b"<!doctype html>"):
        return False
    prefix, closing, tail = released.rpartition(b"</body>")
    suffix = closing + tail
    if not closing or not served.startswith(prefix) or not served.endswith(suffix):
        return False
    added = served[len(prefix):-len(suffix)].strip()
    if not added:
        return False
    offset = 0
    while offset < len(added):
        tag = SCRIPT_TAG.match(added, offset)
        if not tag:
            return False
        attributes, code = tag.groups()
        detection = not attributes.strip() and b"/cdn-cgi/challenge-platform/" in code
        beacon = not code.strip() and BEACON_SRC.search(attributes)
        if not (detection or beacon):
            return False
        offset = tag.end()
    return True


def check_asset(origin, entry, asset_dir=None):
    route = entry["route"]
    status, body = fetch(origin, route)
    if status != 200:
        raise ValueError(f"{origin}{route} returned HTTP {status} (expected 200).")
    digest = hashlib.sha256(body).hexdigest()
    if digest == entry["sha256"]:
        return len(body)
    if asset_dir is not None:
        released = (asset_dir / entry["asset"]).read_bytes()
        if hashlib.sha256(released).hexdigest() == entry["sha256"] and matches_edge_html(body, released):
            return len(released)
    raise ValueError(f"{origin}{route} SHA-256 {digest} differs from release {entry['sha256']}.")
