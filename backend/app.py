#!/usr/bin/env python3
"""
抖音无水印视频下载器
原理：iesdouyin.com SSR分享页 → _ROUTER_DATA → CDN直链下载
"""
import os
import re
import json
import uuid
import requests
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory, render_template_string
from flask_cors import CORS
from urllib.parse import quote

app = Flask(__name__)
CORS(app)

BASE_DIR = Path(__file__).parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)

MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)

def extract_video_id(text: str) -> str | None:
    """从分享文本中提取视频ID"""
    # 先提取URL
    url_match = re.search(r'https?://[^\s]+', text)
    url = url_match.group(0) if url_match else text.strip()

    # 直接匹配视频ID
    patterns = [
        r'/video/(\d+)',
        r'/share/video/(\d+)',
        r'/aweme/detail/(\d+)',
        r'/note/(\d+)',
        r'video_id=(\d+)',
        r'aweme_id=(\d+)',
    ]
    for p in patterns:
        m = re.search(p, url)
        if m:
            return m.group(1)

    # 从短链重定向获取
    try:
        resp = requests.get(url, headers={
            "User-Agent": MOBILE_UA,
            "Accept": "text/html",
        }, allow_redirects=True, timeout=15)
        final_url = resp.url
        for p in patterns:
            m = re.search(p, final_url)
            if m:
                return m.group(1)
        # 从HTML中提取
        for p in [r'"aweme_id":"(\d+)"', r'"itemId":"(\d+)"', r'"video_id":"(\d+)"']:
            m = re.search(p, resp.text)
            if m:
                return m.group(1)
    except:
        pass
    return None


def parse_video(video_id: str) -> dict | None:
    """从 iesdouyin.com SSR页面解析视频信息"""
    share_url = f"https://www.iesdouyin.com/share/video/{video_id}"
    try:
        resp = requests.get(share_url, headers={
            "User-Agent": MOBILE_UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }, timeout=15)

        html = resp.text

        # 提取 _ROUTER_DATA
        m = re.search(r'window\._ROUTER_DATA\s*=\s*', html)
        if not m:
            return {"error": "未找到页面数据，视频可能不存在或已删除"}

        start = m.end()
        depth = 0
        in_str = False
        escape = False
        json_str = None
        for i in range(start, len(html)):
            c = html[i]
            if escape:
                escape = False
                continue
            if c == '\\' and in_str:
                escape = True
                continue
            if c == '"':
                in_str = not in_str
                continue
            if in_str:
                continue
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    json_str = html[start:i + 1]
                    break

        if not json_str:
            return {"error": "数据解析失败，请重试"}

        data = json.loads(json_str)
        loader_data = data.get("loaderData", {})

        for key in loader_data:
            ld = loader_data[key]
            if isinstance(ld, dict) and "videoInfoRes" in ld:
                vres = ld["videoInfoRes"]
                if not vres.get("item_list") or len(vres["item_list"]) == 0:
                    return {"error": "视频不存在或已被删除"}

                item = vres["item_list"][0]
                video = item.get("video", {})
                play_addr = video.get("play_addr", {})
                url_list = play_addr.get("url_list", [])

                if not url_list:
                    return {"error": "未找到视频播放地址"}

                # 收集所有可能的无水印视频URL（多种去水印策略）
                video_urls = []
                for u in url_list[:3]:  # 取前3个URL
                    video_urls.append(u.replace("playwm", "play"))
                    video_urls.append(u.replace("/playwm/", "/play/"))
                    # 有些URL本来就是play，也加上
                    if "play" in u and "playwm" not in u:
                        video_urls.append(u)

                # 也尝试从 download_addr 获取
                download_addr = video.get("download_addr", {})
                dl_urls = download_addr.get("url_list", [])
                for u in dl_urls[:2]:
                    video_urls.append(u)

                # 去重
                seen = set()
                unique_urls = []
                for u in video_urls:
                    # 标准化比较
                    base = u.split("?")[0]
                    if base not in seen:
                        seen.add(base)
                        unique_urls.append(u)

                nwm_url = unique_urls[0] if unique_urls else url_list[0].replace("playwm", "play")

                cover_list = video.get("cover", {}).get("url_list", [])
                dynamic_cover = (
                    video.get("dynamic_cover", {}).get("url_list", [""])[0]
                    if video.get("dynamic_cover")
                    else ""
                )
                author = item.get("author", {})

                return {
                    "success": True,
                    "aweme_id": item.get("aweme_id", video_id),
                    "desc": item.get("desc", ""),
                    "create_time": item.get("create_time", 0),
                    "duration": video.get("duration", 0),
                    "video_url": nwm_url,
                    "video_urls": unique_urls,  # 所有备用URL
                    "author": {
                        "nickname": author.get("nickname", ""),
                        "short_id": author.get("short_id", ""),
                        "signature": author.get("signature", ""),
                        "avatar": (
                            author.get("avatar_medium", {}).get("url_list", [""])[0]
                            or author.get("avatar_thumb", {}).get("url_list", [""])[0]
                        ),
                    },
                    "video_url": nwm_url,
                    "cover_url": cover_list[0] if cover_list else "",
                    "dynamic_cover": dynamic_cover,
                    "stats": {
                        "digg_count": item.get("statistics", {}).get("digg_count", 0),
                        "comment_count": item.get("statistics", {}).get("comment_count", 0),
                        "share_count": item.get("statistics", {}).get("share_count", 0),
                        "play_count": item.get("statistics", {}).get("play_count", 0),
                    },
                }

        return {"error": "解析失败，请确认链接有效"}

    except Exception as e:
        return {"error": f"请求失败: {str(e)}"}


