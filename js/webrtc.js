// wwwroot/js/webrtc.js

// =========================
// Konuşan Algılama (Border)
// =========================

// Her video için ayrı bir izleyici tutalım ki peer kapanınca durdurabilelim
const speakingMonitors = new Map();

var roomId = "";
var currentId = "";

let __kicking = false;

async function kickUser() {
    if (__kicking) return { ok: true, already: true };

    if (!roomId || !currentId) {
        console.warn("⚠️ roomId veya currentId tanımsız!");
        return { ok: false, error: "missing-params" };
    }

    __kicking = true;
    try {
        // 1) Sunucuya kick isteği
        const res = await fetch(`https://facetime-bpbxasa7fwg2hsbb.swedencentral-01.azurewebsites.net//api/room/${encodeURIComponent(roomId)}/kick/${encodeURIComponent(currentId)}`, {
            method: "POST"
        });

        if (!res.ok) {
            const errorText = await res.text();
            console.warn(`❌ Kick başarısız [${res.status}]:`, errorText);
            return { ok: false, status: res.status, error: errorText || res.statusText };
        }

        console.log(`✅ Kick ok: ${currentId}. Lokal temizlik başlatılıyor…`);

        // 2) Peer bağlantılarını kapat (sadece bu client)
        try {
            if (window.webrtc?.peers) {
                Object.keys(window.webrtc.peers).forEach(pid => window.webrtc.closePeer(pid));
                window.webrtc.peers = {};
            }
        } catch (e) { console.warn("Peer cleanup error:", e); }

        // 3) Konuşma izleyicilerini durdur
        try {
            if (typeof speakingMonitors !== "undefined") {
                for (const id of Array.from(speakingMonitors.keys())) stopMonitoring(id);
            }
        } catch (e) { console.warn("Monitor cleanup error:", e); }

        // 4) Local stream’i kapat
        try {
            if (window.webrtc?.localStream) {
                window.webrtc.localStream.getTracks().forEach(t => { try { t.stop(); } catch { } });
                window.webrtc.localStream = null;
            }
        } catch (e) { console.warn("Local stream stop error:", e); }

        // 5) Local video elementini temizle
        try {
            const lv = document.getElementById("local");
            if (lv) {
                try { lv.srcObject = null; } catch { }
                lv.removeAttribute("src");
                try { lv.load(); } catch { }
                lv.classList.remove("speaking");
            }
        } catch (e) { console.warn("Local video cleanup error:", e); }

        // 6) Remote videoları sessize al/sıfırla (Blazor elemanlarını DOM’dan kaldırmayız)
        try {
            document.querySelectorAll('video[id^="remote-"]').forEach(v => {
                try { v.srcObject = null; } catch { }
                v.removeAttribute("src");
                try { v.load(); } catch { }
                v.classList.remove("speaking");
            });
        } catch (e) { console.warn("Remote video cleanup error:", e); }

        // 7) Blazor’a haber ver (UI’ı temizle/navigate et vs.)
        try {
            window.webrtc?.dotnetRef?.invokeMethodAsync("OnKicked", "KickedBySelf");
        } catch (e) {
            console.warn("OnKicked notify failed:", e);
        }

        return { ok: true };
    } catch (err) {
        console.error("🚨 Kick isteğinde hata:", err);
        return { ok: false, error: err.message };
    } finally {
        __kicking = false;
    }
}
let __removingRoom = false;

