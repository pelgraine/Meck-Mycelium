// =============================================================================
// VoiceReceiver.js — Meck VE3 Voice Protocol receiver for Mycelium
//
// Receives voice messages from MeshCore audio devices (T-Deck Pro, Meck-P4,
// Meck Watch) via the companion protocol's PUSH_CODE_RAW_DATA (0x84) events.
//
// Protocol (dz0ny VE3):
//   1. Sender transmits a text DM with envelope: "VE3:{sid}:{mode}:{total}:{dur}"
//      Fields are base36 encoded. sid=sessionId, mode=codec2 mode (1=1200bps),
//      total=packet count, dur=duration in seconds.
//   2. Sender transmits voice data as PAYLOAD_TYPE_RAW_CUSTOM packets:
//      [0x56][sessionId:4B LE][packetIndex:1B][codec2 data...]
//   3. Receiver reassembles packets by index, decodes Codec2 → PCM, plays audio.
//
// Decoding and the playback filter (Meck Watch "version B") are in
// voice_codec.js. Each run of packets that arrived is decoded in one go, and
// a missing packet becomes a second of silence.
// =============================================================================

import { decodeNote, playPcm16k, VOICE_MAX_BYTES, VOICE_MAX_PACKETS } from "./voice_codec.js";

// ---------------------------------------------------------------------------
// VE3 Protocol Constants (must match VoiceMessageScreen.h)
// ---------------------------------------------------------------------------
const VOICE_PKT_MAGIC    = 0x56;  // 'V' — voice data packet identifier
const VOICE_PKT_HDR_SIZE = 6;     // magic(1) + sessionId(4) + index(1)
const VOICE_SESSION_TTL_MS = 900000; // 15 minute session cache TTL

// ---------------------------------------------------------------------------
// Base36 decode (matches Meck's fromBase36)
// ---------------------------------------------------------------------------
export function fromBase36(s) {
    let val = 0;
    for (let i = 0; i < s.length; i++) {
        val *= 36;
        const c = s.charAt(i);
        if (c >= '0' && c <= '9') val += c.charCodeAt(0) - 48;
        else if (c >= 'a' && c <= 'z') val += 10 + c.charCodeAt(0) - 97;
        else if (c >= 'A' && c <= 'Z') val += 10 + c.charCodeAt(0) - 65;
    }
    return val >>> 0;
}

// ---------------------------------------------------------------------------
// Read uint32 little-endian from a Uint8Array at offset
// ---------------------------------------------------------------------------
function readU32LE(buf, offset) {
    return (buf[offset] |
           (buf[offset + 1] << 8) |
           (buf[offset + 2] << 16) |
           (buf[offset + 3] << 24)) >>> 0;
}

// Parses a VE3 envelope. Returns null if it isn't one.
export function parseVE3(text) {
    if (!text || !text.startsWith("VE3:")) return null;
    const parts = text.substring(4).split(':');
    if (parts.length < 3) return null;
    return {
        sessionId: fromBase36(parts[0]),
        codecMode: fromBase36(parts[1]),
        totalPackets: fromBase36(parts[2]),
        durationSec: parts.length >= 4 ? fromBase36(parts[3]) : 0,
    };
}

// ---------------------------------------------------------------------------
// VoiceReceiver
// ---------------------------------------------------------------------------
class VoiceReceiver {

    constructor() {
        // Active incoming sessions keyed by sessionId
        this.sessions = new Map();
        this.orphanPackets = []; // Packets that arrived before their VE3 envelope
        this.decodedAudio = new Map(); // sessionId → 16 kHz Float32 samples

        // Callback when a voice message is fully received and decoded
        // Signature: onVoiceReady({ senderName, durationSec, sessionId, recordId, packets, samples })
        this.onVoiceReady = null;

        // Callback for progress updates
        // Signature: onProgress({ senderName, received, total, sessionId })
        this.onProgress = null;

        // Callback when a VE3 envelope arrives (new incoming session started)
        // Signature: onSessionStarted({ senderName, totalPackets, durationSec, sessionId })
        this.onSessionStarted = null;
    }

    // =========================================================================
    // VE3 Envelope handling (from received DM text)
    // =========================================================================

