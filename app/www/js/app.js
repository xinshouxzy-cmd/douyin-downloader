// 抖音无水印下载器 v2.2
// APK: 原生HTTP / 浏览器: Flask后端

const BACKEND_URL = 'http://localhost:5003';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

let currentVideoUrl = '';
let currentVideoUrls = [];
let currentDesc = '';
let currentAwemeId = '';

function isCapacitor() {
    return typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();
}

// 获取可用的HTTP插件
function getHttpPlugin() {
    if (window.CapacitorHttp && typeof window.CapacitorHttp.get === 'function') return window.CapacitorHttp;
    if (window.CapacitorHttp && typeof window.CapacitorHttp.request === 'function') return window.CapacitorHttp;
    const P = window.Capacitor && window.Capacitor.Plugins;
    if (P && P.Http) return P.Http;
    if (P && P.CapacitorHttp) return P.CapacitorHttp;
    if (P && P.CommunityHttp) return P.CommunityHttp;
    return null;
}

// HTTP GET请求
async function httpGet(url) {
    const plugin = getHttpPlugin();
    if (plugin) {
        // 使用原生HTTP插件
        const fn = plugin.request || plugin.get;
        const result = await fn.call(plugin, {
            method: 'GET',
            url: url,
            headers: { 'User-Agent': MOBILE_UA },
            responseType: 'text',
            connectTimeout: 15000,
            readTimeout: 15000
        });
        if (result.status !== 200) throw new Error('HTTP ' + result.status);
        return result.data;
    }

    // 浏览器环境
    const resp = await fetch(url, {
        headers: { 'User-Agent': MOBILE_UA }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
}

// 跟随重定向
async function followRedirect(url) {
    const plugin = getHttpPlugin();
    if (plugin) {
        const fn = plugin.request || plugin.get;
        const result = await fn.call(plugin, {
            method: 'GET', url: url,
            headers: { 'User-Agent': MOBILE_UA },
            responseType: 'text',
            connectTimeout: 10000, readTimeout: 10000
        });
        if (result.url && result.url !== url) return result.url;
        return url;
    }
    const resp = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
    return resp.url;
}

// ====== Capacitor APK 模式 ======
async function parseInCapacitor(text) {
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    const rawUrl = urlMatch ? urlMatch[0] : text.trim();

    let videoId = null;
    const patterns = [/\/video\/(\d+)/, /\/share\/video\/(\d+)/, /video_id=(\d+)/, /aweme_id=(\d+)/];
    for (const p of patterns) {
        const m = rawUrl.match(p);
        if (m) { videoId = m[1]; break; }
    }

    if (!videoId) {
        try {
            const finalUrl = await followRedirect(rawUrl);
            for (const p of patterns) {
                const m = finalUrl.match(p);
                if (m) { videoId = m[1]; break; }
            }
            if (!videoId) {
                const html = await httpGet(rawUrl);
                for (const p of [/\/video\/(\d+)/, /"aweme_id":"(\d+)"/, /"itemId":"(\d+)"/]) {
                    const m = html.match(p);
                    if (m) { videoId = m[1]; break; }
                }
            }
        } catch(e) {
            throw new Error('无法识别该链接(HTTP错误)，请确认是抖音分享链接');
        }
    }

    if (!videoId) throw new Error('无法提取视频ID');

    const html = await httpGet('https://www.iesdouyin.com/share/video/' + videoId);
    const m = html.match(/window\._ROUTER_DATA\s*=\s*/);
    if (!m) throw new Error('数据解析失败，视频可能不存在');

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
            if (depth === 0) return extractInfo(JSON.parse(html.substring(start, i + 1)));
        }
    }
    throw new Error('数据解析失败');
}

function extractInfo(data) {
    const ld = data.loaderData || {};
    for (const k in ld) {
        const v = ld[k];
        if (typeof v !== 'object' || !v.videoInfoRes) continue;
        const items = (v.videoInfoRes || {}).item_list || [];
        if (!items.length) return { error: '视频不存在' };
        const item = items[0], video = item.video || {}, pa = video.play_addr || {}, ul = pa.url_list || [];
        if (!ul.length) return { error: '未找到视频地址' };

        const all = [];
        for (const u of ul.slice(0,3)) {
            all.push(u.replace('playwm','play'));
            all.push(u.replace('/playwm/','/play/'));
            if (u.includes('play')&&!u.includes('playwm')) all.push(u);
        }
        for (const u of ((video.download_addr||{}).url_list||[]).slice(0,2)) all.push(u);

        const seen = new Set(), uniq = [];
        for (const u of all) { const b = u.split('?')[0]; if (!seen.has(b)) { seen.add(b); uniq.push(u); } }

        return {
            success: true,
            aweme_id: item.aweme_id || '',
            desc: item.desc || '',
            duration: video.duration || 0,
            video_url: uniq[0] || ul[0].replace('playwm','play'),
            video_urls: uniq,
            author: { nickname: (item.author||{}).nickname||'', avatar: (((item.author||{}).avatar_medium||{}).url_list||[])[0]||'' },
            cover_url: ((video.cover||{}).url_list||[])[0] || '',
            stats: item.statistics || {},
        };
    }
    return { error: '解析失败' };
}

