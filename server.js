process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const FIREBASE_URL = "https://gamerdz1517-db-default-rtdb.europe-west1.firebasedatabase.app";
const CLOUDFLARE_WORKER_URL = "https://xt81.djamelchaouadi.workers.dev"; // رابط الووركر الخاص بك يعمل 100%

process.on('uncaughtException', (err) => console.error('Caught exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

const listsCache = new Map();
const localCache = new Map();

app.use((req, res, next) => {
    if (req.path.includes('player_api') || req.path.includes('get_items') || req.path.includes('get.php'))
        res.setHeader('Cache-Control', 'public, max-age=14400');
    next();
});

// ================================================================
// دوال مشتركة
// ================================================================
function streamToResponse(fetchBody, res, req) {
    if (fetchBody.on && typeof fetchBody.on === 'function') {
        fetchBody.on('data', (chunk) => { if (!res.writableEnded) res.write(chunk); });
        fetchBody.on('end',  ()      => { if (!res.writableEnded) res.end(); });
        fetchBody.on('error',()      => { if (!res.writableEnded) res.end(); });
        req.on('close', () => {
            if (!res.writableEnded) res.end();
            if (typeof fetchBody.destroy === 'function') fetchBody.destroy();
        });
    } else if (fetchBody.getReader) {
        const reader = fetchBody.getReader();
        req.on('close', () => { reader.cancel(); if (!res.writableEnded) res.end(); });
        (async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) { if (!res.writableEnded) res.end(); break; }
                    if (!res.writableEnded) res.write(value);
                    else { reader.cancel(); break; }
                }
            } catch { if (!res.writableEnded) res.end(); }
        })();
    } else {
        if (!res.writableEnded) res.end();
    }
}

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept-Ranges');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
}

async function getAuthDataFromFirebase(password) {
    if (!password) return null;
    if (localCache.has(password)) return localCache.get(password);
    try {
        const r = await fetch(`${FIREBASE_URL}/accounts/${password}.json`);
        if (!r.ok) return null;
        const data = await r.json();
        if (data?.server && data?.mac) {
            const result = { srv: data.server, mac: data.mac, selections: data.selections };
            localCache.set(password, result);
            return result;
        }
        return null;
    } catch { return null; }
}

