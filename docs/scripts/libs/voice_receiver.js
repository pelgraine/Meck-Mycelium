// =============================================================================
// VoiceReceiver.js — Meck VE3 Voice Protocol receiver for Mycelium
//
// Receives voice messages from MeshCore audio devices (T-Deck Pro) via the
// companion protocol's PUSH_CODE_RAW_DATA (0x84) events.
//
// Protocol (dz0ny VE3):
//   1. Sender transmits a text DM with envelope: "VE3:{sid}:{mode}:{total}:{dur}"
//      Fields are base36 encoded. sid=sessionId, mode=codec2 mode (1=1200bps),
//      total=packet count, dur=duration in seconds.
//   2. Sender transmits voice data as PAYLOAD_TYPE_RAW_CUSTOM packets:
//      [0x56][sessionId:4B LE][packetIndex:1B][codec2 data...]
//   3. Receiver reassembles packets by index, decodes Codec2 → PCM, plays audio.
//
// Usage in Mycelium:
//   import VoiceReceiver from './voice_receiver.js';
//   const voiceRx = new VoiceReceiver();
//   
//   // Hook into meshcore.js connection events:
//   connection.on(Constants.PushCodes.RawData, (data) => {
//     voiceRx.onRawData(data.payload);
//   });
//   
//   // Hook into received DMs to detect VE3 envelopes:
//   // (in your message handler, check if text starts with "VE3:")
//   if (message.text.startsWith("VE3:")) {
//     voiceRx.onVE3Envelope(senderName, message.text);
//   }
//
// Codec2 WASM:
//   Requires codec2-emscripten WASM module. Load it before creating VoiceReceiver,
//   or call voiceRx.setCodec2Module(module) when ready.
//   See: https://github.com/rameshvarun/codec2-emscripten
//
// =============================================================================

// ---------------------------------------------------------------------------
// VE3 Protocol Constants (must match VoiceMessageScreen.h)
// ---------------------------------------------------------------------------
const VOICE_PKT_MAGIC    = 0x56;  // 'V' — voice data packet identifier
const VOICE_PKT_HDR_SIZE = 6;     // magic(1) + sessionId(4) + index(1)
const VOICE_MESH_PAYLOAD = 150;   // Max codec2 bytes per packet
const VOICE_C2_FRAME_BYTES = 6;   // Codec2 1200bps: 6 bytes per frame
const VOICE_C2_FRAME_SAMPLES = 320; // Codec2 1200bps: 320 samples per frame at 8kHz
const VOICE_C2_SAMPLE_RATE = 8000;  // Codec2 native sample rate
const VOICE_C2_MAX_BYTES = 1800;    // Max encoded data (12s × 25fps × 6B)
const VOICE_MAX_PACKETS  = 16;      // Max packets per session (bitmap is uint16)
const VOICE_SESSION_TTL_MS = 900000; // 15 minute session cache TTL

// ---------------------------------------------------------------------------
// Base36 decode (matches Meck's fromBase36)
// ---------------------------------------------------------------------------
function fromBase36(s) {
    let val = 0;
    for (let i = 0; i < s.length; i++) {
        val *= 36;
        const c = s.charAt(i);
        if (c >= '0' && c <= '9') val += c.charCodeAt(0) - 48;
        else if (c >= 'a' && c <= 'z') val += 10 + c.charCodeAt(0) - 97;
        else if (c >= 'A' && c <= 'Z') val += 10 + c.charCodeAt(0) - 65;
    }
    return val;
}

// ---------------------------------------------------------------------------
// Read uint32 little-endian from a Uint8Array at offset
// ---------------------------------------------------------------------------
function readU32LE(buf, offset) {
    return buf[offset] |
           (buf[offset + 1] << 8) |
           (buf[offset + 2] << 16) |
           ((buf[offset + 3] << 24) >>> 0);  // >>> 0 for unsigned
}

// ---------------------------------------------------------------------------
// VoiceReceiver
// ---------------------------------------------------------------------------
class VoiceReceiver {

    constructor() {
        // Active incoming sessions keyed by sessionId
        this.sessions = new Map();
this.orphanPackets = []; // Packets that arrived before their VE3 envelope
this.decodedAudio = new Map(); // sessionId → audioBuffer
        // Codec2 WASM module (set via setCodec2Module or loadCodec2Wasm)
        this.codec2Module = null;

        // Callback when a voice message is fully received and decoded
        // Signature: onVoiceReady({ senderName, durationSec, audioBuffer, sessionId })
        this.onVoiceReady = null;

        // Callback for progress updates
        // Signature: onProgress({ senderName, received, total, sessionId })
        this.onProgress = null;

        // Callback when a VE3 envelope arrives (new incoming session started)
        // Signature: onSessionStarted({ senderName, totalPackets, durationSec, sessionId })
        this.onSessionStarted = null;

        // Web Audio context (created lazily on first playback)
        this.audioCtx = null;
    }

