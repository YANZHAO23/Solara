/**
 * 一起听：主持人-听众同步播放（WebRTC 直连，无需后端服务器）
 *
 * v1 范围（主持人控制、听众跟随）：
 * - 主持人点「一起听」创建房间，得到一串房间码，发给朋友；
 * - 朋友粘贴房间码，得到一串回执码，发回给主持人粘贴，双方直连；
 * - 直连后主持人的播放状态（当前歌曲、歌单、进度、播放/暂停、切歌）
 *   会实时同步到听众端；听众端手动操作会在下一次同步时被覆盖。
 * - 听众断开后自动恢复自己原来的歌单（并刷新页面重渲染）。
 *
 * 信令说明：没有中央服务器，房间码/回执码本身就是 SDP（会话描述），
 * 需通过微信/QQ 等渠道手动转发一次。两人用同一个站（主站或备用站均可）
 * 打开播放器即可，信令文本与站点无关。
 */

import { setAudioCurrentTime } from "../core/audio.js";
import { safeGetLocalStorage, safeSetLocalStorage, safeRemoveLocalStorage } from "../core/storage.js";

const BACKUP_KEY = "togetherGuestBackup";
const CHANNEL_LABEL = "solara-together";
const SYNC_DRIFT_SECONDS = 2;
const HEARTBEAT_MS = 3000;
const POLL_MS = 2000;
const ICE_TIMEOUT_MS = 8000;
const STUN_URL = "stun:stun.l.google.com:19302";

// ---------- 编解码：SDP <-> 可粘贴文本 ----------

function encodeSDP(sdp) {
    const utf8 = unescape(encodeURIComponent(sdp));
    return btoa(utf8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeSDP(code) {
    const cleaned = (code || "").trim().replace(/\s+/g, "");
    if (!cleaned) throw new Error("empty");
    const base64 = cleaned.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return decodeURIComponent(escape(atob(padded)));
}

// ---------- 小工具 ----------

function songMeta(song) {
    if (!song) return null;
    return { id: song.id, name: song.name, artist: song.artist, source: song.source };
}

function sameSong(a, b) {
    if (!a || !b) return false;
    return String(a.id) === String(b.id) && String(a.source || "netease") === String(b.source || "netease");
}

function waitForIceComplete(pc) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            pc.removeEventListener("icegatheringstatechange", onChange);
            resolve();
        }, ICE_TIMEOUT_MS);
        const onChange = () => {
            if (pc.iceGatheringState === "complete") {
                clearTimeout(timer);
                pc.removeEventListener("icegatheringstatechange", onChange);
                resolve();
            }
        };
        pc.addEventListener("icegatheringstatechange", onChange);
    });
}