function encodeSafeBase64(str) {
    try { return Buffer.from(unescape(encodeURIComponent(str))).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
    catch { return Buffer.from(str).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
}

function decodeSafeBase64(str) {
    try {
        let b64 = str.replace(/-/g,'+').replace(/_/g,'/');
        while (b64.length % 4) b64 += '=';
        return decodeURIComponent(escape(Buffer.from(b64,'base64').toString('utf-8')));
    } catch { return str; }
}

function isAdultContent(name) {
    return name ? /porn|xxx|adult|18\+|erotic|sex|adults/i.test(name) : false;
}

function getRealLogo(serverUrl, logoPath, type) {
    if (!logoPath) return "";
    const url = String(logoPath).trim();
    if (url.startsWith('http')) return url;
    const srv = serverUrl.replace(/\/+$/, '');
    if (url.startsWith('/')) return srv + url;
    if (url.includes('/')) return srv + '/' + url;
    return srv + (type === 'vod' || type === 'series'
        ? '/stalker_portal/misc/video_cover/' + url
        : '/stalker_portal/misc/logos/320/' + url);
}

function safeFallback(action) {
    if (action === "") return {
        user_info: { username:"GAMERDZ", password:"", message:"Unauthorized", auth:0, status:"Inactive", exp_date:"0", is_trial:"0", active_cons:"0", max_connections:"1000", created_at:"0", allowed_output_formats:["m3u8","ts","rtmp","mkv","mp4"] },
        server_info: { url:"", port:"80", https_port:"443", server_protocol:"http", timezone:"Africa/Algiers", version:"2.9.0" }
    };
    if (action === "get_series_info") return { seasons:[], episodes:{}, info:{ name:"Not Found", cover:"", plot:"", cast:"", director:"", genre:"", releaseDate:"", rating:"5", rating_5based:5.0, backdrop_path:[] } };
    if (action === "get_short_epg" || action === "get_simple_data_table") return { epg_listings:[] };
    return [];
}

async function callStalkerDirect(serverUrl, macAddress, stalkerType, stalkerAction, token = null) {
    // 🚀 تمت إزالة الـ randomIP تماماً لمنع خطأ 403 من سيرفرات Stalker
    const headers = {
        "User-Agent":      "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
        "Referer":         `${serverUrl}/c/`,
        "Cookie":          `mac=${macAddress}; stb_lang=en; timezone=Africa/Algiers;`,
        "Accept":          "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With":"XMLHttpRequest"
    };

    let targetUrl;
    if (stalkerAction === "handshake") {
        targetUrl = `${serverUrl}/portal.php?action=handshake&type=stb&token=&JsHttpRequest=1-xml`;
        headers["Authorization"] = `MAC ${macAddress}`;
    } else {
        targetUrl = `${serverUrl}/server/load.php?type=${stalkerType}&action=${stalkerAction}&JsHttpRequest=1-xml`;
        if (token && token !== "null") {
            targetUrl += `&token=${token}`;
            headers["Authorization"] = `Bearer ${token}`;
        }
    }

    try {
        const res = await fetch(targetUrl, { headers, timeout: 35000 });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

async function fetchContentStrict(server, mac, type, allowedIds, categoryId, token, extraParam = "") {
    const genreParam = type === "itv" ? "genre" : "category";
    const targetCat  = (categoryId && !["0","*","null","undefined"].includes(categoryId)) ? categoryId : "";
    const extraQuery = extraParam ? `&${extraParam}` : "";

    let catsToFetch = [];
    if (targetCat) {
        catsToFetch = [targetCat];
    } else if (allowedIds.includes('ALL')) {
        const catRes = await callStalkerDirect(server, mac, type, type === "itv" ? "get_genres" : "get_categories", token);
        const list   = catRes?.js ? (Array.isArray(catRes.js) ? catRes.js : Object.values(catRes.js)) : [];
        catsToFetch  = list.map(c => String(c.id));
        if (!catsToFetch.length) catsToFetch = [""];
    } else {
        catsToFetch = allowedIds;
    }

    const uniqueMap = new Map();
    const batchSize = 3;

    for (const catId of catsToFetch) {
        const catQuery = catId ? `&${genreParam}=${catId}` : "";
        let page = 1, keepGoing = true;
        while (keepGoing && page <= 60) {
            const promises = Array.from({length: batchSize}, (_, i) =>
                callStalkerDirect(server, mac, type, `get_ordered_list${catQuery}${extraQuery}&limit=1500&p=${page+i}`, token)
            );
            const results = await Promise.all(promises);
            let found = false;
            for (const res of results) {
                let pageData = res?.js?.data || res?.js;
                if (!pageData) continue;
                if (!Array.isArray(pageData)) pageData = typeof pageData === 'object' ? Object.values(pageData) : [];
                for (const item of pageData) {
                    const itemCat = String(item.tv_genre_id || item.category_id || catId || targetCat || "0");
                    if (allowedIds.includes('ALL') || allowedIds.includes(itemCat) || extraParam) {
                        const id = item.id || item.cmd || Math.random();
                        if (!uniqueMap.has(id)) { item.injected_cat_id = itemCat; uniqueMap.set(id, item); }
                    }
                    found = true;
                }
            }
            if (!found) { keepGoing = false; break; }
            page += batchSize;
        }
    }
    return Array.from(uniqueMap.values());
}

// ================================================================
// Stalker: Handshake
// ================================================================
app.get('/stalker/handshake', async (req, res) => {
    const { portal, mac } = req.query;
    if (!portal || !mac) return res.status(400).json({ success:false, error:"Missing params" });
    try {
        const result = await callStalkerDirect(portal, mac, "stb", "handshake", null);
        const token  = result?.js?.token;
        if (!token) return res.status(401).json({ success:false, error:"Invalid MAC or Portal" });
        return res.json({ success:true, token });
    } catch(e) { return res.status(500).json({ success:false, error:e.message }); }
});

// ================================================================
// Stalker: Profile (تاريخ الانتهاء)
// ================================================================
app.get('/stalker/profile', async (req, res) => {
    const { portal, mac, token } = req.query;
    if (!portal || !mac || !token) return res.status(400).json({ success:false, error:"Missing params" });
    try {
        const result = await callStalkerDirect(portal, mac, "stb", "get_profile", token);
        if (!result?.js) return res.status(404).json({ success:false, error:"No profile data" });
        return res.json({ success:true, expire_billing_date: result.js.expire_billing_date ?? null, phone: result.js.phone ?? null, fname: result.js.fname ?? null });
    } catch(e) { return res.status(500).json({ success:false, error:e.message }); }
});

// ================================================================
// Stalker: جلب الفئات فقط (سريع)
// ================================================================
app.post('/api/get_categories', async (req, res) => {
    const { server, mac, type } = req.body;
    if (!server || !mac || !type) return res.json({ success:false, error:"Missing params" });
    try {
        const hs  = await callStalkerDirect(server, mac, "stb", "handshake", null);
        const tk  = hs?.js?.token;
        if (!tk) return res.json({ success:false, error:"MAC Blocked" });

        const action = type === "itv" ? "get_genres" : "get_categories";
        const catRaw = await callStalkerDirect(server, mac, type, action, tk);
        const list   = catRaw?.js ? (Array.isArray(catRaw.js) ? catRaw.js : Object.values(catRaw.js)) : [];

        return res.json({
            success: true,
            token:   tk,
            data:    list.map(c => ({ id: String(c.id), title: c.title || c.name || "Unknown" }))
        });
    } catch(e) { return res.json({ success:false, error:e.message }); }
});

// ================================================================
// Stalker: جلب قنوات فئة معينة
// ================================================================
app.post('/api/get_category_items', async (req, res) => {
    const { server, mac, type, categoryId, token } = req.body;
    if (!server || !mac || !type) return res.json({ success:false, error:"Missing params" });
    try {
        let tk = token;
        if (!tk) {
            const hs = await callStalkerDirect(server, mac, "stb", "handshake", null);
            tk = hs?.js?.token;
        }
        if (!tk) return res.json({ success:false, error:"MAC Blocked" });

        const items     = await fetchContentStrict(server, mac, type, [categoryId], categoryId, tk);
        const formatted = items.map(item => ({
            id:   String(item.id || item.cmd),
            name: item.name || item.cmd || "Unknown",
            logo: item.logo || item.screenshot_uri || ""
        }));
        return res.json({ success:true, data:formatted });
    } catch(e) { return res.json({ success:false, error:e.message }); }
});

// ================================================================
// Stalker: Get Items (عام)
// ================================================================
app.post('/api/get_items', async (req, res) => {
    const { server, mac, type, selectedCats } = req.body;
    try {
        const hs = await callStalkerDirect(server, mac, "stb", "handshake", null);
        const tk = hs?.js?.token;
        if (!tk) return res.json({ success:false, error:"MAC Blocked" });

        const items     = await fetchContentStrict(server, mac, type, selectedCats, null, tk);
        const formatted = items.map(item => ({
            id:   item.id || item.cmd,
            name: item.name || item.cmd,
            logo: item.logo || item.screenshot_uri || ""
        }));
        res.json({ success:true, data:formatted });
    } catch(e) { res.json({ success:false, error:e.message }); }
});

// ================================================================
// Create Account
// ================================================================
app.post('/create_account', async (req, res) => {
    try {
        const { mac, server, selections } = req.body;
        if (!mac || !server) return res.json({ success:false, error:"Missing Data" });

        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let shortPass = '';
        for (let i = 0; i < 8; i++) shortPass += chars[Math.floor(Math.random() * chars.length)];

        const dbData = { mac: mac.trim(), server: server.trim(), selections };
        const fbRes  = await fetch(`${FIREBASE_URL}/accounts/${shortPass}.json`, {
            method: 'PUT', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(dbData)
        });
        if (fbRes.ok) {
            localCache.set(shortPass, { srv:dbData.server, mac:dbData.mac, selections:dbData.selections });
            return res.json({ success:true, password:shortPass });
        }
        return res.json({ success:false, error:"Database Error" });
    } catch(e) { res.json({ success:false, error:e.message }); }
});

// ================================================================
// Proxy Stream — نسخة نظيفة للـ Worker Fallback
// ================================================================
async function routeViaWorker(req, res, streamUrl, type) {
    try {
        if (!CLOUDFLARE_WORKER_URL) {
             return res.status(500).send("Worker URL is not configured properly in Node.js");
        }
        const workerUrl = `${CLOUDFLARE_WORKER_URL}/stream?url=${encodeURIComponent(streamUrl)}`;
        const headers   = { "User-Agent":"VLC/3.0.9 LibVLC/3.0.9", "Accept":"*/*" };
        if (req.headers.range) headers["Range"] = req.headers.range;

        const workerRes = await fetch(workerUrl, { headers, redirect:'follow', timeout:0 });
        if (!workerRes.ok && workerRes.status !== 206)
            return res.status(workerRes.status).send(`Worker Error: ${workerRes.status}`);

        res.status(workerRes.status);
        setCorsHeaders(res);
        ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
            if (workerRes.headers.has(h)) res.setHeader(h, workerRes.headers.get(h));
        });
        if (!res.getHeader('Content-Type'))
            res.setHeader('Content-Type', (type==='vod'||type==='movie') ? 'video/mp4' : 'video/mp2t');
        streamToResponse(workerRes.body, res, req);
    } catch(e) { res.status(500).send("Worker Error: " + e.message); }
}

// ================================================================
// Proxy Stream (المحصن ضد خطأ 429 والاتصالات المزدوجة)
// ================================================================
app.get('/proxy_stream', async (req, res) => {
    let { server, mac, stream_id, type, resolve_only } = req.query;

    if (server) {
        server = server.trim().replace(/\/c\/?$/i, '').replace(/\/+$/, '');
        if (!server.startsWith('http')) server = 'http://' + server;
    }
    if (!server || !mac || !stream_id) return res.status(400).send("Missing params");

    console.log(`[PROXY] server=${server} stream_id=${stream_id} type=${type}`);

    try {
        // Handshake
        const tkRes = await callStalkerDirect(server, mac, "stb", "handshake", null);
        const tk    = tkRes?.js?.token;
        console.log(`[PROXY] token=${tk}`);
        if (!tk) return res.status(403).send("MAC Blocked");

        let streamUrl = "";

        if (type === 'vod' || type === 'movie') {
            streamUrl = `${server}/play/movie.php?mac=${mac}&stream=${stream_id}.mkv&type=movie`;

        } else {
            // ===== LIVE =====
            const cmd     = encodeURIComponent(`ffmpeg localhost/ch/${stream_id}`);
            const linkRes = await callStalkerDirect(server, mac, "itv", `create_link&cmd=${cmd}`, tk);
            console.log(`[PROXY] create_link response=${JSON.stringify(linkRes?.js)}`);

            if (linkRes?.js?.cmd) {
                const rawCmd = linkRes.js.cmd;
                streamUrl = rawCmd.startsWith('ffmpeg ') ? rawCmd.split(' ').pop() : rawCmd;
                
                const playToken = linkRes.js.play_token || linkRes.js.token_random || null;
                if (playToken && !streamUrl.includes('play_token=')) {
                    streamUrl += (streamUrl.includes('?') ? '&' : '?') + `play_token=${playToken}`;
                }
            }

            if (!streamUrl) {
                streamUrl = `${server}/play/live.php?mac=${mac}&stream=${stream_id}&extension=ts`;
            }
        }

        console.log(`[PROXY] final streamUrl=${streamUrl}`);
        if (!streamUrl) return res.status(404).send("Stream not found");

        if (resolve_only === '1') return res.json({ success:true, stream_url:streamUrl, type });

        // 🚀 إعدادات الـ Headers المحصنة
        const reqHeaders = {
            "User-Agent": "VLC/3.0.9 LibVLC/3.0.9",
            "Accept": "*/*",
            "Connection": "keep-alive"
        };

        // 🚀 اللمسة السحرية: نمرر الـ Range فقط في الأفلام، ونمنعه في البث المباشر (LIVE) لمنع خطأ 429
        if (req.headers.range && (type === 'vod' || type === 'movie')) {
            reqHeaders["Range"] = req.headers.range;
        }

        let fetchRes;
        try {
            fetchRes = await fetch(streamUrl, { headers:reqHeaders, redirect:'follow', timeout:15000 });
        } catch(fetchErr) {
            console.log(`[PROXY] fetch failed: ${fetchErr.message} → Worker`);
            return routeViaWorker(req, res, streamUrl, type);
        }

        console.log(`[PROXY] stream status=${fetchRes.status}`);

        // 🚀 إذا السيرفر أعطانا 429 (Too Many Requests)، نرسلها للمتصفح فوراً دون اللجوء للووركر
        if (fetchRes.status === 429) {
            return res.status(429).send("Too Many Connections (429). The IPTV server allows only 1 connection.");
        }

        // إذا واجهنا خطأ أو حظر نقوم بالتوجه إلى Worker كخطة بديلة
        if ([403, 407, 511].includes(fetchRes.status) || fetchRes.status >= 500) {
            console.log(`[PROXY] Blocked (${fetchRes.status}) → Worker`);
            return routeViaWorker(req, res, streamUrl, type);
        }
        if (!fetchRes.ok && fetchRes.status !== 206)
            return res.status(fetchRes.status).send(`Stream Error: ${fetchRes.status}`);

        res.status(fetchRes.status);
        setCorsHeaders(res);
        ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
            if (fetchRes.headers.has(h)) res.setHeader(h, fetchRes.headers.get(h));
        });
        if (!res.getHeader('Content-Type'))
            res.setHeader('Content-Type', (type==='vod'||type==='movie') ? 'video/mp4' : 'video/mp2t');
        streamToResponse(fetchRes.body, res, req);

    } catch(e) {
        console.error(`[PROXY] Exception: ${e.message}`);
        try {
            return routeViaWorker(req, res, `${server}/play/live.php?mac=${mac}&stream=${stream_id}&extension=ts`, type);
        } catch { res.status(500).send("Proxy Error: " + e.message); }
    }
});
// ================================================================
// Generate M3U
// ================================================================
app.get('/get.php', async (req, res) => {
    const username = (req.query.username || "").trim();
    const password = (req.query.password || "").trim();
    const authData = await getAuthDataFromFirebase(password);
    if (!authData || authData.mac.toLowerCase() !== username.toLowerCase()) return res.status(403).send("Unauthorized");

    const portalServer = authData.srv;
    const stalkerMac   = authData.mac;
    const sel          = authData.selections || { l:[], v:[], s:[] };
    const fullUrl      = `http://${req.headers['x-forwarded-host'] || req.get('host')}`;

    try {
        const hs = await callStalkerDirect(portalServer, stalkerMac, "stb", "handshake");
        const tk = hs?.js?.token;
        if (!tk) return res.status(403).send("MAC Blocked");

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="GAMERDZ1517_${username}.m3u"`);
        res.write("#EXTM3U\n");

        if (sel.l?.length) {
            const catRes = await callStalkerDirect(portalServer, stalkerMac, "itv", "get_genres", tk);
            const catMap = {};
            (catRes?.js ? (Array.isArray(catRes.js) ? catRes.js : Object.values(catRes.js)) : [])
                .forEach(c => catMap[String(c.id)] = c.title || c.name);
            const channels = await fetchContentStrict(portalServer, stalkerMac, "itv", sel.l, null, tk);
            for (const ch of channels) {
                const cName = catMap[String(ch.injected_cat_id||"0")] || "Live";
                const logo  = getRealLogo(portalServer, ch.logo, 'itv');
                const name  = ch.name || "Unknown";
                res.write(`#EXTINF:-1 tvg-name="${name}" tvg-logo="${logo}" group-title="${cName} by ᴳᴬᴹᴱᴿᴰᶻ¹⁵¹⁷",${name}\n`);
                res.write(`${fullUrl}/live/${username}/${password}/${ch.id}.ts\n`);
            }
        }
        if (sel.v?.length) {
            const catRes = await callStalkerDirect(portalServer, stalkerMac, "vod", "get_categories", tk);
            const catMap = {};
            (catRes?.js ? (Array.isArray(catRes.js) ? catRes.js : Object.values(catRes.js)) : [])
                .forEach(c => catMap[String(c.id)] = c.title || c.name);
            const vods = await fetchContentStrict(portalServer, stalkerMac, "vod", sel.v, null, tk);
            for (const v of vods) {
                if (isAdultContent(v.name)) continue;
                const cName = catMap[String(v.injected_cat_id||"0")] || "Movies";
                const logo  = getRealLogo(portalServer, v.screenshot_uri || v.logo, 'vod');
                const name  = v.name || v.cmd;
                res.write(`#EXTINF:-1 tvg-name="${name}" tvg-logo="${logo}" group-title="${cName} by ᴳᴬᴹᴱᴿᴰᶻ¹⁵¹⁷",${name}\n`);
                res.write(`${fullUrl}/movie/${username}/${password}/${v.id}.mkv\n`);
            }
        }
        res.end();
    } catch { res.status(500).send("Error generating M3U"); }
});

