#!/usr/bin/env python3
"""校验导出 xlsx 的图片锚点（openpyxl 读回 + editAs 兼容）。

用法: python scripts/verify-export.py <xlsx>
输出 JSON: {"sheets": [...], "media_count": N, "image_count": N, "anchors": [{"col": c, "row": r}, ...]}
无图片或图片与 media 文件数不一致时退出码非 0（带图验证失败）。

兼容说明: openpyxl 3.1.5 解析带 editAs 属性的 oneCellAnchor/twoCellAnchor 会抛
TypeError（_AnchorBase.__init__ 不接受该参数），而 ExcelJS 生成的锚点默认带
editAs="oneCell"。本脚本在交给 openpyxl 解析前先剥离该属性；editAs 只影响
编辑器拖拽行为，不影响图片位置与内容。
"""
import json
import re
import sys
import zipfile

from openpyxl.drawing.spreadsheet_drawing import SpreadsheetDrawing
from openpyxl.xml.functions import fromstring


def parse_drawing_anchors(path):
    """解析所有 drawing 中图片锚点（0 基 col/row）。"""
    with zipfile.ZipFile(path) as z:
        drawing_names = sorted(
            n for n in z.namelist() if re.match(r"xl/drawings/drawing\d+\.xml$", n)
        )
        anchors = []
        for dn in drawing_names:
            src = z.read(dn).decode("utf-8")
            src = re.sub(r'\seditAs="[^"]*"', "", src)  # openpyxl 3.1.5 兼容
            drawing = SpreadsheetDrawing.from_tree(fromstring(src.encode("utf-8")))
            for rel in drawing._blip_rels:
                frm = rel.anchor._from
                anchors.append({"col": frm.col, "row": frm.row})
        return anchors


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "用法: verify-export.py <xlsx>"}, ensure_ascii=False))
        sys.exit(2)
    path = sys.argv[1]
    with zipfile.ZipFile(path) as z:
        wb_xml = z.read("xl/workbook.xml").decode("utf-8")
        sheets = re.findall(r'<sheet[^>]*name="([^"]*)"', wb_xml)
        media_count = len([n for n in z.namelist() if n.startswith("xl/media/") and not n.endswith("/")])
    anchors = parse_drawing_anchors(path)
    out = {"sheets": sheets, "media_count": media_count, "image_count": len(anchors), "anchors": anchors}
    print(json.dumps(out, ensure_ascii=False))
    ok = out["image_count"] > 0 and out["image_count"] == out["media_count"]
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
