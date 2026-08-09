"""Build visually verified customer PDFs from docs/delivery Markdown sources."""

from __future__ import annotations

import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "docs" / "delivery"
OUTPUT_DIR = ROOT / "output" / "pdf"
FONT_PATH = Path(r"C:\Windows\Fonts\msyh.ttc")
FONT_NAME = "MicrosoftYaHei"
NAVY = colors.HexColor("#17365D")
BLUE = colors.HexColor("#2E74B5")
INK = colors.HexColor("#1F2937")
MUTED = colors.HexColor("#667085")
LIGHT_BLUE = colors.HexColor("#E8EEF5")
LIGHT_GRAY = colors.HexColor("#F2F4F7")


def register_fonts():
    if not FONT_PATH.exists():
        raise RuntimeError(f"Missing Chinese font: {FONT_PATH}")
    pdfmetrics.registerFont(TTFont(FONT_NAME, str(FONT_PATH), subfontIndex=0))


def markup(text):
    escaped = html.escape(text.strip())
    escaped = re.sub(r"`([^`]+)`", rf'<font name="{FONT_NAME}" color="#17365D">\1</font>', escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", escaped)
    return escaped


def styles():
    base = getSampleStyleSheet()
    return {
        "body": ParagraphStyle("body", parent=base["BodyText"], fontName=FONT_NAME, fontSize=9.2, leading=13, textColor=INK, spaceAfter=4),
        "meta": ParagraphStyle("meta", parent=base["BodyText"], fontName=FONT_NAME, fontSize=8.5, leading=12, textColor=MUTED, spaceAfter=2),
        "title": ParagraphStyle("title", parent=base["Title"], fontName=FONT_NAME, fontSize=24, leading=31, textColor=NAVY, alignment=TA_LEFT, spaceAfter=6),
        "subtitle": ParagraphStyle("subtitle", parent=base["Heading2"], fontName=FONT_NAME, fontSize=14, leading=20, textColor=BLUE, spaceAfter=14),
        "h1": ParagraphStyle("h1", parent=base["Heading1"], fontName=FONT_NAME, fontSize=14, leading=19, textColor=BLUE, spaceBefore=12, spaceAfter=7, keepWithNext=True),
        "h2": ParagraphStyle("h2", parent=base["Heading2"], fontName=FONT_NAME, fontSize=11.5, leading=16, textColor=NAVY, spaceBefore=9, spaceAfter=5, keepWithNext=True),
        "code": ParagraphStyle("code", parent=base["Code"], fontName="Courier", fontSize=7.5, leading=11, textColor=NAVY, backColor=LIGHT_GRAY, leftIndent=8, rightIndent=8, borderPadding=6, spaceAfter=7),
        "callout": ParagraphStyle("callout", parent=base["BodyText"], fontName=FONT_NAME, fontSize=8.8, leading=13, textColor=NAVY, backColor=LIGHT_GRAY, borderColor=colors.HexColor("#D0D5DD"), borderWidth=0.5, borderPadding=7, spaceBefore=3, spaceAfter=7),
        "cell": ParagraphStyle("cell", parent=base["BodyText"], fontName=FONT_NAME, fontSize=7.8, leading=11, textColor=INK),
        "cell_head": ParagraphStyle("cell_head", parent=base["BodyText"], fontName=FONT_NAME, fontSize=8, leading=11, textColor=NAVY),
    }


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(FONT_NAME, 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.75 * inch, 0.38 * inch, "court-helper  |  客户交付资料")
    canvas.drawRightString(7.75 * inch, 0.38 * inch, f"第 {doc.page} 页")
    canvas.restoreState()


def parse_table(lines, start):
    rows = []
    index = start
    while index < len(lines) and lines[index].strip().startswith("|"):
        rows.append([cell.strip() for cell in lines[index].strip().strip("|").split("|")])
        index += 1
    if len(rows) >= 2 and all(re.fullmatch(r":?-+:?", cell.replace(" ", "")) for cell in rows[1]):
        rows.pop(1)
    return rows, index


def table_flowable(rows, style_map):
    cols = max(len(row) for row in rows)
    usable = 7.0 * inch
    widths = [usable / cols] * cols
    data = []
    for row_index, row in enumerate(rows):
        data.append([
            Paragraph(("<b>" + markup(row[col]) + "</b>") if row_index == 0 else markup(row[col]), style_map["cell_head" if row_index == 0 else "cell"])
            if col < len(row) else Paragraph("", style_map["cell"])
            for col in range(cols)
        ])
    table = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT_BLUE),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#B8C2CC")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def build_pdf(source):
    style_map = styles()
    lines = source.read_text(encoding="utf-8").splitlines()
    headings = [(i, line.lstrip("#").strip()) for i, line in enumerate(lines) if line.startswith("#")]
    product = headings[0][1]
    title = headings[1][1] if len(headings) > 1 else product
    cursor = headings[1][0] + 1 if len(headings) > 1 else headings[0][0] + 1

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output = OUTPUT_DIR / f"{source.stem}.pdf"
    doc = BaseDocTemplate(str(output), pagesize=LETTER, rightMargin=0.75 * inch, leftMargin=0.75 * inch, topMargin=0.65 * inch, bottomMargin=0.62 * inch, title=title, author="court-helper project")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    doc.addPageTemplates(PageTemplate(id="handoff", frames=[frame], onPage=footer))

    story = [Spacer(1, 0.22 * inch), Paragraph("客户交付手册", style_map["meta"]), Paragraph(markup(product), style_map["title"]), Paragraph(markup(title), style_map["subtitle"])]
    while cursor < len(lines) and not lines[cursor].startswith("## "):
        line = lines[cursor].strip().rstrip("  ")
        if line and not line.startswith(">"):
            story.append(Paragraph(markup(line), style_map["meta"]))
        cursor += 1
    story.extend([Spacer(1, 8), Table([[""]], colWidths=[7 * inch], rowHeights=[2], style=TableStyle([("BACKGROUND", (0, 0), (-1, -1), BLUE)])), Spacer(1, 8)])

    in_code = False
    code_lines = []
    bullets = []

    def flush_bullets():
        nonlocal bullets
        if bullets:
            for value in bullets:
                paragraph = ParagraphStyle("bullet_line", parent=style_map["body"], leftIndent=14, firstLineIndent=-10)
                story.append(Paragraph("• " + markup(value), paragraph))
            bullets = []

    index = cursor
    while index < len(lines):
        raw = lines[index]
        stripped = raw.strip()
        if stripped.startswith("```"):
            flush_bullets()
            if in_code:
                story.append(Paragraph("<br/>".join(html.escape(line) or " " for line in code_lines), style_map["code"]))
                code_lines = []
                in_code = False
            else:
                in_code = True
            index += 1
            continue
        if in_code:
            code_lines.append(raw)
            index += 1
            continue
        if not stripped:
            flush_bullets()
            index += 1
            continue
        if stripped.startswith("|"):
            flush_bullets()
            rows, index = parse_table(lines, index)
            story.extend([table_flowable(rows, style_map), Spacer(1, 6)])
            continue
        if stripped.startswith("- ") and not stripped.startswith("- [ ] "):
            bullets.append(stripped[2:])
            index += 1
            continue
        flush_bullets()
        if stripped.startswith(">"):
            story.append(Paragraph(markup(stripped.lstrip("> ")), style_map["callout"]))
        elif raw.startswith("### "):
            story.append(Paragraph(markup(raw[4:]), style_map["h2"]))
        elif raw.startswith("## "):
            story.append(Paragraph(markup(raw[3:]), style_map["h1"]))
        elif re.match(r"^\d+\.\s", stripped):
            number = re.match(r"^(\d+)\.", stripped).group(1)
            content = re.sub(r"^\d+\.\s*", "", stripped)
            story.append(Paragraph(f"<b>{number}.</b> {markup(content)}", style_map["body"]))
        elif stripped.startswith("- [ ] "):
            story.append(Paragraph("□ " + markup(stripped[6:]), style_map["body"]))
        elif not raw.startswith("# "):
            story.append(Paragraph(markup(stripped), style_map["body"]))
        index += 1
    flush_bullets()
    doc.build(story)
    print(output)


def main():
    register_fonts()
    for source in sorted(path for path in SOURCE_DIR.glob("*.md") if path.name != "README.md"):
        build_pdf(source)


if __name__ == "__main__":
    main()