// ================================================================
// Xtream API Bridge
// ================================================================
app.all(['/player_api.php', '/panel_api.php', '/xmltv.php'], async (req, res) => {
    const username  = (req.query.username  || req.body.username  || "").trim();
    const password  = (req.query.password  || req.body.password  || "").trim();
    const apiAction = (req.query.action    || req.body.action    || "");
    const categoryId= req.query.category_id|| req.body.category_id;
    const seriesId  = req.query.series_id  || req.body.series_id;

    if (req.path.endsWith("xmltv.php")) return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');

    const cacheKey = `xtream_${username}_${apiAction}_${categoryId||'all'}_${seriesId||'all'}`;
    if (listsCache.has(cacheKey)) {
        const cached = listsCache.get(cacheKey);
        if (Date.now() - cached.time < 14400000) { res.setHeader('Content-Type','application/json'); return res.send(cached.data); }
    }

    const authData = await getAuthDataFromFirebase(password);
    if (!authData || authData.mac.toLowerCase() !== username.toLowerCase()) {
        return res.json(apiAction === "" ? { user_info:{ auth:0, status:"Inactive" } } : safeFallback(apiAction));
    }

    const portalServer = authData.srv;
    const stalkerMac   = authData.mac;
    const sel          = authData.selections || { l:[], v:[], s:[] };
    const fullUrl      = `http://${req.headers['x-forwarded-host'] || req.get('host')}`;

    try {
        if (apiAction === "") {
            const timeNow = new Date().toISOString().replace('T',' ').substring(0,19);
            return res.json({
                user_info:   { username, password, message:"Logged In Successfully", auth:1, status:"Active", exp_date:"1999999999", is_trial:"0", active_cons:"0", max_connections:"1000", created_at:"1600000000", allowed_output_formats:["m3u8","ts","rtmp","mkv","mp4"] },
                server_info: { url:fullUrl, port:"80", https_port:"443", server_protocol:"http", timezone:"Africa/Algiers", timestamp_now:Math.floor(Date.now()/1000), time_now:timeNow, version:"2.9.0" }
            });
        }

        const hs = await callStalkerDirect(portalServer, stalkerMac, "stb", "handshake");
        const tk = hs?.js?.token;
        if (!tk) return res.json(safeFallback(apiAction));

        let responseData = [];

        if (apiAction === "get_live_categories") {
            const r    = await callStalkerDirect(portalServer, stalkerMac, "itv", "get_genres", tk);
            let list   = r?.js ? (Array.isArray(r.js) ? r.js : Object.values(r.js)) : [];
            if (!sel.l.includes('ALL')) list = list.filter(c => sel.l.includes(String(c.id)));
            responseData = list.map(c => ({ category_id:String(c.id), category_name:String(c.title||c.name), parent_id:0 }));
        }
        else if (apiAction === "get_vod_categories") {
            const r    = await callStalkerDirect(portalServer, stalkerMac, "vod", "get_categories", tk);
            let list   = r?.js ? (Array.isArray(r.js) ? r.js : Object.values(r.js)) : [];
            if (!sel.v.includes('ALL')) list = list.filter(c => sel.v.includes(String(c.id)));
            responseData = list.map(c => ({ category_id:String(c.id), category_name:String(c.title||c.name), parent_id:0 }));
        }
        else if (apiAction === "get_series_categories") {
            const r    = await callStalkerDirect(portalServer, stalkerMac, "series", "get_categories", tk).catch(() => ({js:[]}));
            let list   = r?.js ? (Array.isArray(r.js) ? r.js : Object.values(r.js)) : [];
            if (!sel.s.includes('ALL')) list = list.filter(c => sel.s.includes(String(c.id)));
            responseData = list.map(c => ({ category_id:String(c.id), category_name:String(c.title||c.name), parent_id:0 }));
        }
        else if (apiAction === "get_live_streams") {
            const reqCat = (categoryId && !["null","*","0"].includes(categoryId)) ? String(categoryId) : null;
            if (reqCat && !sel.l.includes('ALL') && !sel.l.includes(reqCat)) return res.json([]);
            const channels = await fetchContentStrict(portalServer, stalkerMac, "itv", sel.l, categoryId, tk);
            responseData = channels.map(ch => ({
                num:parseInt(ch.number||ch.id)||0, name:String(ch.name||"Unknown"), stream_type:"live",
                stream_id:parseInt(ch.id)||0, stream_icon:getRealLogo(portalServer,ch.logo,'itv'),
                epg_channel_id:null, added:"1600000000", category_id:String(ch.injected_cat_id||"0"),
                custom_sid:"", tv_archive:parseInt(ch.tv_archive)||0, direct_source:"", tv_archive_duration:parseInt(ch.tv_archive_duration)||0
            }));
        }
        else if (apiAction === "get_vod_streams") {
            const reqCat = (categoryId && !["null","*","0"].includes(categoryId)) ? String(categoryId) : null;
            if (reqCat && !sel.v.includes('ALL') && !sel.v.includes(reqCat)) return res.json([]);
            const vods = await fetchContentStrict(portalServer, stalkerMac, "vod", sel.v, categoryId, tk);
            responseData = vods.filter(v => !isAdultContent(v.name)).map(v => ({
                num:parseInt(v.id)||0, name:String(v.name||v.cmd), stream_type:"movie",
                stream_id:parseInt(v.id)||0, stream_icon:getRealLogo(portalServer,v.screenshot_uri||v.logo,'vod'),
                added:"1600000000", category_id:String(v.injected_cat_id||"0"), container_extension:"mkv",
                rating:String(v.rating||"5"), rating_5based:5.0, custom_sid:"", direct_source:""
            }));
        }
        else if (apiAction === "get_series") {
            const reqCat = (categoryId && !["null","*","0"].includes(categoryId)) ? String(categoryId) : null;
            if (reqCat && !sel.s.includes('ALL') && !sel.s.includes(reqCat)) return res.json([]);
            const series = await fetchContentStrict(portalServer, stalkerMac, "series", sel.s, categoryId, tk);
            responseData = series.filter(s => !isAdultContent(s.name)).map(s => ({
                num:parseInt(s.id)||0, name:String(s.name), series_id:parseInt(s.id)||0,
                cover:getRealLogo(portalServer,s.screenshot_uri||s.logo,'series'),
                category_id:String(s.injected_cat_id||"0"), plot:"", cast:"", director:"", genre:"",
                releaseDate:"", last_modified:"1600000000", rating:"5", rating_5based:5.0,
                backdrop_path:[], youtube_trailer:"", episode_run_time:"0"
            }));
        }
        else if (apiAction === "get_series_info" && seriesId) {
            try {
                const data = await fetchContentStrict(portalServer, stalkerMac, "series", ['ALL'], null, tk, `&movie_id=${seriesId}&season_id=0&episode_id=0`);
                const seasonsInfo = []; const epsObj = {}; let seasonIndex = 1;
                for (const season of data) {
                    const seasonCmd  = season.cmd; if (!seasonCmd) continue;
                    const episodesArr= season.series; if (!Array.isArray(episodesArr)||!episodesArr.length) continue;
                    const sNum = String(season.season || seasonIndex);
                    if (!epsObj[sNum]) epsObj[sNum] = [];
                    for (const ep of episodesArr) {
                        const epNum = String(ep);
                        epsObj[sNum].push({ id:encodeSafeBase64(`${seasonCmd}::::${epNum}`), episode_num:parseInt(epNum)||0, title:`Episode ${epNum}`, container_extension:"mkv", info:{ movie_image:getRealLogo(portalServer,season.screenshot_uri||season.cover,'series'), plot:"", releasedate:"", rating:"5", rating_5based:5.0, duration_secs:0, duration:"" }, custom_sid:"", added:"1600000000", season:parseInt(sNum), direct_source:"" });
                    }
                    seasonsInfo.push({ air_date:"", episode_count:episodesArr.length, id:parseInt(sNum), name:`Season ${sNum}`, overview:"", season_number:parseInt(sNum), cover:"", cover_big:"" });
                    seasonIndex++;
                }
                if (!seasonsInfo.length) { seasonsInfo.push({ air_date:"", episode_count:0, id:1, name:"Season 1", overview:"", season_number:1, cover:"", cover_big:"" }); epsObj["1"]=[]; }
                responseData = { seasons:seasonsInfo, episodes:epsObj, info:{ name:"GAMERDZ Series", cover:"", plot:"", cast:"", director:"", genre:"", releaseDate:"", rating:"5", rating_5based:5.0, backdrop_path:[] } };
            } catch { responseData = safeFallback("get_series_info"); }
        }
        else if (apiAction === "get_short_epg" || apiAction === "get_simple_data_table") {
            responseData = { epg_listings:[] };
        }

        if (apiAction) {
            const stringData = JSON.stringify(responseData);
            listsCache.set(cacheKey, { data:stringData, time:Date.now() });
            res.setHeader('Content-Type','application/json');
            return res.send(stringData);
        }
        return res.json(responseData);
    } catch { return res.json(safeFallback(apiAction)); }
});

