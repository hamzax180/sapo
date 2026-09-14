"""Souqi — architecture and activity diagrams, drawn from the traced code.

Everything here was read out of the repository rather than assumed: route
names, header names, timeouts, image tags, table names and dependency
versions all match what is in the tree.
"""
from reportlab.lib.pagesizes import A3, landscape
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth
import math

PAGE = landscape(A3)                      # 1190.55 x 841.89 pt
W, H = PAGE

# ---- palette, taken from the product's own tokens -------------------------
INK      = colors.HexColor("#1b252b")
INK2     = colors.HexColor("#4a555c")
MUT      = colors.HexColor("#7c8489")
LINE     = colors.HexColor("#c9c3bc")
PAPER    = colors.HexColor("#faf9f8")
CARD     = colors.HexColor("#ffffff")
PLATFORM = colors.HexColor("#0f6d97")     # the Vercel half
PLANE    = colors.HexColor("#9a5d17")     # the VPS half
BROWSER  = colors.HexColor("#4a555c")
MODEL    = colors.HexColor("#6b4c9a")     # the AI provider
OK       = colors.HexColor("#2c7a58")
BAD      = colors.HexColor("#b2452f")
LANEFILL = [colors.HexColor("#f4f2ef"), colors.HexColor("#fbfaf9")]

F  = "Helvetica"
FB = "Helvetica-Bold"
FO = "Helvetica-Oblique"