async function removeRoom() {
    if (__removingRoom) return { ok: true, already: true };

    // roomId'yi bildiğimiz yerlerden çöz
    const id =
        (typeof roomId !== "undefined" && roomId) ||
        (window.webrtc && window.webrtc.currentRoomId) ||
        (window.location.pathname.split("/")[2] || "");

    if (!id) {
        console.warn("⚠️ roomId bulunamadı.");
        return { ok: false, error: "missing-roomId" };
    }

    __removingRoom = true;
    try {
        const res = await fetch(`https://facetime-bpbxasa7fwg2hsbb.swedencentral-01.azurewebsites.net/api/room/${encodeURIComponent(id)}`, { method: "DELETE" });

        if (!res.ok) {
            const errorText = await res.text();
            console.warn(`❌ RemoveRoom başarısız [${res.status}]:`, errorText);
            return { ok: false, status: res.status, error: errorText || res.statusText };
        }

        console.log(`✅ Oda kapatıldı: ${id}`);

        // Lokal temizlik (hemen UI toparlansın)
        try {
            if (window.webrtc?.onForceLeave) {
                await window.webrtc.onForceLeave("RoomClosed");
            } else {
                // Minimal fallback
                if (window.webrtc?.peers) {
                    Object.keys(window.webrtc.peers).forEach(pid => window.webrtc.closePeer(pid));
                    window.webrtc.peers = {};
                }
                if (window.webrtc?.localStream) {
                    window.webrtc.localStream.getTracks().forEach(t => { try { t.stop(); } catch { } });
                    window.webrtc.localStream = null;
                }
                const lv = document.getElementById("local");
                if (lv) { try { lv.srcObject = null; } catch { } lv.removeAttribute("src"); try { lv.load(); } catch { } }
                document.querySelectorAll('video[id^="remote-"]').forEach(v => {
                    try { v.srcObject = null; } catch { }
                    v.removeAttribute("src");
                    try { v.load(); } catch { }
                });
            }
        } catch (e) {
            console.warn("Lokal temizlik hatası:", e);
        }

        return { ok: true };
    } catch (err) {
        console.error("🚨 RemoveRoom isteğinde hata:", err);
        return { ok: false, error: err.message };
    } finally {
        __removingRoom = false;
    }
}

function monitorSpeaking(videoElementId) {
    if (speakingMonitors.has(videoElementId)) return;

    const video = document.getElementById(videoElementId);
    if (!video) return;

    const stream = video.srcObject;
    if (!stream) return;

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    const audioContext = new AudioContext();
    if (audioContext.state === "suspended") {
        const resumeOnce = () => { audioContext.resume(); window.removeEventListener("click", resumeOnce); };
        window.addEventListener("click", resumeOnce, { once: true });
    }

    const source = audioContext.createMediaStreamSource(new MediaStream([audioTracks[0]]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.fftSize);

    const TALK_ON = 0.022;
    let talking = false;
    let lastTalkTime = 0; // son konuşma zamanı (ms)
    let rafId = 0;

    const loop = () => {
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            const value = (dataArray[i] - 128) / 128;
            sum += value * value;
        }
        const volume = Math.sqrt(sum / dataArray.length);

        const now = performance.now();

        if (volume > TALK_ON) {
            talking = true;
            lastTalkTime = now;
        } else {
            // Ses yok ama son konuşmadan 1 saniye geçmediyse hala yeşil
            if (now - lastTalkTime > 1000) {
                talking = false;
            }
        }

        video.classList.toggle("speaking", talking);
        rafId = requestAnimationFrame(loop);
    };

    loop();
    speakingMonitors.set(videoElementId, { rafId, audioContext });
}

/** İzlemeyi bırak ve kaynakları serbest bırak. */
function stopMonitoring(videoElementId) {
    const m = speakingMonitors.get(videoElementId);
    if (!m) return;
    cancelAnimationFrame(m.rafId);
    try { m.audioContext.close(); } catch { /* no-op */ }
    speakingMonitors.delete(videoElementId);
}

