# -*- coding: utf-8 -*-
"""生成 BPFlow 扩展图标：渐变圆角方块 + 「译」字（4x 超采样抗锯齿）"""
import os
from PIL import Image, ImageDraw, ImageFont

C1 = (91, 140, 255)    # #5b8cff 靛蓝
C2 = (160, 92, 255)    # #a05cff 紫

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")


def find_font(size):
    candidates = [
        r"C:\Windows\Fonts\msyhbd.ttc",   # 微软雅黑 Bold
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\simsun.ttc",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def make(size, out_path):
    S = size * 4  # 超采样
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # 垂直渐变
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / (S - 1)
        gd.line([(0, y), (S, y)], fill=(
            int(C1[0] + (C2[0] - C1[0]) * t),
            int(C1[1] + (C2[1] - C1[1]) * t),
            int(C1[2] + (C2[2] - C1[2]) * t),
            255,
        ))

    # 圆角遮罩
    radius = int(S * 0.22)
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    # 顶部柔和高光（叠一层低透明度白色）
    hl_mask = Image.new("L", (S, S), 0)
    hd = ImageDraw.Draw(hl_mask)
    hd.rounded_rectangle([0, 0, S - 1, int(S * 0.46)], radius=radius, fill=26)
    highlight = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    img.paste(highlight, (0, 0), Image.composite(hl_mask, Image.new("L", (S, S), 0), mask))

    d = ImageDraw.Draw(img)

    # 「译」字
    font = find_font(int(S * 0.56))
    text = "译"
    bbox = d.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (S - w) / 2 - bbox[0]
    y = (S - h) / 2 - bbox[1]
    # 柔和阴影
    d.text((x + S * 0.014, y + S * 0.018), text, font=font, fill=(15, 18, 35, 90))
    d.text((x, y), text, font=font, fill=(255, 255, 255, 255))

    img = img.resize((size, size), Image.LANCZOS)
    img.save(out_path)
    print("saved", out_path)


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in (16, 48, 128):
        make(s, os.path.join(OUT_DIR, "icon%d.png" % s))
    print("done")