# ---------------------------------------------------------------- helpers
def wrap(text, font, size, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if stringWidth(t, font, size) <= maxw:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def box_text(c, cx, cy, w, lines, size, font=F, fill=INK, leading=None):
    leading = leading or size + 2.2
    total = len(lines) * leading
    y = cy + total / 2 - leading + leading * 0.28
    c.setFillColor(fill)
    c.setFont(font, size)
    for ln in lines:
        c.drawCentredString(cx, y, ln)
        y -= leading
    return total


def action(c, cx, cy, w, h, text, sub=None, stroke=INK, fill=CARD, size=8.2, bold=False):
    """UML action: rounded rectangle."""
    c.setStrokeColor(stroke)
    c.setFillColor(fill)
    c.setLineWidth(1.0)
    c.roundRect(cx - w / 2, cy - h / 2, w, h, 5, stroke=1, fill=1)
    lines = wrap(text, FB if bold else F, size, w - 12)
    sublines = wrap(sub, FO, size - 1.1, w - 12) if sub else []
    lead = size + 2.1
    slead = size + 0.9
    total = len(lines) * lead + (len(sublines) * slead + 2 if sublines else 0)
    y = cy + total / 2 - lead + lead * 0.28
    c.setFillColor(INK)
    c.setFont(FB if bold else F, size)
    for ln in lines:
        c.drawCentredString(cx, y, ln)
        y -= lead
    if sublines:
        y -= 1
        c.setFillColor(MUT)
        c.setFont(FO, size - 1.1)
        for ln in sublines:
            c.drawCentredString(cx, y, ln)
            y -= slead


def tech(c, cx, cy, w, h, label, stroke=MUT):
    """A technology annotation: dashed note box."""
    c.setStrokeColor(stroke)
    c.setFillColor(colors.white)
    c.setLineWidth(0.6)
    c.setDash(2, 2)
    c.roundRect(cx - w / 2, cy - h / 2, w, h, 3, stroke=1, fill=1)
    c.setDash()
    box_text(c, cx, cy, w, wrap(label, F, 7, w - 8), 7, fill=stroke)


def decision(c, cx, cy, w, h, text, size=7.6):
    c.setStrokeColor(INK)
    c.setFillColor(colors.HexColor("#fdfcfb"))
    c.setLineWidth(1.0)
    p = c.beginPath()
    p.moveTo(cx, cy + h / 2)
    p.lineTo(cx + w / 2, cy)
    p.lineTo(cx, cy - h / 2)
    p.lineTo(cx - w / 2, cy)
    p.close()
    c.drawPath(p, stroke=1, fill=1)
    box_text(c, cx, cy, w, wrap(text, F, size, w - 26), size)


def start_node(c, cx, cy, r=7):
    c.setFillColor(INK)
    c.setStrokeColor(INK)
    c.circle(cx, cy, r, stroke=0, fill=1)


def end_node(c, cx, cy, r=8):
    c.setStrokeColor(INK)
    c.setFillColor(colors.white)
    c.setLineWidth(1.2)
    c.circle(cx, cy, r, stroke=1, fill=1)
    c.setFillColor(INK)
    c.circle(cx, cy, r - 3.2, stroke=0, fill=1)


def bar(c, cx, cy, w, color=INK):
    """Fork / join bar."""
    c.setFillColor(color)
    c.rect(cx - w / 2, cy - 2.2, w, 4.4, stroke=0, fill=1)


def arrowhead(c, x, y, ang, size=5.0, color=INK):
    c.setFillColor(color)
    p = c.beginPath()
    p.moveTo(x, y)
    p.lineTo(x - size * math.cos(ang - 0.42), y - size * math.sin(ang - 0.42))
    p.lineTo(x - size * math.cos(ang + 0.42), y - size * math.sin(ang + 0.42))
    p.close()
    c.drawPath(p, stroke=0, fill=1)


def arrow(c, x1, y1, x2, y2, label=None, color=INK, dashed=False, lw=1.0,
          lab_side="above", size=7):
    c.setStrokeColor(color)
    c.setLineWidth(lw)
    if dashed:
        c.setDash(3, 2.4)
    c.line(x1, y1, x2, y2)
    c.setDash()
    arrowhead(c, x2, y2, math.atan2(y2 - y1, x2 - x1), color=color)
    if label:
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        c.setFont(F, size)
        c.setFillColor(color)
        tw = stringWidth(label, F, size)
        if abs(x2 - x1) > abs(y2 - y1):        # horizontal
            oy = 4 if lab_side == "above" else -(size + 2)
            c.setFillColor(colors.white)
            c.rect(mx - tw / 2 - 2, my + oy - 1.5, tw + 4, size + 1, stroke=0, fill=1)
            c.setFillColor(color)
            c.drawCentredString(mx, my + oy, label)
        else:                                   # vertical
            c.setFillColor(colors.white)
            c.rect(mx + 5, my - 3, tw + 4, size + 1, stroke=0, fill=1)
            c.setFillColor(color)
            c.drawString(mx + 7, my - 2, label)


def elbow(c, pts, label=None, color=INK, dashed=False, lw=1.0, size=7):
    """Orthogonal polyline with an arrowhead at the last point."""
    c.setStrokeColor(color)
    c.setLineWidth(lw)
    if dashed:
        c.setDash(3, 2.4)
    p = c.beginPath()
    p.moveTo(*pts[0])
    for pt in pts[1:]:
        p.lineTo(*pt)
    c.drawPath(p, stroke=1, fill=0)
    c.setDash()
    (x1, y1), (x2, y2) = pts[-2], pts[-1]
    arrowhead(c, x2, y2, math.atan2(y2 - y1, x2 - x1), color=color)
    if label:
        mx, my = pts[0][0], pts[0][1]
        for i in range(len(pts) - 1):
            if abs(pts[i + 1][0] - pts[i][0]) > 40:
                mx, my = (pts[i][0] + pts[i + 1][0]) / 2, pts[i][1]
                break
        c.setFont(F, size)
        tw = stringWidth(label, F, size)
        c.setFillColor(colors.white)
        c.rect(mx - tw / 2 - 2, my + 3, tw + 4, size + 1, stroke=0, fill=1)
        c.setFillColor(color)
        c.drawCentredString(mx, my + 4.5, label)


def page_frame(c, title, subtitle, n, total):
    c.setFillColor(PAPER)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(INK)
    c.setFont(FB, 19)
    c.drawString(28 * mm, H - 22 * mm, title)
    c.setFillColor(MUT)
    c.setFont(F, 9.6)
    c.drawString(28 * mm, H - 28.4 * mm, subtitle)
    c.setStrokeColor(LINE)
    c.setLineWidth(0.8)
    c.line(28 * mm, H - 31.5 * mm, W - 28 * mm, H - 31.5 * mm)
    c.setFillColor(MUT)
    c.setFont(F, 7.6)
    c.drawString(28 * mm, 12 * mm, "Souqi  ·  architecture and activity reference  ·  traced from the repository")
    c.drawRightString(W - 28 * mm, 12 * mm, "%d / %d" % (n, total))


def lanes(c, x0, y0, w, h, names, colors_):
    """Swimlane columns. Returns list of lane centre x."""
    lw = w / len(names)
    cxs = []
    for i, nm in enumerate(names):
        x = x0 + i * lw
        c.setFillColor(LANEFILL[i % 2])
        c.setStrokeColor(LINE)
        c.setLineWidth(0.7)
        c.rect(x, y0, lw, h, stroke=1, fill=1)
        c.setFillColor(colors_[i])
        c.rect(x, y0 + h - 17, lw, 17, stroke=0, fill=1)
        c.setFillColor(colors.white)
        c.setFont(FB, 8.6)
        c.drawCentredString(x + lw / 2, y0 + h - 12, nm.upper())
        cxs.append(x + lw / 2)
    return cxs, lw


def table(c, x, y, widths, header, rows, size=8.2, rowh=17, head_color=None):
    """Left-aligned data table. Returns the y of the last row's baseline."""
    head_color = head_color or MUT
    cx = x
    c.setFont(FB, 7.0)
    c.setFillColor(head_color)
    for w, h in zip(widths, header):
        c.drawString(cx + 3, y, h.upper())
        cx += w
    total = sum(widths)
    c.setStrokeColor(LINE)
    c.setLineWidth(0.9)
    c.line(x, y - 5, x + total, y - 5)
    yy = y - 5
    for r in rows:
        yy -= rowh
        cx = x
        for w, cell in zip(widths, r):
            bold = cell.startswith("*")
            txt = cell[1:] if bold else cell
            c.setFont(FB if bold else F, size)
            c.setFillColor(INK if bold else INK2)
            for ln in wrap(txt, FB if bold else F, size, w - 8)[:2]:
                c.drawString(cx + 3, yy, ln)
                yy -= size + 1.6
                cx_done = True
            yy += size + 1.6
            cx += w
        c.setStrokeColor(LINE)
        c.setLineWidth(0.4)
        c.line(x, yy - 5, x + total, yy - 5)
    return yy


def note(c, x, y, w, title, body, color=None):
    """A titled note block with a coloured rule down its left edge."""
    color = color or PLANE
    lines = wrap(body, F, 8.4, w - 14)
    h = 15 + len(lines) * 11.4
    c.setStrokeColor(color)
    c.setLineWidth(2)
    c.line(x, y + 4, x, y - h + 8)
    c.setFont(FB, 7.0)
    c.setFillColor(color)
    c.drawString(x + 9, y, title.upper())
    c.setFont(F, 8.4)
    c.setFillColor(INK2)
    yy = y - 12
    for ln in lines:
        c.drawString(x + 9, yy, ln)
        yy -= 11.4
    return yy


def legend_chip(c, x, y, kind, label):
    if kind == "action":
        c.setStrokeColor(INK); c.setFillColor(CARD); c.setLineWidth(1)
        c.roundRect(x, y - 9, 44, 18, 4, stroke=1, fill=1)
    elif kind == "decision":
        c.setStrokeColor(INK); c.setFillColor(colors.HexColor("#fdfcfb")); c.setLineWidth(1)
        p = c.beginPath(); p.moveTo(x + 22, y + 10); p.lineTo(x + 44, y)
        p.lineTo(x + 22, y - 10); p.lineTo(x, y); p.close()
        c.drawPath(p, stroke=1, fill=1)
    elif kind == "start":
        start_node(c, x + 22, y)
    elif kind == "end":
        end_node(c, x + 22, y)
    elif kind == "bar":
        bar(c, x + 22, y, 44)
    c.setFont(F, 8)
    c.setFillColor(INK2)
    c.drawString(x + 52, y - 3, label)
