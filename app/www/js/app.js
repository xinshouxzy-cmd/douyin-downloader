// 抖音无水印下载器 v2.0
// 双模式：Capacitor APK用原生HTTP / 浏览器用后端API

const BACKEND_URL = 'http://localhost:5003';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

let currentVideoUrl = '';
let currentVideoUrls = [];
let currentDesc = '';
let currentAwemeId = '';

function isCapacitor() {
    return typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();
}

// ====== Capacitor 原生模式（APK内使用，无需后端） ======
async function parseInCapacitor(text) {
    const { Http } = await import('@capacitor-community/http');
    
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    const rawUrl = urlMatch ? urlMatch[0] : text.trim();

    // 提取视频ID
    let videoId = null;
    const longPatterns = [/\/video\/(\d+)/, /\/share\/video\/(\d+)/, /video_id=(\d+)/, /aweme_id=(\d+)/];
    for (const p of longPatterns) {
        const m = rawUrl.match(p);
        if (m) { videoId = m[1]; break; }
    }

    // 短链接解析
    if (!videoId) {
        try {
            const resp = await Http.request({
                method: 'GET', url: rawUrl,
                headers: { 'User-Agent': MOBILE_UA },
                responseType: 'text',
                connectTimeout: 15000, readTimeout: 15000,
            });
            const html = resp.data;
            for (const p of [/\/video\/(\d+)/, /"aweme_id":"(\d+)"/, /"itemId":"(\d+)"/]) {
                const m = html.match(p);
                if (m) { videoId = m[1]; break; }
            }
        } catch(e) {}
    }

    if (!videoId) throw new Error('无法识别该链接');

    // 从 iesdouyin.com 解析
    const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}`;
    const resp = await Http.request({
        method: 'GET', url: shareUrl,
        headers: { 'User-Agent': MOBILE_UA, 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
        responseType: 'text',
        connectTimeout: 15000, readTimeout: 15000,
    });

    const html = resp.data;
    const m = html.match(/window\._ROUTER_DATA\s*=\s*/);
    if (!m) throw new Error('数据解析失败');

    let depth = 0, inStr = false, escape = false;
    const start = m.index + m[0].length;
    for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (escape) { escape = false; continue; }
        if (c === '\\' && inStr) { escape = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                const data = JSON.parse(html.substring(start, i + 1));
                return extractFromRouterData(data);
            }
        }
    }
    throw new Error('数据解析失败');
}

function extractFromRouterData(data) {
    const loaderData = data.loaderData || {};
    for (const key in loaderData) {
        const ld = loaderData[key];
        if (typeof ld !== 'object' || !ld.videoInfoRes) continue;
        const vres = ld.videoInfoRes;
        const items = vres.item_list;
        if (!items || !items.length) return { error: '视频不存在' };

        const item = items[0];
        const video = item.video || {};
        const playAddr = video.play_addr || {};
        const urlList = playAddr.url_list || [];
        if (!urlList.length) return { error: '未找到视频地址' };

        const videoUrls = [];
        for (const u of urlList.slice(0, 3)) {
            videoUrls.push(u.replace('playwm', 'play'));
            videoUrls.push(u.replace('/playwm/', '/play/'));
            if (u.includes('play') && !u.includes('playwm')) videoUrls.push(u);
        }
        const dlAddr = video.download_addr || {};
        for (const u of (dlAddr.url_list || []).slice(0, 2)) videoUrls.push(u);

        const seen = new Set();
        const unique = [];
        for (const u of videoUrls) {
            const base = u.split('?')[0];
            if (!seen.has(base)) { seen.add(base); unique.push(u); }
        }

        return {
            success: true,
            aweme_id: item.aweme_id || '',
            desc: item.desc || '',
            duration: video.duration || 0,
            video_url: unique[0] || urlList[0].replace('playwm', 'play'),
            video_urls: unique,
            author: { nickname: (item.author||{}).nickname||'', avatar: ((item.author||{}).avatar_medium||{}).url_list?.[0]||'' },
            cover_url: ((video.cover||{}).url_list||[])[0] || '',
            stats: item.statistics || {},
        };
    }
    return { error: '解析失败' };
}

// ====== 浏览器模式（调用本地Flask） ======
async function parseInBrowser(text) {
    const resp = await fetch(BACKEND_URL + '/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: text })
    });
    return await resp.json();
}

// 主动解析
async function parseVideo() {
    const text = document.getElementById('urlInput').value.trim();
    if (!text) return;

    showLoading(true, '正在解析...');
    hideResult();

    try {
        let result;
        if (isCapacitor()) {
            result = await parseInCapacitor(text);
        } else {
            result = await parseInBrowser(text);
        }
        if (result.error) throw new Error(result.error);
        showVideo(result);
    } catch (e) {
        showError(e.message || '解析失败');
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

    try {
        if (isCapacitor()) {
            btn.textContent = '下载中...';
            const { Filesystem } = await import('@capacitor/filesystem');
            
            // 尝试所有URL
            let blob = null;
            const urls = [currentVideoUrl, ...currentVideoUrls.filter(u => u !== currentVideoUrl)];
            for (const url of urls) {
                try {
                    const resp = await fetch(url);
                    if (!resp.ok || (resp.headers.get('content-type')||'').includes('text/html')) continue;
                    blob = await resp.blob();
                    if (blob.size > 1000) break;
                } catch(e) { continue; }
            }

            if (!blob) throw new Error('所有链接失效');

            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });

            const filename = `douyin_${Date.now()}.mp4`;
            await Filesystem.writeFile({ path: filename, data: base64, directory: 'Downloads' });
            btn.textContent = '✅ 已保存到下载目录';
        } else {
            btn.textContent = '下载中...';
            const resp = await fetch(BACKEND_URL + '/api/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ video_url: currentVideoUrl, desc: currentDesc, aweme_id: currentAwemeId, video_urls: currentVideoUrls })
            });
            const data = await resp.json();
            if (data.success) {
                const dl = data.download_url.startsWith('http') ? data.download_url : BACKEND_URL + data.download_url;
                window.open(dl, '_blank');
                btn.textContent = '✅ ' + data.file_size;
            } else {
                btn.textContent = '❌ ' + (data.error || '失败');
            }
        }
    } catch (e) {
        btn.textContent = '❌ ' + (e.message || '下载失败');
    } finally {
        setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2500);
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
    document.getElementById('authorName').textContent = (data.author||{}).nickname || '';
    const av = document.getElementById('authorAvatar');
    if ((data.author||{}).avatar) { av.src = data.author.avatar; av.style.display = 'block'; }
    else { av.style.display = 'none'; }

    let meta = '';
    if (data.duration) { const s = Math.round(data.duration/1000); meta += '<span>⏱ '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0')+'</span>'; }
    if (data.stats) {
        if (data.stats.digg_count) meta += '<span>❤️ '+formatNum(data.stats.digg_count)+'</span>';
        if (data.stats.comment_count) meta += '<span>💬 '+formatNum(data.stats.comment_count)+'</span>';
    }
    document.getElementById('videoMeta').innerHTML = meta;

    const video = document.getElementById('previewVideo');
    document.getElementById('playOverlay').style.display = 'flex';
    document.getElementById('coverImg').style.display = 'block';
    video.style.display = 'none';
    video.src = currentVideoUrl;

    document.getElementById('videoCard').style.display = 'block';
    document.getElementById('errorBox').style.display = 'none';
    document.getElementById('result').classList.add('show');
    document.getElementById('result').scrollIntoView({ behavior: 'smooth' });
}

function playPreview() {
    const v = document.getElementById('previewVideo');
    document.getElementById('playOverlay').style.display = 'none';
    document.getElementById('coverImg').style.display = 'none';
    v.style.display = 'block';
    v.play().catch(()=>{});
}

function showError(m) {
    document.getElementById('videoCard').style.display = 'none';
    document.getElementById('errorBox').style.display = 'block';
    document.getElementById('errorBox').textContent = m;
    document.getElementById('result').classList.add('show');
}
function hideResult() {
    document.getElementById('result').classList.remove('show');
    document.getElementById('videoCard').style.display = 'none';
    document.getElementById('errorBox').style.display = 'none';
}
function showLoading(s, t) {
    document.getElementById('loading').style.display = s ? 'block' : 'none';
    document.getElementById('loadingText').textContent = t || '';
    document.getElementById('parseBtn').disabled = s;
}
function formatNum(n) { return n>=10000?(n/10000).toFixed(1)+'w':n>=1000?(n/1000).toFixed(1)+'k':String(n); }

document.getElementById('urlInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); parseVideo(); }
});
