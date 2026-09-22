"""X / OGP カード用の画像 og.png (1200x675) を作る。

    python tools/make_og.py

ゲームの描画関数 (src/render.js) で「充電帯を大ジャンプ中・ゲージ 7 段・ドローンと柱が迫る」
場面を組んで 240x135 に描き、最近傍で 5 倍に拡大する。上にタイトル文字を重ねる。
"""
import base64
import functools
import http.server
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D401 - 配信ログは出さない
        pass


httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()

JS = """
async () => {
  const core = await import('/src/core.js');
  const { render } = await import('/src/render.js');
  const s = core.createState(0);
  s.phase = 'playing';
  s.onGround = false;
  s.playerY = 36;           // 帯の上寄り (充電が速い高さ)
  s.charging = true;
  s.chargeRate = 1.45;
  s.gauge = 7;
  s.score = 740;
  s.animMs = 1234;
  s.scroll = 10;
  s.obstacles = [
    { air: true,  x: 96,  y: 31, w: 16, h: 8 },
    { air: true,  x: 170, y: 52, w: 14, h: 9 },
    { air: false, x: 132, y: 88, w: 9,  h: 24 },
    { air: false, x: 214, y: 96, w: 8,  h: 16 },
  ];
  const small = document.createElement('canvas');
  small.width = core.SCREEN_W; small.height = core.SCREEN_H;
  s.runStartMs = s.animMs - 17400;  // HUD の TIME を 17.4 秒に見せる
  render(small.getContext('2d'), s, { clearScore: core.CLEAR_SCORE });

  const big = document.createElement('canvas');
  big.width = 1200; big.height = 675;
  const g = big.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(small, 0, 0, 1200, 675);
  // 下の地面帯にタイトルを重ねる (ゲーム情報が無い領域)
  g.fillStyle = 'rgba(0,0,0,0.72)';
  g.fillRect(0, 575, 1200, 100);
  g.textBaseline = 'middle';
  g.font = 'bold 56px ui-monospace, Consolas, monospace';
  g.fillStyle = '#3cd2eb';
  g.fillText('CHARGE RUN', 40, 625);
  g.font = 'bold 34px "Yu Gothic UI", "Meiryo", sans-serif';
  g.fillStyle = '#ebebf0';
  const sub = '1キーの避けゲー / 1000点まで何秒？';
  const w = g.measureText(sub).width;
  g.fillText(sub, 1160 - w, 627);
  return big.toDataURL('image/png');
}
"""

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.goto(f"http://localhost:{port}/index.html")
    data = page.evaluate(JS)
    b.close()
httpd.shutdown()

out = ROOT / "og.png"
out.write_bytes(base64.b64decode(data.split(",", 1)[1]))
print(out, out.stat().st_size, "bytes")
