#!/usr/bin/env python3
"""UI regression check: the current dashboard against the protected baseline.

The protected client code (branch signal-lab-ui-protected) is exported to a temporary folder and served next to the
current one. Both read the same API, so live data can't cause a false difference. The check only loads pages and
switches coin and interval: it places no orders and changes no data.

It compares element structure, computed styles, positions, sizes and page height at desktop and mobile widths, checks
that protected files match byte for byte, then checks the globe, charts, ticker and navigation.

Run the API and client first (npm run server, npm run client), then:

    python scripts/ui_regression.py                 compare, exit code 0 means identical
    python scripts/ui_regression.py --record DIR    also save baseline screenshots, structure and design files

Requires Python Playwright with Chrome, and Pillow.
"""
import argparse
import hashlib
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageChops
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
BRANCH = "signal-lab-ui-protected"
BASELINE_URL = None  # set once a free port is chosen
VIEWPORTS = [("desktop", 1440, 900), ("mobile", 390, 844)]
MAX_PIXEL_DIFF_PCT = 1.0  # live prices and candles legitimately differ between the two page loads
ATTEMPTS = 3

# Read-only without explicit approval. These must match the protected branch byte for byte.
PROTECTED_FILES = [
    "client/index.html",
    "client/postcss.config.js",
    "client/tailwind.config.js",
    "client/src/main.jsx",
    "client/src/App.jsx",
    "client/src/index.css",
    "client/src/coins.js",
    "client/src/format.js",
    "client/src/lib.js",
    "client/src/market.js",
    "client/src/metrics.js",
    "client/src/components/Analysis.jsx",
    "client/src/components/Backtest.jsx",
    "client/src/components/Charts.jsx",
    "client/src/components/FilamentTorus.jsx",
    "client/src/components/Insights.jsx",
    "client/src/components/Market.jsx",
    "client/src/components/Paper.jsx",
]
# Changes the owner explicitly approved. The file must equal the baseline once this exact text is taken out.
APPROVED_ADDITIONS = {
    "client/src/App.jsx": '<a data-lab-link href="/lab.html" aria-label="Intelligence Lab" className="absolute ml-2 mt-1 whitespace-nowrap rounded border border-cyan-neon/60 px-1 text-[11px] font-normal leading-5 text-cyan-neon md:ml-3 md:px-2"><span className="hidden md:inline">Intelligence </span>Lab</a>',
}
DESIGN_FILES = ["client/src/index.css", "client/tailwind.config.js", "client/postcss.config.js", "client/index.html"]

NO_WEBGL = "const g=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,...a){return /webgl/.test(t)?null:g.call(this,t,...a)};"
FREEZE = "*,*::before,*::after{animation:none!important;transition:none!important}"
SNAPSHOT = """() => {
  const rect = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)]; };
  const style = (e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.backgroundImage, c.borderTopColor, c.fontFamily, c.fontSize, c.fontWeight, c.letterSpacing, c.lineHeight, c.borderRadius, c.padding, c.margin, c.boxShadow, c.position, c.display]; };
  const all = [...document.body.querySelectorAll('*')].filter((e) => !['CANVAS', 'SCRIPT', 'STYLE'].includes(e.tagName) && !e.closest('table') && !e.closest('[data-lab-link]'));
  return {
    elements: all.length,
    structure: all.map((e) => e.tagName + '.' + (e.getAttribute('class') || '')),
    styles: all.map(style),
    rects: all.map(rect),
    charts: [...document.querySelectorAll('.tv-lightweight-charts')].map(rect),
    body: [getComputedStyle(document.body).backgroundImage, getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).fontFamily],
    pageHeight: document.documentElement.scrollHeight,
  };
}"""
FPS = "ms => new Promise(r=>{let n=0,s=performance.now();(function f(){n++;performance.now()-s<ms?requestAnimationFrame(f):r(n/(ms/1000))})()})"
GPU_ARGS = ["--headless=new", "--enable-gpu", "--ignore-gpu-blocklist"] + (["--use-angle=d3d11"] if os.name == "nt" else [])


