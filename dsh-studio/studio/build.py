# -*- coding: utf-8 -*-
"""gzh-studio 确定性阶段：信息图渲染 / 封面处理 / HTML 组装 / 规范校验。
由 dsh-studio 插件调用：python build.py <payload.json>
stdout 输出单行 JSON 报告，供插件解析。
"""
import base64, io, json, os, re, subprocess, sys, time

# 模块级只放标准库导入。payload / config 读取与 Pillow 导入统一放进 _init()，
# 由 __main__ 的 try 兜住：调用方是 execFile，顶层抛栈或退出码非 0 时 stdout 为空、
# 进程直接 reject，插件拿不到报告，自动回修判定就失灵（2026-11-08 测试报告 R7）。
payload = cfg = P = WORK = EDGE = ENGINE = PY = FONT = Image = None


def _init():
    """加载输入与可选依赖；任何异常都由 __main__ 统一转成一行 JSON 报告。"""
    global payload, cfg, P, WORK, EDGE, ENGINE, PY, FONT, Image
    if len(sys.argv) < 2:
        raise ValueError("缺少 payload.json 路径参数（用法：python build.py <payload.json>）")
    with open(sys.argv[1], encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict):
        raise ValueError("payload 顶层必须是 JSON 对象")
    cfg_path = payload.get("config_path")
    if not cfg_path:
        raise KeyError("payload 缺 config_path")
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    P = cfg["paths"]
    WORK = payload["work"]
    EDGE = P["edge"]
    ENGINE = P["engine"]
    PY = sys.executable
    FONT = cfg["content_spec"]["format"]["font_inline"]
    from PIL import Image as _Image  # 可选依赖缺失时也要报出可读 JSON
    Image = _Image


def b64(path):
    ext = "jpeg" if path.lower().endswith((".jpg", ".jpeg")) else "png"
    return "data:image/%s;base64,%s" % (ext, base64.b64encode(open(path, "rb").read()).decode("ascii"))


def render_fig(html_path, idx):
    png = os.path.join(WORK, "_fig%d.png" % idx)
    jpg = os.path.join(WORK, "_fig%d.jpg" % idx)
    udd = os.path.join(WORK, "_udd%d" % idx)
    os.makedirs(udd, exist_ok=True)
    cmd = [EDGE, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
           "--force-device-scale-factor=2", "--window-size=540,360",
           "--user-data-dir=" + udd, "--virtual-time-budget=3000",
           "--screenshot=" + png, "file:///" + html_path.replace("\\", "/")]
    subprocess.run(cmd, check=True, timeout=90, creationflags=subprocess.CREATE_NO_WINDOW)
    time.sleep(0.15)
    im = Image.open(png).convert("RGB")
    if im.width > 1080:
        im = im.resize((1080, int(im.height * 1080 / im.width)), Image.LANCZOS)
    im.save(jpg, "JPEG", quality=85)
    return b64(jpg)


def prep_cover(src):
    """裁掉底部 10% 水印区 → 3:2 居中 → 1080x720 q82。"""
    if not src or not os.path.exists(src):
        # 无可用图库封面：生成纯米色占位封面（不编造内容，也不消耗生图额度）
        im = Image.new("RGB", (1080, 720), "#f4e9d5")
        dst = os.path.join(WORK, "_cover.jpg")
        im.save(dst, "JPEG", quality=82)
        return dst
    im = Image.open(src).convert("RGB")
    w, h = im.size
    im = im.crop((0, 0, w, int(h * 0.90)))
    w, h = im.size
    t = 3 / 2
    if w / h > t:
        nw = int(h * t); x0 = (w - nw) // 2
        im = im.crop((x0, 0, x0 + nw, h))
    else:
        nh = int(w / t); y0 = (h - nh) // 2
        im = im.crop((0, y0, w, y0 + nh))
    im = im.resize((1080, 720), Image.LANCZOS)
    dst = os.path.join(WORK, "_cover.jpg")
    im.save(dst, "JPEG", quality=82)
    return dst


def esc(s):
    return str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def para(text, bold=False):
    st = "font-family:%s;background-color:#ffffff;font-size:15px;color:#3a3a3a;line-height:1.9;text-align:justify;margin:0 0 16px 0;" % FONT
    body = "<b style=\"font-family:%s;\">%s</b>" % (FONT, esc(text)) if bold else esc(text)
    return '<p style="%s">%s</p>' % (st, body)


def h2(text):
    st = "font-family:%s;background-color:#ffffff;font-size:18px;color:#2f3c4d;border-left:5px solid #e08a3c;padding:4px 0 4px 12px;margin:32px 0 18px 0;" % FONT
    return '<h2 style="%s">%s</h2>' % (st, esc(text))


def caption(text):
    st = "font-family:%s;background-color:#ffffff;font-size:13px;color:#888;line-height:1.7;text-align:center;margin:0 0 20px 0;" % FONT
    return '<p style="%s">%s</p>' % (st, esc(text))