def download_video_from_url(video_url: str, desc: str = "", aweme_id: str = "", video_urls: list = None) -> dict:
    """从视频URL下载到本地，支持多URL尝试和过期URL自动重解析"""
    def _do_download(url: str) -> dict:
        """实际下载逻辑"""
        resp = requests.get(url, headers={
            "User-Agent": MOBILE_UA,
            "Referer": "https://www.douyin.com/",
        }, stream=True, allow_redirects=True, timeout=120)

        if resp.status_code != 200:
            return {"error": f"CDN返回HTTP {resp.status_code}，链接可能已过期", "detail": f"status={resp.status_code}"}

        content_type = resp.headers.get("Content-Type", "")
        content_length = resp.headers.get("Content-Length", "0")

        # 检查是否真的是视频
        if "video" not in content_type and "octet" not in content_type:
            # 可能是过期URL返回了HTML/JSON
            actual = resp.content[:500]
            if b"<!DOCTYPE" in actual or b"<html" in actual:
                return {"error": "视频链接已过期，正在重新解析..."}
            if b"{" in actual and b"}" in actual:
                try:
                    err_info = json.loads(actual)
                    return {"error": f"CDN返回错误: {err_info.get('message', str(err_info))[:80]}"}
                except:
                    pass
            return {"error": f"CDN返回非视频内容 (Type: {content_type}, Size: {content_length})"}

        # 检查内容长度是否合理
        if content_length.isdigit() and int(content_length) < 1000:
            return {"error": "视频文件异常太小，链接可能已过期"}

        video_id = uuid.uuid4().hex[:12]
        filename = f"{video_id}.mp4"
        filepath = str(DOWNLOAD_DIR / filename)

        total_size = 0
        with open(filepath, "wb") as f:
            for chunk in resp.iter_content(8192):
                if chunk:
                    f.write(chunk)
                    total_size += len(chunk)

        size_mb = total_size / 1024 / 1024
        return {
            "success": True,
            "filename": filename,
            "filepath": filepath,
            "file_size": f"{size_mb:.1f} MB",
            "file_size_bytes": total_size,
        }

    try:
        # 收集所有要尝试的URL
        urls_to_try = [video_url]
        if video_urls:
            for u in video_urls:
                if u != video_url and u not in urls_to_try:
                    urls_to_try.append(u)

        # 依次尝试每个URL
        last_error = None
        for url in urls_to_try:
            result = _do_download(url)
            if result.get("success"):
                return result
            last_error = result.get("error", "未知错误")
            # 如果不是过期类错误（比如404），继续尝试下一个URL
            if "过期" not in last_error and "expire" not in last_error.lower():
                continue

        # 所有URL都失败，尝试重新解析
        if aweme_id:
            reparse = parse_video(aweme_id)
            if reparse and reparse.get("success"):
                new_url = reparse.get("video_url", "")
                if new_url:
                    retry = _do_download(new_url)
                    if retry.get("success"):
                        retry["reparsed"] = True
                        return retry

        return {"error": last_error or "所有下载链接均失败"}
    except Exception as e:
        return {"error": f"下载异常: {str(e)}"}