// ====== 浏览器模式 ======
async function parseInBrowser(text) {
    const r = await fetch(BACKEND_URL + '/api/parse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: text })
    });
    return await r.json();
}

// 主入口
async function parseVideo() {
    const text = document.getElementById('urlInput').value.trim();
    if (!text) return;
    showLoading(true, '正在解析...');
    hideResult();
    try {
        const result = isCapacitor() ? await parseInCapacitor(text) : await parseInBrowser(text);
        if (result.error) throw new Error(result.error);
        showVideo(result);
    } catch(e) {
        showError(e.message || '解析失败');
    } finally {
        showLoading(false);
    }
}

// 下载
async function downloadVideo() {
    if (!currentVideoUrl) return;
    const btn = document.getElementById('downloadBtn'), orig = btn.textContent;
    btn.disabled = true; btn.textContent = '下载中...';
    try {
        if (isCapacitor()) {
            const FS = window.Capacitor.Plugins.Filesystem;
            const urls = [currentVideoUrl, ...currentVideoUrls.filter(function(u){return u!==currentVideoUrl;})];
            let blob = null;
            for (const url of urls) {
                try {
                    const r = await fetch(url);
                    if (!r.ok || (r.headers.get('content-type')||'').includes('text/html')) continue;
                    blob = await r.blob();
                    if (blob.size > 1000) break;
                } catch(e) { continue; }
            }
            if (!blob) throw new Error('所有下载链接失效');
            const b64 = await new Promise(function(ok,no){const r=new FileReader();r.onloadend=function(){ok(r.result.split(',')[1]);};r.onerror=no;r.readAsDataURL(blob);});
            await FS.writeFile({ path: 'douyin_'+Date.now()+'.mp4', data: b64, directory: 'Downloads' });
            btn.textContent = '✅ 已保存到下载目录';
        } else {
            const r = await fetch(BACKEND_URL + '/api/download', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ video_url: currentVideoUrl, desc: currentDesc, aweme_id: currentAwemeId, video_urls: currentVideoUrls })
            });
            const d = await r.json();
            if (d.success) { window.open(d.download_url.startsWith('http')?d.download_url:BACKEND_URL+d.download_url,'_blank'); btn.textContent='✅ '+d.file_size; }
            else btn.textContent = '❌ '+(d.error||'失败');
        }
    } catch(e) { btn.textContent = '❌ '+(e.message||'下载失败'); }
    setTimeout(function(){ btn.textContent=orig; btn.disabled=false; }, 2500);
}

// UI
function showVideo(data) {
    currentVideoUrl=data.video_url; currentVideoUrls=data.video_urls||[data.video_url]; currentDesc=data.desc||''; currentAwemeId=data.aweme_id||'';
    document.getElementById('coverImg').src=data.cover_url||'';
    document.getElementById('videoDesc').textContent=data.desc||'无描述';
    document.getElementById('authorName').textContent=(data.author||{}).nickname||'';
    var av=document.getElementById('authorAvatar');
    if((data.author||{}).avatar){av.src=data.author.avatar;av.style.display='block';}else{av.style.display='none';}
    var m='';if(data.duration){var s=Math.round(data.duration/1000);m+='<span>⏱ '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0')+'</span>';}
    if(data.stats){if(data.stats.digg_count)m+='<span>❤️ '+formatNum(data.stats.digg_count)+'</span>';if(data.stats.comment_count)m+='<span>💬 '+formatNum(data.stats.comment_count)+'</span>';}
    document.getElementById('videoMeta').innerHTML=m;
    var v=document.getElementById('previewVideo'),po=document.getElementById('playOverlay'),ci=document.getElementById('coverImg');
    po.style.display='flex';ci.style.display='block';v.style.display='none';v.src=currentVideoUrl;
    document.getElementById('videoCard').style.display='block';document.getElementById('errorBox').style.display='none';
    document.getElementById('result').classList.add('show');document.getElementById('result').scrollIntoView({behavior:'smooth'});
}
function playPreview(){document.getElementById('playOverlay').style.display='none';document.getElementById('coverImg').style.display='none';document.getElementById('previewVideo').style.display='block';document.getElementById('previewVideo').play().catch(function(){});}
function showError(m){document.getElementById('videoCard').style.display='none';document.getElementById('errorBox').style.display='block';document.getElementById('errorBox').textContent=m;document.getElementById('result').classList.add('show');}
function hideResult(){document.getElementById('result').classList.remove('show');document.getElementById('videoCard').style.display='none';document.getElementById('errorBox').style.display='none';}
function showLoading(s,t){document.getElementById('loading').style.display=s?'block':'none';document.getElementById('loadingText').textContent=t||'';document.getElementById('parseBtn').disabled=s;}
function formatNum(n){return n>=10000?(n/10000).toFixed(1)+'w':n>=1000?(n/1000).toFixed(1)+'k':String(n);}
document.getElementById('urlInput').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();parseVideo();}});