    // =========================================================================
    // Codec2 WASM integration
    // =========================================================================

    /**
     * Set an already-loaded Codec2 WASM module.
     * The module must expose codec2_create, codec2_decode, codec2_destroy,
     * codec2_samples_per_frame, codec2_bits_per_frame, and memory management.
     */
    setCodec2Module(module) {
        this.codec2Module = module;
        console.log("VoiceReceiver: Codec2 WASM module set");
    }

    /**
     * Load codec2-emscripten WASM from a URL.
     * Expects the codec2.js + codec2.wasm files from:
     * https://github.com/rameshvarun/codec2-emscripten
     *
     * @param {string} jsUrl - URL to the codec2.js loader
     * @returns {Promise} resolves when module is ready
     */
async loadCodec2Wasm(jsUrl) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = jsUrl;
            script.onload = () => {
                if (typeof createC2Dec === 'function') {
                    this.codec2Module = true; // Flag that the script is loaded
                    console.log("VoiceReceiver: Codec2 WASM script loaded");
                    resolve();
                } else {
                    reject(new Error("createC2Dec not found after loading script"));
                }
            };
            script.onerror = () => reject(new Error("Failed to load codec2 WASM script"));
            document.head.appendChild(script);
        });
    }

    // =========================================================================
    // VE3 Envelope handling (from received DM text)
    // =========================================================================

    /**
     * Parse a VE3 envelope from a received DM.
     * Format: "VE3:{sid}:{mode}:{total}:{dur}" — all fields base36.
     *
     * Call this when you receive a text DM that starts with "VE3:".
     *
     * @param {string} senderName - Name of the contact who sent the voice message
     * @param {string} ve3Text - Full envelope text (e.g. "VE3:abc:1:4:5")
     */
    onVE3Envelope(senderName, ve3Text) {
        // Parse fields after "VE3:" prefix
        const body = ve3Text.substring(4); // skip "VE3:"
        const parts = body.split(':');
        if (parts.length < 3) {
            console.warn("VoiceReceiver: VE3 parse failed — need at least 3 fields, got", parts.length);
            return;
        }

        const sessionId   = fromBase36(parts[0]);
        const codecMode   = fromBase36(parts[1]); // 1 = Codec2 1200bps
        const totalPackets = fromBase36(parts[2]);
        const durationSec = parts.length >= 4 ? fromBase36(parts[3]) : 0;

        if (totalPackets === 0 || totalPackets > VOICE_MAX_PACKETS) {
            console.warn("VoiceReceiver: Invalid packet count:", totalPackets);
            return;
        }

        // Create or reset session
        const session = {
            sessionId,
            senderName,
            codecMode,
            totalPackets,
            durationSec,
            receivedBitmap: 0,
            receivedCount: 0,
            packets: new Array(totalPackets).fill(null), // ordered slots
            totalDataBytes: 0,
            startedAt: Date.now(),
            complete: false,
            decoded: false,
        };

        this.sessions.set(sessionId, session);

        console.log(`VoiceReceiver: Session 0x${sessionId.toString(16)} from "${senderName}" — expecting ${totalPackets} packets (${durationSec}s)`);

        // Notify listener
        if (this.onSessionStarted) {
            this.onSessionStarted({ senderName, totalPackets, durationSec, sessionId });
        }

        // Clean up old sessions
        this._cleanupSessions();
// Set a timeout to decode with whatever we have
        const timeoutMs = (totalPackets * 5000) + 10000;
        session.timeout = setTimeout(() => {
            if (!session.complete && session.receivedCount > 0) {
                console.log(`VoiceReceiver: Session timeout — decoding with ${session.receivedCount}/${session.totalPackets} packets`);
                session.complete = true;
                this._onSessionComplete(session);
            }
        }, timeoutMs);

        // Replay any orphan packets that match this session
        const orphansToReplay = this.orphanPackets.filter(p => p.sessionId === sessionId);
        this.orphanPackets = this.orphanPackets.filter(p => p.sessionId !== sessionId);
        for (const orphan of orphansToReplay) {
            console.log(`VoiceReceiver: Replaying orphan packet idx=${orphan.pktIdx}`);
            const fakePkt = new Uint8Array(VOICE_PKT_HDR_SIZE + orphan.codec2Data.length);
            fakePkt[0] = VOICE_PKT_MAGIC;
            fakePkt[1] = sessionId & 0xFF;
            fakePkt[2] = (sessionId >> 8) & 0xFF;
            fakePkt[3] = (sessionId >> 16) & 0xFF;
            fakePkt[4] = (sessionId >> 24) & 0xFF;
            fakePkt[5] = orphan.pktIdx;
            fakePkt.set(orphan.codec2Data, VOICE_PKT_HDR_SIZE);
            this.onRawData(fakePkt);
        }
    }

    // =========================================================================
    // Raw data packet handling (from PUSH_CODE_RAW_DATA events)
    // =========================================================================

    /**
     * Process a raw data payload from the companion protocol.
     * Call this from the connection's RawData event handler.
     *
     * @param {Uint8Array} payload - The raw payload bytes from PUSH_CODE_RAW_DATA
     */
    onRawData(payload) {
        // Check minimum length and magic byte
        if (!payload || payload.length < VOICE_PKT_HDR_SIZE + 1) return;
        if (payload[0] !== VOICE_PKT_MAGIC) return;  // Not a voice packet

        // Parse header
        const sessionId = readU32LE(payload, 1);
        const pktIdx = payload[5];
        const codec2Data = payload.slice(VOICE_PKT_HDR_SIZE);

        // Find matching session
       const session = this.sessions.get(sessionId);
        if (!session) {
            // Buffer orphan packets — they may arrive before the VE3 envelope
            this.orphanPackets.push({ sessionId, pktIdx, codec2Data: new Uint8Array(codec2Data) });
            console.log(`VoiceReceiver: Buffered orphan packet idx=${pktIdx} for session 0x${sessionId.toString(16)}`);
            return;
        }

        // Validate index
        if (pktIdx >= session.totalPackets || pktIdx >= VOICE_MAX_PACKETS) {
            console.warn(`VoiceReceiver: Packet index ${pktIdx} out of range (total=${session.totalPackets})`);
            return;
        }

        // Check for duplicate
        if (session.receivedBitmap & (1 << pktIdx)) {
            return; // Already have this packet
        }

        // Check data overflow
        if (session.totalDataBytes + codec2Data.length > VOICE_C2_MAX_BYTES) {
            console.warn("VoiceReceiver: Session data overflow");
            return;
        }

        // Store packet data in its ordered slot
        session.packets[pktIdx] = new Uint8Array(codec2Data);
        session.receivedBitmap |= (1 << pktIdx);
        session.receivedCount++;
        session.totalDataBytes += codec2Data.length;

        console.log(`VoiceReceiver: Packet ${session.receivedCount}/${session.totalPackets} (idx=${pktIdx}, ${codec2Data.length}B)`);

        // Notify progress
        if (this.onProgress) {
            this.onProgress({
                senderName: session.senderName,
                received: session.receivedCount,
                total: session.totalPackets,
                sessionId,
            });
        }

        // Check if complete
        if (session.receivedCount >= session.totalPackets) {
            session.complete = true;
            console.log(`VoiceReceiver: Session 0x${sessionId.toString(16)} complete — ${session.totalDataBytes} bytes from "${session.senderName}"`);
            this._onSessionComplete(session);
        }
    }

    // =========================================================================
    // Session completion — reassemble, decode, play
    // =========================================================================

    async _onSessionComplete(session) {
        if (session.decoded) return;
        session.decoded = true;
        if (session.timeout) clearTimeout(session.timeout);

        const allPcm = [];

        for (let i = 0; i < session.totalPackets; i++) {
            if (session.packets[i]) {
                // Decode this packet independently (fresh WASM instance each time)
                const pcm = await this._decodeCodec2(session.packets[i]);
                if (pcm) allPcm.push(pcm);
            } else {
                // Insert silence for the missing packet's duration
                // Full packet = 150 bytes = 25 frames × 320 samples = 1.0s at 8kHz
                const expectedFrames = Math.floor(VOICE_MESH_PAYLOAD / VOICE_C2_FRAME_BYTES);
                const silenceSamples = expectedFrames * VOICE_C2_FRAME_SAMPLES;
                allPcm.push(new Float32Array(silenceSamples));
                console.warn(`VoiceReceiver: Inserted ${(silenceSamples / VOICE_C2_SAMPLE_RATE).toFixed(1)}s silence for missing packet ${i}`);
            }
        }

        // Concatenate all PCM chunks
        const totalLength = allPcm.reduce((sum, arr) => sum + arr.length, 0);
        const combined = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of allPcm) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        console.log(`VoiceReceiver: Total decoded audio: ${(combined.length / VOICE_C2_SAMPLE_RATE).toFixed(1)}s`);

        const audioBuffer = this._createAudioBuffer(combined);

        if (this.onVoiceReady) {
            this.onVoiceReady({
                senderName: session.senderName,
                durationSec: session.durationSec,
                audioBuffer,
                sessionId: session.sessionId,
            });
        }
