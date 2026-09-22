"""チャージ・ラン Web 版の E2E 確認。

    python tools/e2e.py [出力ディレクトリ]

ローカル HTTP サーバーで配信し、?goal=N で目標点を下げてクリアまで遊ぶ。
確かめること:
  1. タイトル → 開始 → 充電帯で加点 → クリアで X ポストのパネルが出る
  2. ポストのリンク先が x.com/intent/post で、本文にクリアタイム・URL・ハッシュタグが入る
  3. クリア直後 (CLEAR_LOCK_MS 以内) のキーでは再開しない / 過ぎれば再開してパネルが消える
  3b. ミスでも結果パネルとポストが出る (見出しは CRASH でない・本文は記録+挑戦の一文)。即再開は保つ
  4. スマホ幅でタップ操作でも開始・ジャンプできる
  5. 公開先相当 (localhost 以外) では ?goal が効かない … これはホスト名依存なので本番で目視
"""
import functools
import http.server
import socketserver
import sys
import threading
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tools" / "out"
OUT.mkdir(parents=True, exist_ok=True)

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # 配信ログは出さない
        pass


httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://localhost:{port}/index.html"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def state(page):
    return page.evaluate(
        "() => { const s = window.__chargerun.state; return {phase: s.phase, score: s.score, clearMs: s.clearMs, rush: s.rushCount}; }"
    )


def play_until_end(page, hold_key, release_key, limit_ms=20000):
    """大ジャンプを繰り返して帯に入り続ける。クリアかミスで止める。"""
    t = 0
    while t < limit_ms:
        hold_key()
        page.wait_for_timeout(260)  # BIG_HOLD_MS (120ms) を越えて押し続ける = 大ジャンプ
        release_key()
        page.wait_for_timeout(520)
        t += 780
        st = state(page)
        if st["phase"] in ("clear", "over"):
            return st
    return state(page)