    /**
     * Call this when you receive a text DM that starts with "VE3:".
     *
     * @param {string} senderName - Name of the contact who sent the voice message
     * @param {string} ve3Text - Full envelope text (e.g. "VE3:abc:1:4:5")
     * @param {number|null} recordId - The stored message's id, passed back in onVoiceReady
     */
    onVE3Envelope(senderName, ve3Text, recordId = null) {
        const envelope = parseVE3(ve3Text);
        if (!envelope) {
            console.warn("VoiceReceiver: VE3 parse failed");
            return;
        }
        const { sessionId, codecMode, totalPackets, durationSec } = envelope;

        if (totalPackets === 0 || totalPackets > VOICE_MAX_PACKETS) {
            console.warn("VoiceReceiver: Invalid packet count:", totalPackets);
            return;
        }

        // Create or reset session
        const session = {
            sessionId,
            senderName,
            recordId,
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

        if (this.onSessionStarted) {
            this.onSessionStarted({ senderName, totalPackets, durationSec, sessionId });
        }

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
            this._addPacket(session, orphan.pktIdx, orphan.codec2Data);
        }
    }

    // =========================================================================
    // Raw data packet handling (from PUSH_CODE_RAW_DATA events)
    // =========================================================================

    onRawData(payload) {
        if (!payload || payload.length < VOICE_PKT_HDR_SIZE + 1) return;
        if (payload[0] !== VOICE_PKT_MAGIC) return;  // Not a voice packet

        const sessionId = readU32LE(payload, 1);
        const pktIdx = payload[5];
        const codec2Data = payload.slice(VOICE_PKT_HDR_SIZE);

        const session = this.sessions.get(sessionId);
        if (!session) {
            // Buffer orphan packets — they may arrive before the VE3 envelope
            this.orphanPackets.push({ sessionId, pktIdx, codec2Data: new Uint8Array(codec2Data) });
            if (this.orphanPackets.length > 64) this.orphanPackets.shift();
            console.log(`VoiceReceiver: Buffered orphan packet idx=${pktIdx} for session 0x${sessionId.toString(16)}`);
            return;
        }
        this._addPacket(session, pktIdx, codec2Data);
    }

    _addPacket(session, pktIdx, codec2Data) {
        if (session.decoded) return;

        if (pktIdx >= session.totalPackets || pktIdx >= VOICE_MAX_PACKETS) {
            console.warn(`VoiceReceiver: Packet index ${pktIdx} out of range (total=${session.totalPackets})`);
            return;
        }
        if (session.receivedBitmap & (1 << pktIdx)) return; // duplicate
        if (session.totalDataBytes + codec2Data.length > VOICE_MAX_BYTES) {
            console.warn("VoiceReceiver: Session data overflow");
            return;
        }

        session.packets[pktIdx] = new Uint8Array(codec2Data);
        session.receivedBitmap |= (1 << pktIdx);
        session.receivedCount++;
        session.totalDataBytes += codec2Data.length;

        console.log(`VoiceReceiver: Packet ${session.receivedCount}/${session.totalPackets} (idx=${pktIdx}, ${codec2Data.length}B)`);

        if (this.onProgress) {
            this.onProgress({
                senderName: session.senderName,
                received: session.receivedCount,
                total: session.totalPackets,
                sessionId: session.sessionId,
            });
        }

        if (session.receivedCount >= session.totalPackets) {
            session.complete = true;
            console.log(`VoiceReceiver: Session 0x${session.sessionId.toString(16)} complete — ${session.totalDataBytes} bytes from "${session.senderName}"`);
            this._onSessionComplete(session);
        }
    }

    // =========================================================================
    // Session completion — decode, hand back, play
    // =========================================================================

    async _onSessionComplete(session) {
        if (session.decoded) return;
        session.decoded = true;
        if (session.timeout) clearTimeout(session.timeout);

        let samples = null;
        try {
            samples = await decodeNote(session.packets);
        } catch (e) {
            console.warn("VoiceReceiver: decode failed", e);
        }

        if (samples) this.decodedAudio.set(session.sessionId, samples);

        if (this.onVoiceReady) {
            this.onVoiceReady({
                senderName: session.senderName,
                durationSec: session.durationSec,
                sessionId: session.sessionId,
                recordId: session.recordId,
                packets: session.packets,
                samples,
            });
        }

        if (samples) {
            playPcm16k(samples).catch(() => {});
        }
    }

    _cleanupSessions() {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (now - session.startedAt > VOICE_SESSION_TTL_MS) {
                this.sessions.delete(id);
            }
        }
    }

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
