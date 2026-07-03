// 抖音无水印下载器 v2.0
// 调用后端 Flask API 进行解析和下载

// 后端地址 - 部署后会更新
const BACKEND_URL = '__BACKEND_URL__';

let currentVideoUrl = '';
let currentVideoUrls = [];
let currentDesc = '';
let currentAwemeId = '';

// 检测是否在 Capacitor 环境中
function isCapacitor() {
    return typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();
}

// 主解析函数
async function parseVideo() {
    const urlInput = document.getElementById('urlInput');
    const text = urlInput.value.trim();
    if (!text) return;

    showLoading(true, '正在解析视频...');
    hideResult();

    try {
        const resp = await fetch(BACKEND_URL + '/api/parse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: text })
        });
        const data = await resp.json();

        if (data.error || !data.success) {
            throw new Error(data.error || '解析失败');
        }

        showVideo(data);
    } catch (e) {
        showError(e.message || '网络错误，请重试');
    } finally {
        showLoading(false);
    }
}

// 下载视频
async function downloadVideo() {
    if (!currentVideoUrl) return;

    const btn = document.getElementById('downloadBtn');
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '下载中...';

    try {
        // 调用后端下载API
        const resp = await fetch(BACKEND_URL + '/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                video_url: currentVideoUrl,
                desc: currentDesc,
                aweme_id: currentAwemeId,
                video_urls: currentVideoUrls
            })
        });
        const data = await resp.json();

        if (data.success) {
            const downloadUrl = data.download_url.startsWith('http') 
                ? data.download_url 
                : BACKEND_URL + data.download_url;

            if (isCapacitor()) {
                // 在App中：用系统浏览器打开下载链接
                window.open(downloadUrl, '_system');
            } else {
                window.open(downloadUrl, '_blank');
            }
            btn.textContent = '✅ 下载完成 (' + data.file_size + ')';
        } else {
            btn.textContent = '❌ ' + (data.error || '下载失败');
        }

        setTimeout(() => {
            btn.textContent = origText;
            btn.disabled = false;
        }, 2500);

    } catch (e) {
        btn.textContent = '❌ 网络错误';
        btn.disabled = false;
        setTimeout(() => { btn.textContent = origText; }, 2500);
    }
}

// UI helpers
function showVideo(data) {
    currentVideoUrl = data.video_url;
    currentVideoUrls = data.video_urls || [data.video_url];
    currentDesc = data.desc || '';
    currentAwemeId = data.aweme_id || '';

    document.getElementById('coverImg').src = data.cover_url || '';
    document.getElementById('videoDesc').textContent = data.desc || '无描述';
    document.getElementById('authorName').textContent = (data.author || {}).nickname || '未知作者';

    const avatar = document.getElementById('authorAvatar');
    if ((data.author || {}).avatar) {
        avatar.src = data.author.avatar;
        avatar.style.display = 'block';
    } else {
        avatar.style.display = 'none';
    }

    let metaHtml = '';
    if (data.duration) {
        const sec = Math.round(data.duration / 1000);
        metaHtml += '<span>⏱ ' + Math.floor(sec/60) + ':' + String(sec%60).padStart(2,'0') + '</span>';
    }
    if (data.stats) {
        const s = data.stats;
        if (s.digg_count) metaHtml += '<span>❤️ ' + formatNum(s.digg_count) + '</span>';
        if (s.comment_count) metaHtml += '<span>💬 ' + formatNum(s.comment_count) + '</span>';
        if (s.share_count) metaHtml += '<span>🔄 ' + formatNum(s.share_count) + '</span>';
    }
    document.getElementById('videoMeta').innerHTML = metaHtml;

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
    document.getElementById('result').scrollIntoView({ behavior: 'smooth' });
}

function playPreview() {
    const video = document.getElementById('previewVideo');
    const playOverlay = document.getElementById('playOverlay');
    const coverImg = document.getElementById('coverImg');
    video.style.display = 'block';
    coverImg.style.display = 'none';
    playOverlay.style.display = 'none';
    video.play().catch(function() {});
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

function showLoading(show, text) {
    document.getElementById('loading').style.display = show ? 'block' : 'none';
    document.getElementById('loadingText').textContent = text || '正在解析视频...';
    document.getElementById('parseBtn').disabled = show;
}

function formatNum(n) {
    if (n >= 10000) return (n/10000).toFixed(1) + 'w';
    if (n >= 1000) return (n/1000).toFixed(1) + 'k';
    return String(n);
}

document.getElementById('urlInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        parseVideo();
    }
});

console.log('抖音无水印下载器 v2.0 已就绪');