errors: list[str] = []
with sync_playwright() as p:
    browser = p.chromium.launch()

    # --- デスクトップ: キーボード ---
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(BASE + "?goal=60")
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / "01-title.png"))
    check("タイトル表示でクリアパネルは隠れている", page.locator("#result-panel").is_hidden())
    check("目標点の表示が ?goal を反映", page.locator("#goal").inner_text() == "60")

    page.locator("#game").focus()
    page.keyboard.down("Space")
    page.wait_for_timeout(60)
    page.keyboard.up("Space")
    page.wait_for_timeout(100)
    check("キーで開始", state(page)["phase"] == "playing", str(state(page)))

    # 何度か挑戦する (ドローンに当たることがあるので)
    st = None
    for attempt in range(8):
        st = play_until_end(page, lambda: page.keyboard.down("Space"), lambda: page.keyboard.up("Space"))
        if st["phase"] == "clear":
            break
        page.wait_for_timeout(500)
        page.keyboard.press("Space")
        page.wait_for_timeout(100)
    check("充電帯で加点してクリアに届く", st["phase"] == "clear", str(st))

    if st["phase"] == "clear":
        page.wait_for_timeout(150)
        page.screenshot(path=str(OUT / "02-clear.png"))
        check("クリアでポストパネルが出る", page.locator("#result-panel").is_visible())
        href = page.locator("#post-x").get_attribute("href") or ""
        u = urllib.parse.urlparse(href)
        q = urllib.parse.parse_qs(u.query)
        text = q.get("text", [""])[0]
        check("リンク先が x.com/intent/post", u.netloc == "x.com" and u.path == "/intent/post", href[:80])
        check("本文に到達タイムと挑戦の一文",
              f"60点到達 {st['clearMs'] / 1000:.1f}秒" in text and "何秒で届く" in text, text.replace("\n", " / "))
        check("本文にハッシュタグ", "#チャージラン" in text)
        check("url パラメータが公開 URL", q.get("url", [""])[0] == "https://cosara22.github.io/chargerun/")
        check("新しいタブで開く", page.locator("#post-x").get_attribute("target") == "_blank")
        check("クリア画面の要約に自己ベスト表記", "自己ベスト" in page.locator("#result-summary").inner_text())

        # クリア直後の誤爆防止
        page.locator("#game").focus()
        page.keyboard.press("Space")
        page.wait_for_timeout(80)
        check("クリア直後のキーでは再開しない", state(page)["phase"] == "clear", str(state(page)))
        page.wait_for_timeout(1300)
        page.keyboard.press("Space")
        page.wait_for_timeout(100)
        check("ロック後のキーで再開しパネルが消える",
              state(page)["phase"] == "playing" and page.locator("#result-panel").is_hidden(), str(state(page)))
        best_clear = page.evaluate("() => localStorage.getItem('chargerun.bestClearMs')")
        check("ベストタイムを保存", best_clear is not None and float(best_clear) > 0, str(best_clear))
    page.close()

    # --- ミス時: 失敗感を出さず、記録として X にポストできる ---
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "?goal=100000")  # 届かない目標にしてミスで終わらせる
    page.wait_for_timeout(300)
    page.locator("#game").focus()
    page.keyboard.press("Space")
    # 押さずに放置すれば最初の柱に当たる
    for _ in range(60):
        page.wait_for_timeout(200)
        if state(page)["phase"] == "over":
            break
    st = state(page)
    check("放置でミスになる", st["phase"] == "over", str(st))
    page.wait_for_timeout(200)
    page.screenshot(path=str(OUT / "05-over.png"))
    check("ミスでも結果パネルとポストボタンが出る",
          page.locator("#result-panel").is_visible() and page.locator("#post-x").is_visible())
    label = page.locator("#result-label").inner_text()
    check("見出しが CRASH でない", label in ("NEW BEST!", "SO CLOSE!", "NICE RUN"), label)
    href = page.locator("#post-x").get_attribute("href") or ""
    text = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("text", [""])[0]
    check("ミスのポスト本文に走った秒数と挑戦の一文", "秒 走って" in text and "あなたは届く？" in text,
          text.replace("\n", " / "))
    check("ミスのポスト本文にハッシュタグ", "#チャージラン" in text)
    page.wait_for_timeout(400)
    page.keyboard.press("Space")
    page.wait_for_timeout(100)
    check("ミス後もキーで即再開しパネルが消える",
          state(page)["phase"] == "playing" and page.locator("#result-panel").is_hidden(), str(state(page)))
    page.close()

    # --- スマホ: タップ ---
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=3)
    m = ctx.new_page()
    m.on("pageerror", lambda e: errors.append(str(e)))
    m.goto(BASE + "?goal=60")
    m.wait_for_timeout(300)
    box = m.locator("#game").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    m.touchscreen.tap(cx, cy)
    m.wait_for_timeout(100)
    check("タップで開始", state(m)["phase"] == "playing", str(state(m)))

    # 実タッチの長押しで大ジャンプになるか (CDP で touchStart → 260ms → touchEnd)
    cdp = ctx.new_cdp_session(m)
    m.wait_for_timeout(400)  # 開始タップの小ジャンプが着地するのを待つ
    pt = [{"x": cx, "y": cy}]
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pt})
    m.wait_for_timeout(260)
    big = m.evaluate("() => window.__chargerun.state.bigApplied")
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    check("実タッチの長押しで大ジャンプ", big is True, f"bigApplied={big}")
    m.wait_for_timeout(900)
    # 長押し = pointer を押し続ける (touchscreen API は長押しを持たないので mouse で代用)
    st = None
    for attempt in range(8):
        st = play_until_end(m, lambda: (m.mouse.move(cx, cy), m.mouse.down()), lambda: m.mouse.up())
        if st["phase"] == "clear":
            break
        m.wait_for_timeout(500)
        m.touchscreen.tap(cx, cy)
        m.wait_for_timeout(100)
    check("スマホ幅でもクリアできる", st["phase"] == "clear", str(st))
    m.wait_for_timeout(150)
    m.screenshot(path=str(OUT / "03-mobile-clear.png"), full_page=True)
    check("スマホ幅でポストボタンが見える", m.locator("#post-x").is_visible())
    ctx.close()

    browser.close()

httpd.shutdown()
check("コンソール/ページエラーなし", not errors, "; ".join(errors[:3]))
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} PASS")
sys.exit(1 if failed else 0)
