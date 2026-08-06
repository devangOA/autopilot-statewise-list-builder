"""Single-URL Scrapling fetch, invoked by src/fallback.js.

Prints one JSON object on stdout: {"pages": [...]} or {"error": "..."}.
Each page carries `finalUrl` so the Node side can reject off-domain redirects --
a 200 from a hijacked domain must never reach the facility data.

Usage: python scrapling_fetch.py <url> <http|stealthy>
"""
import json
import logging
import re
import sys
from urllib.parse import urljoin, urlparse

# Scrapling logs fetches at INFO to stdout, which would corrupt the JSON.
logging.disable(logging.CRITICAL)

SUBPAGE_HINTS = re.compile(
    r"contact|about|staff|our[-\s]?team|leadership|management|directory|"
    r"who[-\s]?we[-\s]?are|meet[-\s]?the|administration|membership|facilit|"
    r"courts?|rentals?|programs?|athletics|location",
    re.I,
)


def payload(resp, requested):
    html = resp.html_content if hasattr(resp, "html_content") else str(resp)
    try:
        text = resp.get_all_text(ignore_tags=("script", "style"))
    except Exception:
        text = re.sub(r"<[^>]+>", " ", html)
    links = []
    try:
        for a in resp.css("a[href]"):
            href = a.attrib.get("href", "")
            if href:
                links.append({"href": urljoin(requested, href), "text": (a.text or "")[:120]})
    except Exception:
        pass
    return {
        "url": requested,
        # The URL actually served after redirects, which is what the domain
        # guard on the Node side checks.
        "finalUrl": getattr(resp, "url", requested) or requested,
        "status": getattr(resp, "status", 0),
        "text": text,
        "html": html,
        "links": links,
    }


def pick_subpages(links, base_host, limit=6):
    seen, out = set(), []
    for l in links:
        try:
            u = urlparse(l["href"])
        except Exception:
            continue
        if u.scheme not in ("http", "https") or not u.hostname:
            continue
        if u.hostname.replace("www.", "") != base_host:
            continue
        key = f"{u.scheme}://{u.netloc}{u.path.rstrip('/')}"
        if key in seen or not SUBPAGE_HINTS.search(f"{u.path} {l['text']}"):
            continue
        seen.add(key)
        out.append(key)
        if len(out) >= limit:
            break
    return out


def main():
    url, mode = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "http")
    host = (urlparse(url).hostname or "").replace("www.", "")

    if mode == "http":
        from scrapling.fetchers import Fetcher

        def fetch(u):
            return Fetcher.get(u, timeout=25, stealthy_headers=True)
    else:
        from scrapling.fetchers import StealthyFetcher

        def fetch(u):
            return StealthyFetcher.fetch(u, headless=True, network_idle=False, timeout=25000)

    resp = fetch(url)
    status = getattr(resp, "status", 0)
    if status and status >= 400:
        return {"error": f"HTTP {status}"}

    home = payload(resp, url)
    pages = [home]
    for sub in pick_subpages(home["links"], host):
        try:
            r2 = fetch(sub)
            if getattr(r2, "status", 0) and r2.status >= 400:
                continue
            pages.append(payload(r2, sub))
        except Exception:
            pass  # a dead interior page should not sink the facility
    return {"pages": pages}


try:
    print(json.dumps(main()))
except Exception as e:
    print(json.dumps({"error": str(e).split("\n")[0][:180]}))