# ========== Routes ==========

@app.route("/")
def index():
    return render_template_string(HTML)


@app.route("/api/parse", methods=["POST"])
def api_parse():
    data = request.get_json()
    text = data.get("url", "").strip()
    if not text:
        return jsonify({"success": False, "error": "请输入抖音分享链接"})

    # 提取视频ID
    video_id = extract_video_id(text)
    if not video_id:
        return jsonify({"success": False, "error": "无法识别该链接，请确认是抖音分享链接"})

    # 解析视频信息
    result = parse_video(video_id)
    return jsonify(result)


@app.route("/api/download", methods=["POST"])
def api_download():
    """返回视频下载信息（CDN直链），不消耗服务器流量"""
    data = request.get_json()
    video_url = data.get("video_url", "").strip()
    video_urls = data.get("video_urls", [])
    aweme_id = data.get("aweme_id", "")
    desc = data.get("desc", "")

    if not video_url:
        return jsonify({"success": False, "error": "缺少视频URL"})

    # 收集所有可用URL
    all_urls = [video_url]
    for u in (video_urls or []):
        if u != video_url and u not in all_urls:
            all_urls.append(u)

    return jsonify({
        "success": True,
        "video_url": video_url,
        "video_urls": all_urls,
        "desc": desc,
        "aweme_id": aweme_id,
        "message": "请使用系统浏览器打开下载链接"
    })


@app.route("/downloads/<path:filename>")
def serve_download(filename):
    return send_from_directory(str(DOWNLOAD_DIR), filename, as_attachment=True)