// ================================================================
// Stream Bridge (Live / Movie / Series)  ← M3U Xtream-style URLs
// ================================================================
app.get(['/live/:user/:pass/:stream', '/movie/:user/:pass/:stream', '/series/:user/:pass/:stream', '/:user/:pass/:stream'], async (req, res) => {
    const type     = req.path.split('/')[1] || "live";
    const username = decodeURIComponent(req.params.user).trim();
    const reqPass  = decodeURIComponent(req.params.pass).trim();
    let streamId   = req.params.stream;
    if (streamId.includes('.')) streamId = streamId.split('.')[0];

    const authData = await getAuthDataFromFirebase(reqPass);
    if (!authData || authData.mac.toLowerCase() !== username.toLowerCase()) return res.status(403).send("Unauthorized");

    const server    = authData.srv;
    const stalkerMac= authData.mac;

    try {
        let finalStreamUrl = "";

        if (type === "movie") {
            finalStreamUrl = `${server}/play/movie.php?mac=${stalkerMac}&stream=${streamId}.mkv&type=movie`;
        }
        else if (type === "series") {
            let actualId = streamId, playToken = "";
            try { const dec = decodeSafeBase64(streamId); if (dec.includes("::::")) actualId = dec.split("::::")[0]; } catch {}
            if (actualId.includes("-")) { const idx = actualId.indexOf("-"); playToken = actualId.substring(idx+1); actualId = actualId.substring(0,idx); }
            finalStreamUrl = `${server}/play/movie.php?mac=${stalkerMac}&stream=${actualId}.mkv&type=series`;
            if (playToken) finalStreamUrl += `&play_token=${playToken}`;
        }
        else {
            // Live: create_link + play_token
            const hs = await callStalkerDirect(server, stalkerMac, "stb", "handshake");
            const tk = hs?.js?.token;
            if (!tk) return res.status(403).send("MAC Blocked");

            const cmd     = encodeURIComponent(`ffmpeg localhost/ch/${streamId}`);
            const linkRes = await callStalkerDirect(server, stalkerMac, "itv", `create_link&cmd=${cmd}`, tk);

            const pt = linkRes?.js?.play_token || linkRes?.js?.token_random || null;

            if (linkRes?.js?.cmd) {
                const rawCmd = linkRes.js.cmd;
                finalStreamUrl = rawCmd.startsWith('ffmpeg ') ? rawCmd.split(' ').pop() : rawCmd;
                if (pt && !finalStreamUrl.includes('play_token='))
                    finalStreamUrl += (finalStreamUrl.includes('?') ? '&' : '?') + `play_token=${pt}`;
            }
            
            // 🚀 التعديل هنا أيضاً ليطابق VLC
            if (!finalStreamUrl) {
                finalStreamUrl = `${server}/play/live.php?mac=${stalkerMac}&stream=${streamId}&extension=ts`;
                if (pt) finalStreamUrl += `&play_token=${pt}`;
            }
        }

        if (!finalStreamUrl) return res.status(404).send("Stream Not Found");

        // 🚀 تمت إزالة الـ randomIP هنا أيضاً
        const reqHeaders = { "User-Agent":"VLC/3.0.9 LibVLC/3.0.9", "Accept":"*/*", "Connection":"keep-alive" };
        if (req.headers.range) reqHeaders["Range"] = req.headers.range;

        const fetchRes = await fetch(finalStreamUrl, { headers:reqHeaders, redirect:'follow', timeout:0 });
        if (!fetchRes.ok && fetchRes.status !== 206) return res.status(fetchRes.status).send("Stream Error");

        res.status(fetchRes.status);
        setCorsHeaders(res);
        ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
            if (fetchRes.headers.has(h)) res.setHeader(h, fetchRes.headers.get(h));
        });
        if (!res.getHeader('Content-Type'))
            res.setHeader('Content-Type', type === "live" ? 'video/mp2t' : 'video/mp4');
        streamToResponse(fetchRes.body, res, req);

    } catch { res.status(500).send("Bridge Error"); }
});

app.get('/', (req, res) => res.status(200).send('✅ GAMERDZ1517 SERVER IS RUNNING PERFECTLY!'));
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