export function initListenTogether(state, dom, callbacks = {}) {
    const playPlaylistSong = callbacks.playPlaylistSong;
    const audio = () => dom.audioPlayer;

    // 残留备份自愈：上次以听众身份退出时没来得及恢复，先恢复再清掉
    try {
        const leftover = safeGetLocalStorage(BACKUP_KEY);
        if (leftover) {
            const backup = JSON.parse(leftover);
            if (Array.isArray(backup.playlistSongs)) {
                safeSetLocalStorage("playlistSongs", JSON.stringify(backup.playlistSongs));
                state.playlistSongs = backup.playlistSongs;
            }
            if (Number.isInteger(backup.currentTrackIndex)) {
                safeSetLocalStorage("currentTrackIndex", String(backup.currentTrackIndex));
                state.currentTrackIndex = backup.currentTrackIndex;
            }
        }
    } catch (e) { /* 备份损坏则忽略 */ }
    safeRemoveLocalStorage(BACKUP_KEY);

    const session = {
        role: null, // 'host' | 'guest'
        pc: null,
        channel: null,
        connected: false,
        following: false,
        latestState: null,
        guestBackup: null,
        heartbeatTimer: null,
        pollTimer: null,
        lastSentSongId: null,
        lastSentPlaying: null,
    };

    // ---------- 面板 UI（纯 JS 生成，不动现有 DOM 结构） ----------

    let els = {};
    const panel = document.createElement("div");
    panel.className = "together-overlay";
    panel.style.display = "none";
    panel.innerHTML = `
        <div class="together-card" role="dialog" aria-label="一起听">
            <div class="together-head">
                <span class="together-title">一起听</span>
                <button class="together-close" type="button" aria-label="关闭">×</button>
            </div>
            <p class="together-hint">主持人播什么，听众就同步听到什么。两人需同时在线，同步约有 1–2 秒延迟。</p>
            <div class="together-modes">
                <button class="together-mode-btn" data-mode="host" type="button">我是主持人</button>
                <button class="together-mode-btn" data-mode="guest" type="button">我是听众</button>
            </div>
            <div class="together-section" data-section="host" style="display:none">
                <button class="together-action" data-action="host-create" type="button">创建房间</button>
                <p class="together-status" data-status="host"></p>
                <label class="together-label">房间码（复制发给朋友）</label>
                <textarea class="together-code" data-field="host-code" readonly placeholder="点「创建房间」后这里会出现房间码"></textarea>
                <button class="together-action" data-action="host-copy" type="button">复制房间码</button>
                <label class="together-label">朋友的回执码（粘贴到这里）</label>
                <textarea class="together-code" data-field="host-answer" placeholder="粘贴朋友发回的回执码"></textarea>
                <button class="together-action" data-action="host-confirm" type="button">确认连接</button>
            </div>
            <div class="together-section" data-section="guest" style="display:none">
                <label class="together-label">主持人的房间码（粘贴到这里）</label>
                <textarea class="together-code" data-field="guest-code" placeholder="粘贴主持人发来的房间码"></textarea>
                <button class="together-action" data-action="guest-join" type="button">连接</button>
                <p class="together-status" data-status="guest"></p>
                <label class="together-label">回执码（复制发回给主持人）</label>
                <textarea class="together-code" data-field="guest-answer" readonly placeholder="点「连接」后这里会出现回执码"></textarea>
                <button class="together-action" data-action="guest-copy" type="button">复制回执码</button>
                <button class="together-action together-primary" data-action="guest-follow" type="button" style="display:none">开始跟听</button>
            </div>
            <div class="together-foot">
                <span class="together-conn" data-field="conn">未连接</span>
                <button class="together-action together-danger" data-action="disconnect" type="button" style="display:none">断开</button>
            </div>
        </div>`;
    document.body.appendChild(panel);
    const q = (sel) => panel.querySelector(sel);
    els = {
        close: q(".together-close"),
        hostSection: q('[data-section="host"]'),
        guestSection: q('[data-section="guest"]'),
        hostStatus: q('[data-status="host"]'),
        guestStatus: q('[data-status="guest"]'),
        hostCode: q('[data-field="host-code"]'),
        hostAnswer: q('[data-field="host-answer"]'),
        guestCode: q('[data-field="guest-code"]'),
        guestAnswer: q('[data-field="guest-answer"]'),
        followBtn: q('[data-action="guest-follow"]'),
        disconnectBtn: q('[data-action="disconnect"]'),
        conn: q('[data-field="conn"]'),
    };

    const entryBtn = document.getElementById("togetherBtn");
    if (entryBtn) {
        entryBtn.addEventListener("click", () => {
            panel.style.display = "flex";
        });
    }
    els.close.addEventListener("click", () => {
        panel.style.display = "none";
    });
    panel.addEventListener("click", (e) => {
        if (e.target === panel) panel.style.display = "none";
    });
    panel.querySelectorAll(".together-mode-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            panel.querySelectorAll(".together-mode-btn").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            const mode = btn.dataset.mode;
            els.hostSection.style.display = mode === "host" ? "block" : "none";
            els.guestSection.style.display = mode === "guest" ? "block" : "none";
        });
    });
    panel.querySelectorAll("[data-action]").forEach((btn) => {
        btn.addEventListener("click", () => handleAction(btn.dataset.action));
    });

    // ---------- 会话逻辑 ----------

    function setStatus(role, text) {
        const el = role === "host" ? els.hostStatus : els.guestStatus;
        if (el) el.textContent = text || "";
    }

    function setConn(text, on) {
        els.conn.textContent = text;
        els.conn.classList.toggle("on", Boolean(on));
        if (entryBtn) entryBtn.classList.toggle("is-together", Boolean(on));
        els.disconnectBtn.style.display = on ? "inline-block" : "none";
    }

    function send(obj) {
        if (session.channel && session.channel.readyState === "open") {
            try {
                session.channel.send(JSON.stringify(obj));
            } catch (e) { /* 发送失败则等下一次同步 */ }
        }
    }

    function currentQueue() {
        if (state.currentList === "favorite") return { list: "favorite", songs: state.favoriteSongs || [], index: state.currentFavoriteIndex || 0 };
        if (state.currentPlaylist === "online") return { list: "online", songs: state.onlineSongs || [], index: state.currentTrackIndex || 0 };
        if (state.currentPlaylist === "search") return { list: "search", songs: state.searchResults || [], index: state.currentTrackIndex || 0 };
        return { list: "playlist", songs: state.playlistSongs || [], index: state.currentTrackIndex || 0 };
    }

    function buildState() {
        const a = audio();
        const queue = currentQueue();
        let songs = queue.songs;
        // 歌单过大时只同步当前一首，避免单条消息超限
        try {
            if (JSON.stringify(songs).length > 60000) songs = state.currentSong ? [state.currentSong] : [];
        } catch (e) { songs = state.currentSong ? [state.currentSong] : []; }
        return {
            v: 1,
            song: songMeta(state.currentSong),
            queue: songs,
            index: songs.length === 1 ? 0 : queue.index,
            pos: a ? (a.currentTime || 0) : 0,
            playing: a ? !a.paused : false,
            at: Date.now(),
        };
    }

    function broadcast(force) {
        if (session.role !== "host" || !session.connected) return;
        const s = buildState();
        if (!force && sameSong(s.song, { id: session.lastSentSongId }) && s.playing === session.lastSentPlaying) return;
        session.lastSentSongId = s.song ? s.song.id : null;
        session.lastSentPlaying = s.playing;
        send({ t: "state", state: s });
    }

    function startHostSync() {
        stopSyncTimers();
        const a = audio();
        if (a) {
            a.addEventListener("play", onHostTransport);
            a.addEventListener("pause", onHostTransport);
            a.addEventListener("seeked", onHostTransport);
            a.addEventListener("ended", onHostEnded);
        }
        session.pollTimer = setInterval(() => {
            const s = buildState();
            const songChanged = !sameSong(s.song, { id: session.lastSentSongId });
            if (songChanged) broadcast(true);
        }, POLL_MS);
        session.heartbeatTimer = setInterval(() => broadcast(true), HEARTBEAT_MS);
    }

    function onHostTransport() {
        broadcast(true);
    }

    function onHostEnded() {
        // 切歌需要等 playSong 起播，延迟一次再同步
        setTimeout(() => broadcast(true), 600);
    }

    function stopSyncTimers() {
        if (session.pollTimer) clearInterval(session.pollTimer);
        if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
        session.pollTimer = null;
        session.heartbeatTimer = null;
        const a = audio();
        if (a) {
            a.removeEventListener("play", onHostTransport);
            a.removeEventListener("pause", onHostTransport);
            a.removeEventListener("seeked", onHostTransport);
            a.removeEventListener("ended", onHostEnded);
        }
    }

    function stashGuestBackup() {
        if (session.guestBackup) return;
        session.guestBackup = {
            playlistSongs: Array.isArray(state.playlistSongs) ? state.playlistSongs.slice() : [],
            currentTrackIndex: state.currentTrackIndex,
        };
        try {
            safeSetLocalStorage(BACKUP_KEY, JSON.stringify(session.guestBackup));
        } catch (e) { /* 备份写失败则仅保留内存份 */ }
    }

    function restoreGuestBackup() {
        const backup = session.guestBackup;
        session.guestBackup = null;
        safeRemoveLocalStorage(BACKUP_KEY);
        if (!backup) return;
        try {
            safeSetLocalStorage("playlistSongs", JSON.stringify(backup.playlistSongs));
            safeSetLocalStorage("currentTrackIndex", String(backup.currentTrackIndex));
        } catch (e) { /* 忽略 */ }
        // 歌单 UI 由各渲染函数持有，刷新是最稳妥的重渲染方式
        window.location.reload();
    }

    async function applyGuestState(s) {
        if (!s || !s.song) return;
        const a = audio();
        if (!a) return;
        const queue = Array.isArray(s.queue) ? s.queue : [];
        const queueChanged = JSON.stringify(queue.map((x) => x.id)) !== JSON.stringify((state.playlistSongs || []).map((x) => x.id));
        if (queue.length > 0 && queueChanged) {
            stashGuestBackup();
            state.playlistSongs = queue;
            state.currentPlaylist = "playlist";
            state.currentList = "playlist";
        }
        const songChanged = !sameSong(state.currentSong, s.song);
        if (songChanged) {
            if (typeof playPlaylistSong === "function" && queue.length > 0) {
                state.currentTrackIndex = Math.min(Math.max(s.index || 0, 0), queue.length - 1);
                await playPlaylistSong(state.currentTrackIndex, {
                    startTime: Math.max(s.pos || 0, 0),
                    autoplay: s.playing !== false,
                });
            } else {
                return;
            }
        } else {
            if (Math.abs((a.currentTime || 0) - (s.pos || 0)) > SYNC_DRIFT_SECONDS) {
                try {
                    setAudioCurrentTime(Math.max(s.pos || 0, 0), state, dom);
                } catch (e) {
                    a.currentTime = Math.max(s.pos || 0, 0);
                }
            }
            if (s.playing && a.paused) {
                const p = a.play();
                if (p && typeof p.catch === "function") p.catch(() => {});
            } else if (!s.playing && !a.paused) {
                a.pause();
            }
        }
    }

    function onChannelMessage(event) {
        let msg = null;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            return;
        }
        if (!msg) return;
        if (msg.t === "state" && session.role === "guest") {
            session.latestState = msg.state;
            const name = msg.state && msg.state.song ? msg.state.song.name : "";
            if (!session.following) {
                setStatus("guest", name ? `已收到主持人状态：${name}，点「开始跟听」加入` : "已收到主持人状态，点「开始跟听」加入");
            } else {
                applyGuestState(msg.state);
            }
        } else if (msg.t === "hello" && session.role === "host") {
            broadcast(true);
        }
    }

    function onChannelOpen() {
        session.connected = true;
        if (session.role === "host") {
            setStatus("host", "已连接！你播什么朋友就同步听到什么。");
            setConn("主持人 · 已连接", true);
            startHostSync();
            broadcast(true);
        } else {
            setStatus("guest", "已连接！点「开始跟听」后会同步主持人的播放。");
            setConn("听众 · 已连接", true);
            els.followBtn.style.display = "inline-block";
            send({ t: "hello" });
        }
    }

    function onChannelClose() {
        if (!session.connected && !session.pc) return;
        const wasGuest = session.role === "guest";
        const wasFollowing = session.following;
        session.connected = false;
        session.following = false;
        setConn("未连接", false);
        if (wasGuest && wasFollowing) {
            restoreGuestBackup();
        }
    }

    function createPeer() {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URL }] });
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed" || pc.connectionState === "closed") {
                setStatus(session.role || "guest", "连接失败：两人可能不在同一网络环境，点「断开」后重试一次。");
            }
        };
        return pc;
    }

    function bindChannel(channel) {
        session.channel = channel;
        channel.onopen = onChannelOpen;
        channel.onmessage = onChannelMessage;
        channel.onclose = onChannelClose;
    }

    function teardown() {
        stopSyncTimers();
        try {
            if (session.channel) session.channel.close();
        } catch (e) {}
        try {
            if (session.pc) session.pc.close();
        } catch (e) {}
        const wasGuest = session.role === "guest";
        const wasFollowing = session.following;
        session.role = null;
        session.pc = null;
        session.channel = null;
        session.connected = false;
        session.following = false;
        session.latestState = null;
        setConn("未连接", false);
        els.followBtn.style.display = "none";
        if (wasGuest && wasFollowing) {
            restoreGuestBackup();
        }
    }

    async function handleAction(action) {
        try {
            if (action === "host-create") {
                teardown();
                session.role = "host";
                setStatus("host", "正在生成房间码（约 1–3 秒）…");
                const pc = createPeer();
                session.pc = pc;
                bindChannel(pc.createDataChannel(CHANNEL_LABEL));
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await waitForIceComplete(pc);
                els.hostCode.value = encodeSDP(pc.localDescription.sdp);
                setStatus("host", "房间码已生成：复制发给朋友，等朋友发回回执码。");
            } else if (action === "host-copy") {
                if (!els.hostCode.value) {
                    setStatus("host", "还没有房间码，先点「创建房间」。");
                    return;
                }
                await navigator.clipboard.writeText(els.hostCode.value);
                setStatus("host", "房间码已复制，发给朋友吧。");
            } else if (action === "host-confirm") {
                if (!session.pc || session.role !== "host") {
                    setStatus("host", "请先创建房间。");
                    return;
                }
                const sdp = decodeSDP(els.hostAnswer.value);
                await session.pc.setRemoteDescription({ type: "answer", sdp });
                setStatus("host", "回执码已确认，正在建立连接…");
            } else if (action === "guest-join") {
                teardown();
                session.role = "guest";
                setStatus("guest", "正在生成回执码（约 1–3 秒）…");
                const pc = createPeer();
                session.pc = pc;
                pc.ondatachannel = (e) => bindChannel(e.channel);
                const sdp = decodeSDP(els.guestCode.value);
                await pc.setRemoteDescription({ type: "offer", sdp });
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                await waitForIceComplete(pc);
                els.guestAnswer.value = encodeSDP(pc.localDescription.sdp);
                setStatus("guest", "回执码已生成：复制发回给主持人，等他确认后点「开始跟听」。");
            } else if (action === "guest-copy") {
                if (!els.guestAnswer.value) {
                    setStatus("guest", "还没有回执码，先粘贴房间码并点「连接」。");
                    return;
                }
                await navigator.clipboard.writeText(els.guestAnswer.value);
                setStatus("guest", "回执码已复制，发回给主持人吧。");
            } else if (action === "guest-follow") {
                if (!session.connected) {
                    setStatus("guest", "还没连上，等主持人确认回执码后再点。");
                    return;
                }
                session.following = true;
                els.followBtn.style.display = "none";
                setStatus("guest", "跟听中：主持人切歌、暂停都会同步过来，你的手动操作会被同步覆盖。");
                if (session.latestState) await applyGuestState(session.latestState);
                send({ t: "hello" });
            } else if (action === "disconnect") {
                setStatus(session.role || "guest", "已断开。");
                teardown();
            }
        } catch (e) {
            const role = session.role || "guest";
            if (action === "guest-join" || action === "host-confirm") {
                setStatus(role, "码不对或已过期：请确认复制完整（不要多空格、不要截断），重新生成一次再试。");
            } else if (action === "host-copy" || action === "guest-copy") {
                setStatus(role, "复制失败：长按码框手动全选复制。");
            } else {
                setStatus(role, `操作失败：${e && e.message ? e.message : e}`);
            }
        }
    }

    return {
        disconnect: teardown,
        get connected() {
            return session.connected;
        },
    };
}