def build(cover_b64, fig_b64s):
    a = payload
    F = "font-family:%s;" % FONT
    title_rows = "".join(
        '<p style="%sbackground-color:#fff8ef;font-size:14px;color:#2f3c4d;line-height:1.8;">%s</p>' % (F, esc(t))
        for t in a["titles"])
    tool = """<section style="margin:0 0 24px 0;padding:16px;border:2px dashed #e08a3c;border-radius:10px;%sbackground-color:#fff8ef;">
<p style="%sbackground-color:#fff8ef;font-size:14px;color:#2f3c4d;"><b style="%s">【标题方案（三选一）】</b></p>
%s
<p style="%sbackground-color:#fff8ef;font-size:14px;color:#2f3c4d;"><b style="%s">【一句话钩子】</b></p>
<p style="%sbackground-color:#fff8ef;font-size:14px;color:#2f3c4d;line-height:1.8;">%s</p>
<p style="%sbackground-color:#fff8ef;font-size:14px;color:#2f3c4d;"><b style="%s">【配图说明】</b></p>
<p style="%sbackground-color:#fff8ef;font-size:14px;color:#2f3c4d;line-height:1.8;">封面 1 张（本地图库匹配，横版 3:2）+ 正文 %d 张信息图（HTML 渲染截图，0 生图额度），全部 base64 内嵌。</p>
<p style="%sbackground-color:#fff8ef;font-size:14px;color:#2f3c4d;"><b style="%s">【公众号粘贴指南】</b></p>
<p style="%sbackground-color:#fff8ef;font-size:14px;color:#2f3c4d;line-height:1.8;">用 Chrome / Edge 打开本文件 → 点右上角「一键复制全文」→ 粘贴进公众号后台（Ctrl+V），图片自动转存微信 CDN。粘贴后删除工具区，发布按钮请自行确认后点击。</p>
</section>
<button id="copyBtn" onclick="copyArticle()" style="position:fixed;top:16px;right:16px;z-index:999;background:#e08a3c;color:#ffffff;border:none;border-radius:24px;padding:12px 22px;font-size:15px;font-weight:bold;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.18);%s">一键复制全文（含图片）</button>
<script>
function copyArticle(){var btn=document.getElementById('copyBtn'),c=document.getElementById('articleContent');
try{var r=document.createRange();r.selectNodeContents(c);var s=window.getSelection();s.removeAllRanges();s.addRange(r);
var ok=document.execCommand('copy');s.removeAllRanges();
if(ok){btn.textContent='\\u2713 已复制，去公众号后台粘贴（Ctrl+V）';btn.style.background='#2e7d32';
setTimeout(function(){btn.textContent='一键复制全文（含图片）';btn.style.background='#e08a3c';},4000);}
else alert('复制未成功，请确认用 Chrome/Edge 打开');}catch(e){alert('复制失败：'+e.message);}}
</script>
""" % (F, F, F, title_rows, F, F, F, esc(a["hook"]), F, F, F, len(fig_b64s), F, F, F, F)

    body = ['<p style="font-family:%s;background-color:#ffffff;text-align:center;margin:0 0 20px 0;">'
            '<img src="%s" style="width:100%%;border-radius:8px;" alt="封面"></p>' % (FONT, cover_b64)]
    body.append(para(a["hook"]))
    fig_i = 0
    sections = a.get("sections") or []
    for si, sec in enumerate(sections):
        body.append(h2(sec.get("h2", "")))
        for p in sec.get("paras", []):
            body.append(para(p))
        # 图均匀插在各小节后（不堆在开头/结尾）
        if fig_i < len(fig_b64s) and (si + 1) % max(1, len(sections) // (len(fig_b64s) + 1) + 1) == 0:
            body.append('<p style="font-family:%s;background-color:#ffffff;text-align:center;margin:0 0 6px 0;">'
                        '<img src="%s" style="width:100%%;border-radius:8px;" alt="信息图%d"></p>'
                        % (FONT, fig_b64s[fig_i], fig_i + 1))
            body.append(caption("图%d：随文信息图，内容与本节对应。" % (fig_i + 1)))
            fig_i += 1
    while fig_i < len(fig_b64s):
        body.append('<p style="font-family:%s;background-color:#ffffff;text-align:center;margin:0 0 6px 0;">'
                    '<img src="%s" style="width:100%%;border-radius:8px;" alt="信息图%d"></p>'
                    % (FONT, fig_b64s[fig_i], fig_i + 1))
        body.append(caption("图%d：随文信息图。" % (fig_i + 1)))
        fig_i += 1
    if a.get("methodology"):
        body.append(h2("沉淀一个方法"))
        body.append(para(a["methodology"]))
    if a.get("gold"):
        body.append(para(a["gold"], bold=True))
    if a.get("actions"):
        body.append(h2(a.get("action_title") or "想上手的话，按这个顺序来"))
        for i, it in enumerate(a["actions"], 1):
            body.append(para("%d. %s" % (i, it)))
    if a.get("next"):
        body.append(h2("下一篇"))
        body.append(para(a["next"]))
    body.append(h2("信源"))
    for i, s in enumerate(a.get("sources", []), 1):
        body.append('<p style="font-family:%s;background-color:#ffffff;font-size:13px;color:#6b6b6b;line-height:1.9;margin:0 0 10px 0;">%d. %s</p>' % (FONT, i, esc(s)))

    return ("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>%s</title></head>"
            "<body style=\"margin:0;padding:0;\">%s<div id=\"articleContent\">%s</div></body></html>") % (
        esc(a["titles"][0]), tool, "".join(body))


def strip_html(path):
    s = io.open(path, encoding="utf-8", errors="ignore").read()
    s = re.sub(r"data:image/[^;]+;base64,[^\"']+", " ", s)
    s = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", "", s)


def bigrams(s):
    s = re.sub(r"[^\u4e00-\u9fa5]", "", s)
    return set(s[i:i + 2] for i in range(len(s) - 1)) if len(s) > 1 else set()


def similarity(text, root):
    mine = bigrams(text)
    best, name = 0.0, ""
    for f in os.listdir(root):
        if not f.endswith(".html") or f.startswith("自动生产_") or re.match(r"^(fig|_fig|p\d|_)", f, re.I):
            continue
        p = os.path.join(root, f)
        if os.path.getsize(p) < 20_000:  # 跳过小工具页/空白模板
            continue
        other = bigrams(strip_html(p))
        if not other:
            continue
        sc = len(mine & other) / max(1, len(mine | other))
        if sc > best:
            best, name = sc, f
    return best, name


def main():
    os.makedirs(WORK, exist_ok=True)
    fig_b64s = [render_fig(os.path.join(WORK, f), i + 1) for i, f in enumerate(payload.get("figs", []))]
    cover_b64 = b64(prep_cover(payload.get("cover")))
    html = build(cover_b64, fig_b64s)
    out = os.path.join(payload["output_dir"], "自动生产_%s.html" % payload["slug"])
    io.open(out, "w", encoding="utf-8").write(html)

    # 规范校验：内核 14 项 + 结构检查
    r = subprocess.run([PY, "gzh.py", "review", out], cwd=ENGINE, encoding="utf-8",
                       errors="replace", capture_output=True, timeout=120)
    review = (r.stdout or "") + (r.stderr or "")
    m = re.search(r"违规 (\d+) 项", review)
    violations = int(m.group(1)) if m else -1
    article = html.split('id="articleContent"', 1)[-1]
    sim, sim_name = similarity(strip_html(out), payload["output_dir"])
    issues = []
    if violations > 0:
        issues.append("规范体检 %d 项违规：%s" % (violations, "; ".join(
            re.findall(r"❌\s*\[[^\]]+\][^\n]*", review))[:300]))
    if sim > cfg["gates"]["body_similarity_warn_at"]:
        issues.append("正文与《%s》相似度 %.2f，建议人工看一眼" % (sim_name, sim))

    # 内容层诊断（2026-11-09）：source-required / ending-echo 已改成真检查。
    # 它们的「待核实 N 段」「未生效」属内容层提示，不影响 pass，但必须随结果送达给人看，
    # 否则机器看见了问题、用户却只看到「14 项 0 违规」。
    content_notes = []
    m2 = re.search(r"待核实 (\d+) 段", review)
    if m2 and int(m2.group(1)) > 0:
        content_notes.append(
            "%d 段数字/事件断言段内未标出处，发布前人工复核（信源栏已有条目）" % int(m2.group(1)))
    for note in re.findall(r"\[未生效\][^\n]*", review):
        content_notes.append("体检项未生效：" + note.strip()[:140])
    issues.extend("内容层 · " + x for x in content_notes)

    rep = {
        "pass": violations == 0 and sim <= cfg["gates"]["body_similarity_warn_at"],
        "output": out, "review_violations": violations, "body_similarity": round(sim, 4),
        "similar_to": sim_name,
        "base64_imgs": len(re.findall(r'src="data:image/', article)),
        "expected_imgs": 1 + len(fig_b64s),
        "remote_imgs": len(re.findall(r'<img[^>]+src="https?://', article)),
        "dashes": article.count("——"),
        "bolds": len(re.findall(r"<b[ >]", article)),
        "issues": issues,
        "content_notes": content_notes,
    }
    print(json.dumps(rep, ensure_ascii=False))


def _fail(e):
    """统一失败报告。保持退出码 0 —— execFile 遇非 0 会 reject，stdout 的 JSON 就到不了插件。"""
    rep = {
        "pass": False, "output": "", "review_violations": -1, "body_similarity": 0,
        "similar_to": "", "base64_imgs": 0, "expected_imgs": 0, "remote_imgs": 0,
        "dashes": 0, "bolds": 0,
        "issues": ["构建异常：%s: %s" % (type(e).__name__, e)], "content_notes": [],
    }
    try:
        print(json.dumps(rep, ensure_ascii=False))
    except Exception:
        print(json.dumps(rep, ensure_ascii=True))


if __name__ == "__main__":
    try:
        _init()
        main()
    except Exception as e:
        _fail(e)