def git(*args):
    return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, check=True)


class Baseline:
    """Serves the protected client code from a temporary folder."""

    def __enter__(self):
        global BASELINE_URL
        with socket.socket() as s:  # a free port, so other apps on this machine are left alone
            s.bind(("localhost", 0))
            port = s.getsockname()[1]
        BASELINE_URL = f"http://localhost:{port}"
        self.tmp = Path(tempfile.mkdtemp(prefix="signal-lab-baseline-"))
        with tarfile.open(fileobj=io.BytesIO(git("archive", BRANCH, "client").stdout)) as t:
            t.extractall(self.tmp, filter="data")
        self.link = self.tmp / "client" / "node_modules"
        target = REPO / "client" / "node_modules"
        if os.name == "nt":
            subprocess.run(["cmd", "/c", "mklink", "/J", str(self.link), str(target)], check=True, capture_output=True)
        else:
            self.link.symlink_to(target)
        self.proc = subprocess.Popen(
            ["node", "node_modules/vite/bin/vite.js", "--port", str(port), "--strictPort"],
            cwd=self.tmp / "client", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(60):
            if self.proc.poll() is not None:
                raise RuntimeError(f"Could not serve the baseline on port {port}")
            try:
                urllib.request.urlopen(BASELINE_URL, timeout=2)
                return self
            except OSError:
                time.sleep(1)
        raise RuntimeError("The baseline server did not start")

    def __exit__(self, *_):
        self.proc.terminate()
        self.proc.wait(timeout=15)
        # remove the link first: it must never be followed into the real node_modules
        if os.name == "nt":
            subprocess.run(["cmd", "/c", "rmdir", str(self.link)], check=True, capture_output=True)
        else:
            self.link.unlink()
        if not self.link.exists():
            shutil.rmtree(self.tmp, ignore_errors=True)


def open_dashboard(browser, url, width, height, webgl=False):
    page = browser.new_page(viewport={"width": width, "height": height})
    if not webgl:
        page.add_init_script(NO_WEBGL)
    page.goto(url, wait_until="load")
    page.add_style_tag(content=FREEZE)
    page.wait_for_selector("[data-signal]", timeout=120000)
    page.wait_for_selector("[data-insight=buyers]", timeout=60000)
    page.wait_for_selector("text=Run backtest", timeout=30000)
    try:
        page.wait_for_selector("text=Account equity", timeout=15000)
    except PlaywrightTimeout:
        pass  # the equity chart only appears once the account has two or more records
    page.wait_for_timeout(4000)
    return page


def snapshot(browser, url, width, height):
    page = open_dashboard(browser, url, width, height)
    data = page.evaluate(SNAPSHOT)
    data["shot"] = page.screenshot(full_page=True)
    page.close()
    return data


def differences(a, b):
    found = []
    if a["body"] != b["body"]:
        found.append("page background or font changed")
    if a["pageHeight"] != b["pageHeight"]:
        found.append(f"page height {a['pageHeight']} -> {b['pageHeight']}")
    if a["charts"] != b["charts"]:
        found.append(f"chart position or size {a['charts']} -> {b['charts']}")
    if a["structure"] != b["structure"]:
        extra = sorted(set(b["structure"]) - set(a["structure"]))
        gone = sorted(set(a["structure"]) - set(b["structure"]))
        found.append(f"structure changed ({a['elements']} -> {b['elements']} elements); added: {[x[:70] for x in extra[:3]]}; removed: {[x[:70] for x in gone[:3]]}")
        return found
    style = [i for i, (x, y) in enumerate(zip(a["styles"], b["styles"])) if x != y]
    rect = [i for i, (x, y) in enumerate(zip(a["rects"], b["rects"])) if x != y]
    if style:
        found.append(f"{len(style)} elements with a changed style, first: {a['structure'][style[0]][:70]}")
    if rect:
        i = rect[0]
        found.append(f"{len(rect)} elements moved or resized, first: {a['structure'][i][:70]} {a['rects'][i]} -> {b['rects'][i]}")
    return found


def pixel_diff_pct(a, b):
    x = Image.open(io.BytesIO(a)).convert("L")
    y = Image.open(io.BytesIO(b)).convert("L")
    if x.size != y.size:
        return None
    hist = ImageChops.difference(x, y).histogram()
    return sum(hist[40:]) / sum(hist) * 100


def check_layout(browser, current_url, out):
    ok = True
    for name, width, height in VIEWPORTS:
        for attempt in range(1, ATTEMPTS + 1):
            base = snapshot(browser, BASELINE_URL, width, height)
            now = snapshot(browser, current_url, width, height)
            problems = differences(base, now)
            pct = pixel_diff_pct(base["shot"], now["shot"])
            if pct is not None and pct > MAX_PIXEL_DIFF_PCT:
                problems.append(f"{pct:.2f}% of pixels differ (limit {MAX_PIXEL_DIFF_PCT}%)")
            if not problems:
                break
        (out / f"baseline-{name}.png").write_bytes(base["shot"])
        (out / f"current-{name}.png").write_bytes(now["shot"])
        label = f"{name} {width}x{height}: {now['elements']} elements, page height {now['pageHeight']}"
        if problems:
            ok = False
            print(f"  FAIL {label}")
            for p in problems:
                print(f"       {p}")
        else:
            print(f"  ok   {label}: structure, style and position identical, {pct:.3f}% of pixels differ (live data)")
    return ok


def check_globe(browser, current_url):
    ok = True
    for name, url in [("baseline", BASELINE_URL), ("current", current_url)]:
        page = open_dashboard(browser, url, 1440, 900, webgl=True)
        canvas = page.locator("canvas[data-torus]")
        labels = page.locator("[data-coin-label]").count()
        first = Image.open(io.BytesIO(canvas.screenshot())).convert("L")
        spot1 = page.locator("[data-coin-label]").first.get_attribute("style")
        page.wait_for_timeout(2000)
        second = Image.open(io.BytesIO(canvas.screenshot())).convert("L")
        spot2 = page.locator("[data-coin-label]").first.get_attribute("style")
        hist = ImageChops.difference(first, second).histogram()
        moved = sum(hist[17:]) / sum(hist) * 100
        fps = page.evaluate(FPS, 4000)
        good = labels == 10 and moved > 1 and spot1 != spot2
        ok = ok and good
        print(f"  {'ok  ' if good else 'FAIL'} {name} globe: {labels} labels, {moved:.1f}% of pixels moved in 2s, labels tracking: {spot1 != spot2}, {fps:.0f} fps")
        page.close()
    return ok


def check_navigation(browser, current_url):
    page = open_dashboard(browser, current_url, 1440, 900)
    results = []
    coins = page.locator("[data-coin]")
    results.append(("10 coins in the selector", coins.count() == 10))
    results.append(("every coin shows a price", all(p.inner_text().strip() not in ("", "—") for p in page.locator("[data-coin] [data-price]").all())))
    before = [p.inner_text() for p in page.locator("[data-coin] [data-price]").all()]
    page.wait_for_timeout(12000)
    after = [p.inner_text() for p in page.locator("[data-coin] [data-price]").all()]
    changed = sum(x != y for x, y in zip(before, after))
    results.append((f"ticker is live ({changed} of 10 prices changed in 12s)", changed >= 1))
    results.append(("price, RSI and MACD charts drawn", page.locator(".tv-lightweight-charts").count() >= 3))
    page.locator("[data-coin=SOLUSDT]").click()
    page.wait_for_selector("text=Solana · SOL/USDT", timeout=30000)
    results.append(("selecting a coin updates the chart", True))
    page.get_by_role("button", name="4h", exact=True).click()
    page.wait_for_selector("text=SOL/USDT · 4h", timeout=30000)
    results.append(("switching interval updates the chart", True))
    page.close()
    for text, good in results:
        print(f"  {'ok  ' if good else 'FAIL'} {text}")
    return all(good for _, good in results)


def record(browser, target):
    target.mkdir(parents=True, exist_ok=True)
    for name, width, height in VIEWPORTS:
        page = open_dashboard(browser, BASELINE_URL, width, height, webgl=True)
        page.wait_for_timeout(1500)
        page.screenshot(path=str(target / f"baseline-{name}-{width}x{height}.png"), full_page=True)
        page.close()
        data = snapshot(browser, BASELINE_URL, width, height)
        data.pop("shot")
        (target / f"structure-{name}.json").write_text(json.dumps(data), encoding="utf8")
        print(f"  recorded {name}: {data['elements']} elements, page height {data['pageHeight']}")
    design = target / "design-files"
    design.mkdir(exist_ok=True)
    lines = []
    for path in DESIGN_FILES:
        content = git("show", f"{BRANCH}:{path}").stdout
        (design / Path(path).name).write_bytes(content)
        lines.append(f"{hashlib.sha256(content).hexdigest()}  {path}")
    for path in PROTECTED_FILES:
        if path not in DESIGN_FILES:
            lines.append(f"{hashlib.sha256(git('show', f'{BRANCH}:{path}').stdout).hexdigest()}  {path}")
    (target / "protected-files.sha256").write_text("\n".join(lines) + "\n", encoding="utf8")
    print(f"  recorded {len(lines)} protected file hashes and {len(DESIGN_FILES)} design files")


def is_approved(path):
    """True if the only difference from the baseline is the exact text the owner approved, used once."""
    addition = APPROVED_ADDITIONS.get(path)
    if not addition:
        return False
    current = (REPO / path).read_text(encoding="utf8").replace("\r\n", "\n")
    baseline = git("show", f"{BRANCH}:{path}").stdout.decode("utf8").replace("\r\n", "\n")
    return current.count(addition) == 1 and current.replace(addition, "") == baseline


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--current", default="http://localhost:5173", help="the running dashboard to check")
    parser.add_argument("--record", type=Path, help="save the baseline record to this new folder, without overwriting")
    parser.add_argument("--out", type=Path, help="where to save comparison screenshots")
    args = parser.parse_args()
    if args.record and args.record.exists() and any(args.record.iterdir()):
        sys.exit(f"{args.record} already holds a record, and the protected baseline must not be overwritten")
    out = args.out or Path(tempfile.mkdtemp(prefix="signal-lab-ui-check-"))
    out.mkdir(parents=True, exist_ok=True)

    print(f"Protected baseline: {BRANCH} at {git('rev-parse', '--short', BRANCH).stdout.decode().strip()}")
    print("Protected files")
    changed = git("diff", "--name-only", BRANCH, "--", *PROTECTED_FILES).stdout.decode().split()
    approved = [path for path in changed if is_approved(path)]
    changed = [path for path in changed if path not in approved]
    for path in approved:
        print(f"  ok   {path} differs only by its approved addition")
    if changed:
        print(f"  FAIL {len(changed)} of {len(PROTECTED_FILES)} differ from the baseline:")
        for path in changed:
            print(f"       {path}")
    else:
        print(f"  ok   the other {len(PROTECTED_FILES) - len(approved)} match the baseline byte for byte")

    with Baseline(), sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=GPU_ARGS)
        if args.record:
            print("Recording the baseline")
            record(browser, args.record)
        print("Layout and styling, baseline vs current, same data")
        layout = check_layout(browser, args.current, out)
        print("Globe animation")
        globe = check_globe(browser, args.current)
        print("Navigation, charts and ticker")
        navigation = check_navigation(browser, args.current)
        browser.close()

    passed = not changed and layout and globe and navigation
    print(f"Screenshots: {out}")
    print("RESULT: PASS, the dashboard is identical to the protected baseline" if passed else "RESULT: FAIL, the dashboard differs from the protected baseline")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