/** Eleman hazır değilse kısa süre bekleyip yakala. */
function waitForElement(id, timeoutMs = 3000, intervalMs = 50) {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        const tick = () => {
            const el = document.getElementById(id);
            if (el) return resolve(el);
            if (performance.now() - start >= timeoutMs) return reject(new Error("Element timeout: " + id));
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

// ==================================
// WebRTC + Blazor arayüz nesnesi
// ==================================

window.webrtc = {
    localStream: null,
    peers: {},           // peerId -> RTCPeerConnection
    dotnetRef: null,     // .NET callback ref

    registerDotNetRef(ref) { this.dotnetRef = ref; },
    async getMedia(constraints) {
        if (!this.localStream) {
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia(
                    constraints || { video: true, audio: true }
                );
                return { ok: true, id: this.localStream.id };
            } catch (err) {
                console.warn("getUserMedia failed:", err);

                if (err.name === "NotReadableError" || err.name === "TrackStartError") {
                    alert("Kameranız başka bir uygulama tarafından kullanılıyor. Görüntü verilemeyecek, ancak sisteme giriş yapabilirsiniz.");

                    // Sadece mikrofonu almayı deneyelim
                    try {
                        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                        return { ok: true, id: this.localStream.id, warning: "video-unavailable" };
                    } catch (micErr) {
                        console.warn("Audio only getUserMedia failed:", micErr);
                        return { ok: false, error: micErr.message };
                    }
                }

                // Diğer hatalar
                return { ok: false, error: err.message };
            }
        }
        return { ok: true, id: this.localStream.id };
    },


    attachLocalVideo(elementId) {
        const el = document.getElementById(elementId);
        if (el && this.localStream) {
            el.srcObject = this.localStream;
            // Local konuşma algılama
            monitorSpeaking(elementId);
        }
    },

    async createPeer(peerId, iceServersJson) {
        const iceServers = iceServersJson
            ? JSON.parse(iceServersJson)
            : [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" }
            ];

        const pc = new RTCPeerConnection({ iceServers });

        // Local track'leri ekle
        if (this.localStream) {
            this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
        }

        // Remote track geldiğinde UI'ya bağla
        pc.ontrack = async (ev) => {
            const id = `remote-${peerId}`;
            try {
                const el = await waitForElement(id);
                if (ev.streams && ev.streams[0]) {
                    el.srcObject = ev.streams[0];
                    // Autoplay politikaları: kullanıcı etkileşimi yoksa play() reddedilebilir
                    el.play().catch(() => { /* sessizce geç */ });
                    monitorSpeaking(id);
                }
            } catch {
                // Element hiç oluşmadıysa (layout geciktiyse) fallback olarak oluştur.
                let el = document.getElementById(id);
                if (!el) {
                    el = document.createElement('video');
                    el.id = id;
                    el.autoplay = true;
                    el.playsInline = true;
                    // UYARI: remote sesin duyulması için muted=false olmalı;
                    // ancak bazı tarayıcılarda kullanıcı etkileşimi olmadan sesli autoplay engellenir.
                    el.muted = false;
                    document.body.appendChild(el);
                }
                if (ev.streams && ev.streams[0]) {
                    el.srcObject = ev.streams[0];
                    el.play().catch(() => { /* no-op */ });
                    monitorSpeaking(id);
                }
            }

            this.dotnetRef?.invokeMethodAsync('OnRemoteTrack', peerId);
        };

        // ICE candidate gönder
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.dotnetRef?.invokeMethodAsync('OnLocalIce', peerId, JSON.stringify(e.candidate));
            }
        };

        // Teşhis logları
        pc.oniceconnectionstatechange = () => console.log('ice:', pc.iceConnectionState, 'peer:', peerId);
        pc.onconnectionstatechange = () => console.log('pc :', pc.connectionState, 'peer:', peerId);

        this.peers[peerId] = pc;
        return { ok: true };
    },

    async makeOffer(peerId) {
        const pc = this.peers[peerId];
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        return JSON.stringify(offer);
    },

    async setRemoteDescription(peerId, sdpJson) {
        const pc = this.peers[peerId];
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sdpJson)));
        return { ok: true };
    },

    async makeAnswer(peerId) {
        const pc = this.peers[peerId];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        return JSON.stringify(answer);
    },

    async addIce(peerId, iceJson) {
        const pc = this.peers[peerId];
        if (!pc || !iceJson) return { ok: false };
        try {
            await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(iceJson)));
            return { ok: true };
        } catch (e) {
            console.warn('addIce failed', e);
            return { ok: false, error: e?.message };
        }
    },

    setTrackEnabled(kind, enabled) {
        const s = this.localStream; if (!s) return;
        const tracks = (kind === 'audio') ? s.getAudioTracks() : s.getVideoTracks();
        tracks.forEach(t => t.enabled = !!enabled);
    },

    closePeer(peerId) {
        const pc = this.peers[peerId];
        if (pc) {
            pc.close();
            delete this.peers[peerId];
        }
        // Monitoring'i durdur
        stopMonitoring(`remote-${peerId}`);
        // Dinamik oluşturulmuşsa DOM'dan da kaldır (senin layout'un videoları zaten yönetiyorsa gerekmez)
        const el = document.getElementById(`remote-${peerId}`);
        if (el && el.dataset.dynamic === "true") {
            el.remove();
        }
    }
};

// JS hazır bayrağı
window.webrtcReady = true;
console.log("webrtc.js loaded");