HTML = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>抖音无水印下载器</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #16213e 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #e0e0e0;
        }
        .container {
            width: 100%;
            max-width: 600px;
            padding: 20px;
        }
        .card {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 20px;
            padding: 30px;
            backdrop-filter: blur(20px);
        }
        .logo {
            text-align: center;
            margin-bottom: 24px;
        }
        .logo-icon { font-size: 48px; }
        .logo h1 {
            font-size: 24px;
            font-weight: 700;
            background: linear-gradient(135deg, #00d4ff, #7b2ff7);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-top: 8px;
        }
        .input-group {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }
        textarea {
            flex: 1;
            padding: 14px 16px;
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 12px;
            color: #fff;
            font-size: 14px;
            resize: none;
            height: 48px;
            line-height: 20px;
            outline: none;
            transition: border-color 0.2s;
        }
        textarea:focus { border-color: #7b2ff7; }
        textarea::placeholder { color: rgba(255,255,255,0.3); }
        .btn {
            padding: 12px 24px;
            border: none;
            border-radius: 12px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            white-space: nowrap;
        }
        .btn-parse {
            background: linear-gradient(135deg, #7b2ff7, #00d4ff);
            color: #fff;
        }
        .btn-parse:hover { transform: translateY(-1px); box-shadow: 0 4px 20px rgba(123,47,247,0.4); }
        .btn-download {
            background: linear-gradient(135deg, #00d4ff, #00ff88);
            color: #000;
            width: 100%;
            margin-top: 16px;
        }
        .btn-download:hover { transform: translateY(-1px); box-shadow: 0 4px 20px rgba(0,212,255,0.4); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none !important; }

        .result { margin-top: 20px; display: none; }
        .result.show { display: block; }

        .video-card {
            background: rgba(255,255,255,0.05);
            border-radius: 16px;
            overflow: hidden;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .video-preview {
            position: relative;
            aspect-ratio: 9/16;
            background: #000;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .video-preview img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        .video-preview video {
            width: 100%;
            height: 100%;
            object-fit: contain;
            display: none;
        }
        .play-overlay {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            background: rgba(0,0,0,0.3);
        }
        .play-btn {
            width: 64px;
            height: 64px;
            background: rgba(255,255,255,0.9);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            color: #000;
            transition: transform 0.2s;
        }
        .play-overlay:hover .play-btn { transform: scale(1.1); }

        .video-info { padding: 16px; }
        .video-desc {
            font-size: 15px;
            line-height: 1.5;
            margin-bottom: 8px;
            color: #fff;
        }
        .video-meta {
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
            font-size: 13px;
            color: rgba(255,255,255,0.5);
        }
        .video-meta span { display: flex; align-items: center; gap: 4px; }

        .author-row {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px 16px;
            border-top: 1px solid rgba(255,255,255,0.08);
        }
        .author-avatar {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            object-fit: cover;
            background: rgba(255,255,255,0.1);
        }
        .author-name {
            font-size: 14px;
            font-weight: 600;
            color: #fff;
        }

        .error-box {
            background: rgba(255,59,48,0.1);
            border: 1px solid rgba(255,59,48,0.3);
            border-radius: 12px;
            padding: 16px;
            color: #ff3b30;
            font-size: 14px;
            text-align: center;
        }

        .loading {
            text-align: center;
            padding: 40px;
            color: rgba(255,255,255,0.5);
        }
        .spinner {
            width: 32px;
            height: 32px;
            border: 3px solid rgba(255,255,255,0.15);
            border-top-color: #7b2ff7;
            border-radius: 50%;
            animation: spin 0.6s linear infinite;
            margin: 0 auto 12px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .footer { text-align: center; margin-top: 24px; font-size: 12px; color: rgba(255,255,255,0.25); }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <div class="logo">
                <div class="logo-icon">🎬</div>
                <h1>抖音无水印下载器</h1>
            </div>

            <div class="input-group">
                <textarea id="urlInput" placeholder="粘贴抖音分享链接...&#10;支持：短链接 / 长链接 / 分享文本"></textarea>
                <button class="btn btn-parse" id="parseBtn" onclick="parseVideo()">解析</button>
            </div>

            <div id="loading" class="loading" style="display:none">
                <div class="spinner"></div>
                <div>正在解析视频...</div>
            </div>

            <div id="result" class="result">
                <div id="errorBox" class="error-box" style="display:none"></div>
                <div id="videoCard" class="video-card" style="display:none">
                    <div class="video-preview" id="preview">
                        <img id="coverImg" src="" alt="">
                        <video id="previewVideo" controls></video>
                        <div class="play-overlay" id="playOverlay" onclick="playPreview()">
                            <div class="play-btn">▶</div>
                        </div>
                    </div>
                    <div class="video-info">
                        <div class="video-desc" id="videoDesc"></div>
                        <div class="video-meta" id="videoMeta"></div>
                    </div>
                    <div class="author-row">
                        <img class="author-avatar" id="authorAvatar" src="" alt="">
                        <span class="author-name" id="authorName"></span>
                    </div>
                    <div style="padding: 0 16px 16px">
                        <button class="btn btn-download" id="downloadBtn" onclick="downloadVideo()">下载无水印视频</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="footer">遵义农商银行 · XZY工具箱</div>
    </div>

    <script>
        let currentVideoUrl = '';
        let currentDesc = '';
        let currentAwemeId = '';
        let currentVideoUrls = [];

        document.getElementById('urlInput').addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                parseVideo();
            }
        });

        async function parseVideo() {
            const url = document.getElementById('urlInput').value.trim();
            if (!url) return;

            showLoading(true);
            hideResult();

            try {
                const resp = await fetch('/api/parse', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({url: url})
                });
                const data = await resp.json();

                if (data.error || !data.success) {
                    showError(data.error || '解析失败');
                    return;
                }

                showVideo(data);
            } catch (e) {
                showError('网络错误，请重试');
            } finally {
                showLoading(false);
            }
        }

        function showVideo(data) {
            currentVideoUrl = data.video_url;
            currentDesc = data.desc;
            currentAwemeId = data.aweme_id;
            currentVideoUrls = data.video_urls || [data.video_url];

            document.getElementById('coverImg').src = data.cover_url || '';
            document.getElementById('videoDesc').textContent = data.desc || '无描述';
            document.getElementById('authorAvatar').src = data.author?.avatar || '';
            document.getElementById('authorName').textContent = data.author?.nickname || '未知作者';

            let metaHtml = '';
            if (data.duration) {
                const sec = Math.round(data.duration / 1000);
                metaHtml += `<span>⏱ ${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}</span>`;
            }
            if (data.stats) {
                const s = data.stats;
                if (s.digg_count) metaHtml += `<span>❤️ ${formatNum(s.digg_count)}</span>`;
                if (s.comment_count) metaHtml += `<span>💬 ${formatNum(s.comment_count)}</span>`;
                if (s.share_count) metaHtml += `<span>🔄 ${formatNum(s.share_count)}</span>`;
            }
            document.getElementById('videoMeta').innerHTML = metaHtml;

            // Try to set up video preview
            const video = document.getElementById('previewVideo');
            const playOverlay = document.getElementById('playOverlay');
            const coverImg = document.getElementById('coverImg');
            video.style.display = 'none';
            playOverlay.style.display = 'flex';
            coverImg.style.display = 'block';
            video.src = currentVideoUrl;

            document.getElementById('videoCard').style.display = 'block';
            document.getElementById('errorBox').style.display = 'none';
            document.getElementById('result').classList.add('show');
        }

        function playPreview() {
            const video = document.getElementById('previewVideo');
            const playOverlay = document.getElementById('playOverlay');
            const coverImg = document.getElementById('coverImg');

            video.style.display = 'block';
            coverImg.style.display = 'none';
            playOverlay.style.display = 'none';
            video.play();
        }

        function blobToBase64(blob) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => { const r = reader.result||''; resolve(r.split(',')[1]||r); };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        }

        function blobToBase64(blob) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => { const r = reader.result||''; resolve(r.split(',')[1]||r); };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        }

        async function downloadVideo() {
            if (!currentVideoUrl) return;

            const btn = document.getElementById('downloadBtn');
            const origText = btn.textContent;
            btn.disabled = true;
            btn.textContent = '下载中...';

            try {
                // APK环境：用原生文件系统下载到手机
                if (typeof Capacitor !== 'undefined' && Capacitor.Plugins.Filesystem) {
                    const fileResp = await fetch(currentVideoUrl);
                    if (!fileResp.ok) throw new Error('下载失败');
                    const blob = await fileResp.blob();
                    const b64 = await blobToBase64(blob);
                    const filename = 'douyin_'+Date.now()+'.mp4';
                    await Capacitor.Plugins.Filesystem.writeFile({
                        path: filename, data: b64, directory: 'Downloads'
                    });
                    btn.textContent = '✅ 已保存到下载目录';
                } else {
                    // 网页端：直接打开CDN链接
                    window.open(currentVideoUrl, '_blank');
                    btn.textContent = '✅ 下载已开始';
                }
                setTimeout(() => {
                    btn.textContent = origText;
                    btn.disabled = false;
                }, 2500);
            } catch (e) {
                btn.textContent = '❌ ' + (e.message || '下载失败');
                btn.disabled = false;
                setTimeout(() => { btn.textContent = origText; }, 2500);
            }
        }

        function showError(msg) {
            document.getElementById('videoCard').style.display = 'none';
            document.getElementById('errorBox').style.display = 'block';
            document.getElementById('errorBox').textContent = msg;
            document.getElementById('result').classList.add('show');
        }

        function hideResult() {
            document.getElementById('result').classList.remove('show');
            document.getElementById('videoCard').style.display = 'none';
            document.getElementById('errorBox').style.display = 'none';
        }

        function showLoading(s) {
            document.getElementById('loading').style.display = s ? 'block' : 'none';
            document.getElementById('parseBtn').disabled = s;
        }

        function formatNum(n) {
            if (n >= 10000) return (n/10000).toFixed(1) + 'w';
            if (n >= 1000) return (n/1000).toFixed(1) + 'k';
            return String(n);
        }
    </script>
</body>
</html>'''


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5003))
    host = os.environ.get("HOST", "127.0.0.1")
    app.run(host=host, port=port, debug=False)
