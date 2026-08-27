const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ⚠️ ضع رابط Cloudflare Worker الخاص بك
const CF_WORKER_URL = "https://xt.gamerdz1517.com"; 

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

function encodeSafeBase64(str) {
    try {
        return Buffer.from(unescape(encodeURIComponent(str))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch(e) {
        return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
}

function decodeSafeBase64(str) {
    try {
        let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) { b64 += '='; }
        return decodeURIComponent(escape(Buffer.from(b64, 'base64').toString('utf-8')));
    } catch(e) { return str; }
}

function getAuthData(req) {
    let headerData = req.headers['x-gamerdz-data'];
    if (headerData) {
        try {
            let decoded = Buffer.from(headerData.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
            let json = JSON.parse(decoded);
            if (json.server && json.mac) return { srv: json.server, mac: json.mac, selections: json.selections };
        } catch(e) {}
    }
    return null;
}

function isAdultContent(name) {
    if (!name) return false;
    return /porn|xxx|adult|18\+|erotic|sex|adults/i.test(name.toLowerCase());
}

function safeFallback(action) {
    let timeNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
    if (action === "") {
        return {
            user_info: { username: "GAMERDZ", password: "", message: "Unauthorized", auth: 0, status: "Inactive", exp_date: "0", is_trial: "0", active_cons: "0", max_connections: "1000", created_at: "0", allowed_output_formats: ["m3u8", "ts", "rtmp", "mkv", "mp4"] },
            server_info: { url: "", port: "80", https_port: "443", server_protocol: "http", timezone: "Africa/Algiers", version: "2.9.0" }
        };
    } else if (action === "get_series_info") {
        return { seasons: [], episodes: {}, info: { name: "Not Found", cover: "", plot: "", cast: "", director: "", genre: "", releaseDate: "", rating: "5", rating_5based: 5.0 } };
    } else if (action === "get_short_epg" || action === "get_simple_data_table") {
        return { epg_listings: [] };
    } else return [];
}

async function callStalkerProxy(serverUrl, macAddress, stalkerType, stalkerAction, token = null) {
    let proxyUrl = `${CF_WORKER_URL}/?server=${encodeURIComponent(serverUrl)}&mac=${encodeURIComponent(macAddress)}&type=${encodeURIComponent(stalkerType)}&action=${encodeURIComponent(stalkerAction)}`;
    if (token) proxyUrl += `&token=${encodeURIComponent(token)}`;
    try {
        const res = await fetch(proxyUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 35000 });
        if (!res.ok) return null;
        return await res.json();
    } catch(e) { return null; }
}

// 🚀 محرك السحب الجبار المتوافق مع Render (يسحب الجروبات فرداً فرداً لمنع نقصان القنوات)
async function fetchContentStrict(server, mac, type, allowedIds, requestedCategoryId, token, extraParam = "") {
    let genreParam = type === "itv" ? "genre" : "category";

    let categoriesToFetch = [];

    // إذا طلب المشغل فئة معينة نجلبها لوحدها
    if (requestedCategoryId && requestedCategoryId !== "0" && requestedCategoryId !== "*" && requestedCategoryId !== "null" && requestedCategoryId !== "undefined") {
        categoriesToFetch = [String(requestedCategoryId)];
    } else {
        // إذا طلب الكل، نجلب الفئات التي اخترناها نحن فقط لضمان امتلائها
        if (allowedIds.includes('ALL')) {
            let catRes = await callStalkerProxy(server, mac, type, type === "itv" ? "get_genres" : "get_categories", token);
            let list = catRes?.js ? (Array.isArray(catRes.js) ? catRes.js : Object.values(catRes.js)) : [];
            categoriesToFetch = list.map(c => String(c.id));
            if(categoriesToFetch.length === 0) categoriesToFetch = ["0"]; // احتياطي
        } else {
            categoriesToFetch = allowedIds; // سحب الفئات المختارة
        }
    }

    let allItems = [];

    // الدوران على كل جروب بشكل منفصل لضمان جلب محتواه 100%
    for (let catId of categoriesToFetch) {
        let p = 1;
        let keepGoing = true;
        let batchSize = 10; // 10 طلبات متوازية لاستغلال سرعة Render الفائقة
        
        let catQuery = (catId === "0" || catId === "*") ? "" : `&${genreParam}=${catId}`;

        while (keepGoing && p <= 50) { 
            let promises = [];
            for (let i = 0; i < batchSize; i++) {
                let page = p + i;
                let urlAction = `get_ordered_list${catQuery}${extraParam}&limit=5000&p=${page}`;
                promises.push(callStalkerProxy(server, mac, type, urlAction, token));
            }
            
            let chunkResults = await Promise.all(promises);
            let foundDataInChunk = false;

            for (let res of chunkResults) {
                let pageData = res?.js?.data || res?.js;
                if (!pageData) continue;

                if (!Array.isArray(pageData)) {
                    if (typeof pageData === 'object' && Object.keys(pageData).length > 0) pageData = Object.values(pageData);
                    else pageData = [];
                }
                
                if (pageData.length > 0) {
                    for (let x = 0; x < pageData.length; x++) {
                        let item = pageData[x];
                        // 💉 الحقن الإجباري للجروب لمنع ضياع القناة في التطبيقات الصارمة
                        if (catId !== "0" && catId !== "*") {
                            item.injected_cat_id = String(catId); 
                        }
                        allItems.push(item);
                    }
                    foundDataInChunk = true;
                }
            }
            
            if (!foundDataInChunk) break; // الانتقال للجروب التالي إذا انتهت صفحات هذا الجروب
            p += batchSize;
        }
    }

    let uniqueMap = new Map();
    for (let item of allItems) {
        let id = item.id || item.cmd;
        if (id && !uniqueMap.has(id)) uniqueMap.set(id, item);
        else if (!id) uniqueMap.set(Math.random(), item);
    }
    return Array.from(uniqueMap.values());
}

app.all(['/player_api.php', '/panel_api.php', '/xmltv.php'], async (req, res) => {
    let username = (req.query.username || req.body.username || "").trim();
    let password = (req.query.password || req.body.password || "").trim();
    let apiAction = req.query.action || req.body.action || "";
    let categoryId = req.query.category_id || req.body.category_id;
    let seriesId = req.query.series_id || req.body.series_id;

    if (req.path.endsWith("xmltv.php")) return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');

    let authData = getAuthData(req);

    if (!authData || authData.mac.toLowerCase() !== username.toLowerCase()) {
        if (apiAction === "") return res.json({ user_info: { auth: 0, status: "Inactive" } });
        return res.json([]);
    }

    let portalServer = authData.srv;
    let stalkerMac = authData.mac; 
    let sel = authData.selections || { l: [], v: [], s: [] };

    let host = req.headers['x-forwarded-host'] || req.get('host');
    let fullUrl = `http://${host}`;

    try {
        if (apiAction === "") {
            return res.json({
                user_info: { 
                    username: username, password: password, message: "Logged In Successfully", 
                    auth: 1, status: "Active", exp_date: "1999999999", 
                    is_trial: "0", active_cons: "0", max_connections: "1000", created_at: "1600000000",
                    allowed_output_formats: ["m3u8", "ts", "rtmp", "mkv", "mp4"] 
                },
                server_info: { url: fullUrl, port: "80", https_port: "443", server_protocol: "http", timezone: "Africa/Algiers", version: "2.9.0" }
            });
        } 
        
        let handshakeRes = await callStalkerProxy(portalServer, stalkerMac, "stb", "handshake");
        let stalkerToken = handshakeRes?.js?.token;
        if (!stalkerToken) return res.json([]); 

        let responseData = [];

        // 🎭 تزوير الجروبات المسموحة فقط
        if (apiAction === "get_live_categories") {
            let r = await callStalkerProxy(portalServer, stalkerMac, "itv", "get_genres", stalkerToken);
            let list = r?.js ? (Array.isArray(r.js) ? r.js : Object.values(r.js)) : [];
            if (!sel.l.includes('ALL')) list = list.filter(c => sel.l.includes(String(c.id)));
            responseData = list.map(c => ({ category_id: String(c.id), category_name: String(c.title || c.name), parent_id: 0 }));
        } 
        else if (apiAction === "get_vod_categories") {
            let r = await callStalkerProxy(portalServer, stalkerMac, "vod", "get_categories", stalkerToken);
            let list = r?.js ? (Array.isArray(r.js) ? r.js : Object.values(r.js)) : [];
            if (!sel.v.includes('ALL')) list = list.filter(c => sel.v.includes(String(c.id)));
            responseData = list.map(c => ({ category_id: String(c.id), category_name: String(c.title || c.name), parent_id: 0 }));
        } 
        else if (apiAction === "get_series_categories") {
            let r = await callStalkerProxy(portalServer, stalkerMac, "series", "get_categories", stalkerToken).catch(() => ({js:[]}));
            let list = r?.js ? (Array.isArray(r.js) ? r.js : Object.values(r.js)) : [];
            if (!sel.s.includes('ALL')) list = list.filter(c => sel.s.includes(String(c.id)));
            responseData = list.map(c => ({ category_id: String(c.id), category_name: String(c.title || c.name), parent_id: 0 }));
        } 
        
        // 🚀 تعبئة القنوات بالمرور على الجروبات المحددة حصراً لضمان امتلائها
        else if (apiAction === "get_live_streams") {
            let reqCat = (categoryId && categoryId !== "null" && categoryId !== "*" && categoryId !== "0") ? String(categoryId) : null;
            if (reqCat && !sel.l.includes('ALL') && !sel.l.includes(reqCat)) return res.json([]);
            
            let channels = await fetchContentStrict(portalServer, stalkerMac, "itv", sel.l, categoryId, stalkerToken);

            responseData = channels.map(ch => ({
                num: parseInt(ch.number || ch.id) || 0,
                name: String(ch.name || "Unknown"),
                stream_type: "live",
                stream_id: parseInt(ch.id) || 0,
                stream_icon: String(ch.logo || ""),
                epg_channel_id: null,
                added: "1600000000",
                category_id: String(ch.injected_cat_id || ch.tv_genre_id || ch.category_id || reqCat || "0"),
                custom_sid: "",
                tv_archive: parseInt(ch.tv_archive) || 0,
                direct_source: "",
                tv_archive_duration: parseInt(ch.tv_archive_duration) || 0
            }));
        } 
        else if (apiAction === "get_vod_streams") {
            let reqCat = (categoryId && categoryId !== "null" && categoryId !== "*" && categoryId !== "0") ? String(categoryId) : null;
            if (reqCat && !sel.v.includes('ALL') && !sel.v.includes(reqCat)) return res.json([]);
            
            let vods = await fetchContentStrict(portalServer, stalkerMac, "vod", sel.v, categoryId, stalkerToken);

            responseData = vods.filter(v => !isAdultContent(v.name)).map(v => ({
                num: parseInt(v.id) || 0,
                name: String(v.name || v.cmd),
                stream_type: "movie",
                stream_id: parseInt(v.id) || 0,
                stream_icon: String(v.screenshot_uri || v.logo || ""),
                added: "1600000000",
                category_id: String(v.injected_cat_id || v.category_id || reqCat || "0"),
                container_extension: "mkv",
                rating: String(v.rating || "5"),
                rating_5based: 5.0,
                custom_sid: "",
                direct_source: ""
            }));
        } 
        else if (apiAction === "get_series") {
            let reqCat = (categoryId && categoryId !== "null" && categoryId !== "*" && categoryId !== "0") ? String(categoryId) : null;
            if (reqCat && !sel.s.includes('ALL') && !sel.s.includes(reqCat)) return res.json([]);
            
            let series = await fetchContentStrict(portalServer, stalkerMac, "series", sel.s, categoryId, stalkerToken);

            responseData = series.filter(s => !isAdultContent(s.name)).map(s => ({
                num: parseInt(s.id) || 0,
                name: String(s.name),
                series_id: parseInt(s.id) || 0,
                cover: String(s.screenshot_uri || s.logo || ""),
                category_id: String(s.injected_cat_id || s.category_id || reqCat || "0"),
                plot: "", cast: "", director: "", genre: "", releaseDate: "",
                rating: "5", rating_5based: 5.0,
                backdrop_path: []
            }));
        }
        else if (apiAction === "get_series_info" && seriesId) {
            try {
                let data = await fetchContentStrict(portalServer, stalkerMac, "series", ['ALL'], null, stalkerToken, `&movie_id=${seriesId}&season_id=0&episode_id=0`);
                let seasonsInfo = []; let epsObj = {}; let seasonIndex = 1;
                
                if (data.length > 0) {
                    for (let season of data) {
                        let seasonCmd = season.cmd;
                        if (!seasonCmd) continue;
                        let episodesArr = season.series; 
                        if (!Array.isArray(episodesArr) || episodesArr.length === 0) continue;

                        let sNum = String(season.season || seasonIndex);
                        if (!epsObj[sNum]) epsObj[sNum] = [];

                        for (let ep of episodesArr) {
                            let episodeNum = String(ep);
                            let streamIdRaw = encodeSafeBase64(`${seasonCmd}::::${episodeNum}`);
                            
                            epsObj[sNum].push({ 
                                id: streamIdRaw, 
                                episode_num: episodeNum, title: `Episode ${episodeNum}`, container_extension: "mkv", 
                                info: { movie_image: String(season.screenshot_uri || season.cover || ""), plot: "", releasedate: "", rating: "5", rating_5based: 5.0, duration_secs: 0, duration: "" }, 
                                custom_sid: "", added: "1600000000", season: parseInt(sNum), direct_source: ""
                            });
                        }
                        seasonsInfo.push({ air_date: "", episode_count: episodesArr.length, id: parseInt(sNum), name: `Season ${sNum}`, overview: "", season_number: parseInt(sNum), cover: "", cover_big: "" });
                        seasonIndex++;
                    }
                }
                if (seasonsInfo.length === 0) { seasonsInfo.push({ air_date: "", episode_count: 0, id: 1, name: "Season 1", overview: "", season_number: 1, cover: "", cover_big: "" }); epsObj["1"] = []; }
                responseData = { seasons: seasonsInfo, episodes: epsObj, info: { name: "GAMERDZ Series", cover: "", plot: "", cast: "", director: "", genre: "", releaseDate: "", rating: "5", rating_5based: 5.0 } };
            } catch(e) { responseData = safeFallback("get_series_info"); }
        }
        else if (apiAction === "get_short_epg" || apiAction === "get_simple_data_table") {
            responseData = { epg_listings: [] };
        }

        return res.json(responseData);
    } catch (e) { return res.json(safeFallback(apiAction)); }
});

app.get(['/live/:user/:pass/:stream', '/movie/:user/:pass/:stream', '/series/:user/:pass/:stream', '/:user/:pass/:stream'], async (req, res) => {
    const type = req.path.split('/')[1] || "live";
    const username = decodeURIComponent(req.params.user).trim();
    const reqPass = decodeURIComponent(req.params.pass).trim();
    let streamId = req.params.stream; if (streamId.includes('.')) streamId = streamId.split('.')[0];
    
    let authData = getAuthData(req);
    if (!authData || authData.mac.toLowerCase() !== username.toLowerCase()) return res.status(403).send("Unauthorized");
    
    let server = authData.srv;
    let stalkerMac = authData.mac; 

    try {
        if (type === "movie") return res.redirect(`${server}/play/movie.php?mac=${stalkerMac}&stream=${streamId}.mkv&type=${type}`);
        
        if (type === "series") {
            let actualId = streamId;
            let playToken = "";
            try {
                let decodedId = decodeSafeBase64(streamId);
                if (decodedId.includes("::::")) actualId = decodedId.split("::::")[0];
            } catch(e) {}
            
            if (actualId.includes("-")) {
                let idx = actualId.indexOf("-");
                playToken = actualId.substring(idx + 1);
                actualId = actualId.substring(0, idx);
            }

            let directUrl = `${server}/play/movie.php?mac=${stalkerMac}&stream=${actualId}.mkv&type=series`;
            if (playToken) directUrl += `&play_token=${playToken}`;
            return res.redirect(directUrl);
        }
        
        const handshakeRes = await callStalkerProxy(server, stalkerMac, "stb", "handshake");
        const stalkerToken = handshakeRes?.js?.token;
        if (!stalkerToken) return res.status(403).send("MAC Blocked");
        
        let cmd = encodeURIComponent(`ffmpeg localhost/ch/${streamId}`);
        let linkRes = await callStalkerProxy(server, stalkerMac, "itv", `create_link&cmd=${cmd}`, stalkerToken);
        let streamUrl = linkRes?.js?.cmd;
        
        if (!streamUrl) { 
            linkRes = await callStalkerProxy(server, stalkerMac, "itv", `create_link&cmd=${streamId}`, stalkerToken); 
            streamUrl = linkRes?.js?.cmd; 
        }
        
        if (streamUrl) { 
            let finalUrl = streamUrl.startsWith('ffmpeg ') ? streamUrl.split(' ').pop() : streamUrl; 
            return res.redirect(finalUrl); 
        }
        return res.status(404).send("Stream Not Found");
    } catch(e) { return res.status(500).send("Bridge Error"); }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
