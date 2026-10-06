#!/usr/bin/env python3
"""
產生 dashboard/gas/Dashboard.gs —— 貼進 Apps Script 的「唯一一個檔案」。

來源：dashboard/app/Code.template.gs（伺服器）＋ dashboard/app/Page.html（頁面）。
頁面以 JSON 字串打包進 PAGE_HTML，所以 Apps Script 專案裡不需要另建 HTML 檔，
也不會從 repo 動態讀頁面（改版必須重新貼上＋部署新版本 = Cross 手動把關）。

    python3 dashboard/build_gas.py
"""

import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "app" / "Code.template.gs"
PAGE = HERE / "app" / "Page.html"
OUT = HERE / "gas" / "Dashboard.gs"

BANNED_IN_PAGE = [
    (r"\.innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(", "把字串當 HTML／程式執行"),
    (r"<script[^>]+src=", "載入外部腳本"),
    (r"<link[^>]+href=\"https?:", "載入外部樣式"),
    (r"userID|liveStreamID", "主播 ID 欄位"),
]


def main():
    page = PAGE.read_text(encoding="utf-8")
    for pat, why in BANNED_IN_PAGE:
        m = re.search(pat, page)
        if m:
            raise SystemExit(f"Page.html 不合格（{why}）：{m.group(0)}")
    code = SRC.read_text(encoding="utf-8")
    assert code.count("__PAGE_HTML__") == 1
    blob = json.dumps(page, ensure_ascii=False).replace("</", "<\\/")
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(code.replace("__PAGE_HTML__", blob), encoding="utf-8")
    print(f"wrote {OUT.relative_to(HERE.parent)}  ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