this.decodedAudio.set(session.sessionId, audioBuffer);
        this.playAudioBuffer(audioBuffer);
    }
    /**
     * Decode Codec2 1200bps data to 8kHz 16-bit PCM samples.
     * Returns Float32Array of samples normalised to [-1, 1] for Web Audio.
     *
     * If no WASM module is loaded, falls back to generating silence
     * (so the UI flow still works for testing).
     */
 _decodeCodec2(codec2Data) {
        const frameSamples = VOICE_C2_FRAME_SAMPLES;
        const frameBytes = VOICE_C2_FRAME_BYTES;
        const numFrames = Math.floor(codec2Data.length / frameBytes);

        if (numFrames === 0) {
            console.warn("VoiceReceiver: No complete codec2 frames in data");
            return null;
        }

        if (!this.codec2Module) {
            console.warn("VoiceReceiver: No Codec2 WASM module — generating silence placeholder");
            return new Float32Array(numFrames * frameSamples);
        }

        // Return a promise — decode is async because createC2Dec spins up a fresh WASM instance
        return new Promise((resolve, reject) => {
            const module = {
                arguments: ['1200', 'input.bit', 'output.raw'],
                preRun: () => {
                    module.FS.writeFile('input.bit', new Uint8Array(codec2Data));
                },
                postRun: () => {
                    try {
                        const rawPcm = module.FS.readFile('output.raw', { encoding: 'binary' });
                        const int16View = new Int16Array(rawPcm.buffer, rawPcm.byteOffset, rawPcm.byteLength / 2);
                        const pcm = new Float32Array(int16View.length);
                        for (let i = 0; i < int16View.length; i++) {
                            pcm[i] = int16View[i] / 32768.0;
                        }
                        console.log(`VoiceReceiver: Decoded ${numFrames} frames → ${pcm.length} samples (${(pcm.length / VOICE_C2_SAMPLE_RATE).toFixed(1)}s)`);
                        resolve(pcm);
                    } catch (e) {
                        reject(e);
                    }
                },
                locateFile: (path) => {
                    return './scripts/libs/codec2/' + path;
                }
            };
            createC2Dec(module);
        });
    }

    // =========================================================================
    // Web Audio playback
    // =========================================================================

    /**
     * Create a Web Audio AudioBuffer from decoded PCM samples.
     * Input is Float32Array at 8kHz mono.
     */
    _createAudioBuffer(pcmSamples) {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        const sampleRate = VOICE_C2_SAMPLE_RATE; // 8000
        const buffer = this.audioCtx.createBuffer(1, pcmSamples.length, sampleRate);
        buffer.copyToChannel(pcmSamples, 0);
        return buffer;
    }

    /**
     * Play an AudioBuffer through the device speakers.
     */
    playAudioBuffer(audioBuffer) {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        // Resume context if suspended (browsers require user gesture)
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }

        const source = this.audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioCtx.destination);
        source.start();

        console.log(`VoiceReceiver: Playing ${(audioBuffer.duration).toFixed(1)}s audio`);
    }

    // =========================================================================
    // Session management
    // =========================================================================

    /**
     * Remove sessions older than TTL.
     */
    _cleanupSessions() {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (now - session.startedAt > VOICE_SESSION_TTL_MS) {
                this.sessions.delete(id);
            }
        }
    }

    /**
     * Get info about active sessions (for UI display).
     */
    getActiveSessions() {
        const result = [];
        for (const [id, session] of this.sessions) {
            result.push({
                sessionId: id,
                senderName: session.senderName,
                totalPackets: session.totalPackets,
                receivedCount: session.receivedCount,
                durationSec: session.durationSec,
                complete: session.complete,
                decoded: session.decoded,
            });
        }
        return result;
    }
}

export default VoiceReceiver;