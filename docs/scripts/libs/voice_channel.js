// =============================================================================
// voice_channel.js -- voice messages on the #meck-voice channel, in the format
// Meck Watch (WatchVoiceScreen.h / MyMesh.cpp) and Meck-P4 (MeckVoice.h /
// meck_app.cpp) use:
//
//   channel data, data type 0xFF56, on the #meck-voice hashtag channel,
//   flood-scoped to the au-nsw-voice region, so only repeaters that list it
//   carry voice
//
//   'H' header  [0x56]['H'][sid:4 LE][total][dur s][sender name...]
//   'D' data    [0x56]['D'][sid:4 LE][idx][total][len][Codec2 x len]
//
// The sender sends the header, then packet p after 3000 + p x 3000 ms. No
// confirmation comes back. A data packet carries the packet count, so a
// message can start from its data if the header is lost.
//
// Uses only standard companion commands (54 flood scope, 62 channel data,
// 31/32 channels), so it works through stock MeshCore companion firmware.
// =============================================================================

import { splitPackets, durationSeconds, decodeNote, VOICE_MAX_BYTES, VOICE_MAX_PACKETS } from "./voice_codec.js";

export const VOICE_CHANNEL_NAME = "#meck-voice";
export const VOICE_REGION = "au-nsw-voice";
export const VOICE_DATA_TYPE = 0xFF56;
export const VOICE_CHANNEL_STORE_KEY = "channel:#meck-voice"; // messages store "publicKey" for these

const PKT_MAGIC = 0x56;
const MSG_HEADER = 0x48;   // 'H'
const MSG_DATA = 0x44;     // 'D'
const FLAG_REPORT = 0x80;
const DATA_HDR_SIZE = 9;   // V D sid(4) idx total len
const PACKET_GAP_MS = 3000;
const INCOMING_WAIT_MS = 15000;   // after the last packet should have arrived

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sha256(text) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return new Uint8Array(hash);
}

// Public hashtag channel secret: first 16 bytes of SHA-256 of the name with '#'.
export async function channelSecret() {
    return (await sha256(VOICE_CHANNEL_NAME)).slice(0, 16);
}

// Region (flood scope) key: first 16 bytes of SHA-256 of "#" + region name.
export async function regionKey() {
    return (await sha256(`#${VOICE_REGION}`)).slice(0, 16);
}

export function buildHeader(sessionId, total, durationSec, senderName) {
    const name = new TextEncoder().encode(senderName || "").slice(0, 31);
    const buf = new Uint8Array(8 + name.length);
    buf[0] = PKT_MAGIC;
    buf[1] = MSG_HEADER;
    new DataView(buf.buffer).setUint32(2, sessionId >>> 0, true);
    buf[6] = total;
    buf[7] = durationSec;
    buf.set(name, 8);
    return buf;
}

export function buildData(sessionId, index, total, data) {
    const buf = new Uint8Array(DATA_HDR_SIZE + data.length);
    buf[0] = PKT_MAGIC;
    buf[1] = MSG_DATA;
    new DataView(buf.buffer).setUint32(2, sessionId >>> 0, true);
    buf[6] = index;
    buf[7] = total;
    buf[8] = data.length;
    buf.set(data, DATA_HDR_SIZE);
    return buf;
}

export function isChannelName(name) {
    return (name || "").toLowerCase() === VOICE_CHANNEL_NAME;
}

export default class VoiceChannel {

    constructor(getDevice) {
        this.getDevice = getDevice;           // () => current connection or null
        this.channelIdx = null;               // index of #meck-voice on the radio, once known
        this.checkedIdx = new Map();          // channel index -> is it #meck-voice
        this.sessions = new Map();            // incoming, by session id
        this.onStarted = null;                // ({ sessionId, senderName, total })
        this.onProgress = null;               // ({ sessionId, received, total })
        this.onReady = null;                  // ({ sessionId, senderName, durationSec, total, packets, startedAt })
        this.onSenderName = null;             // ({ sessionId, senderName }) when a header names a message already started
    }

    resetRadio() {
        this.channelIdx = null;
        this.checkedIdx.clear();
    }

    // Finds #meck-voice on the radio. Returns its index, or -1.
    async findChannel() {
        const device = this.getDevice();
        if (!device) return -1;
        const channels = await device.getChannels();
        const found = channels.find(c => isChannelName(c.name));
        this.channelIdx = found ? found.channelIdx : -1;
        return this.channelIdx;
    }

    // Adds #meck-voice in the first empty slot. Returns its index, or -1 if there is no room.
    async addChannel() {
        const device = this.getDevice();
        if (!device) return -1;
        const channels = await device.getChannels();
        const existing = channels.find(c => isChannelName(c.name));
        if (existing) return (this.channelIdx = existing.channelIdx);
        const empty = channels.find(c => !c.name);
        if (!empty) return -1;
        await device.setChannel(empty.channelIdx, VOICE_CHANNEL_NAME, await channelSecret());
        this.checkedIdx.set(empty.channelIdx, true);
        return (this.channelIdx = empty.channelIdx);
    }

    // Is this channel data a voice message on #meck-voice?
    async isVoiceData(channelData) {
        if (!channelData || channelData.dataType !== VOICE_DATA_TYPE) return false;
        const idx = channelData.channelIdx;
        if (this.channelIdx != null && this.channelIdx >= 0) return idx === this.channelIdx;
        if (!this.checkedIdx.has(idx)) {
            const device = this.getDevice();
            if (!device) return false;
            try {
                const channel = await device.getChannel(idx);
                this.checkedIdx.set(idx, isChannelName(channel.name));
                if (isChannelName(channel.name)) this.channelIdx = idx;
            } catch (e) {
                return false;
            }
        }
        return this.checkedIdx.get(idx);
    }

    // ---- Sending ----

    // Sends Codec2 data to #meck-voice. onProgress({ sent, total }) after each
    // packet. Resolves with { sessionId, packets, total, sent, durationSec }.
    async send(c2, senderName, onProgress = null) {
        if (this.channelIdx == null) await this.findChannel();
        if (this.channelIdx < 0) throw new Error("No channel");

        const packets = splitPackets(c2);
        const total = packets.length;
        const durationSec = durationSeconds(c2.length);
        const id = new Uint32Array(1);
        crypto.getRandomValues(id);
        const sessionId = id[0];
        const scope = await regionKey();

        await this._sendScoped(scope, buildHeader(sessionId, total, durationSec, senderName));
        let sent = 0;
        for (let index = 0; index < total; index++) {
            await sleep(PACKET_GAP_MS);
            if (!this.getDevice()) break;
            try {
                await this._sendScoped(scope, buildData(sessionId, index, total, packets[index]));
                sent++;
            } catch (e) {
                console.warn(`Voice channel: packet ${index} not sent`, e);
            }
            if (onProgress) onProgress({ sent, total });
        }
        return { sessionId, packets, total, sent, durationSec };
    }

    // The scope is set just for this one send, then cleared, so nothing else
    // the app sends in the meantime goes out scoped to the voice region.
    async _sendScoped(scope, payload) {
        const device = this.getDevice();
        if (!device) throw new Error("Not connected");
        await device.setFloodScope(scope);
        try {
            await device.sendChannelData(this.channelIdx, 0xFF, new Uint8Array(0), VOICE_DATA_TYPE, payload);
        } finally {
            try { await device.setFloodScope(new Uint8Array(0)); } catch (e) {}
        }
    }

    // ---- Receiving ----

    onChannelData(data) {
        if (!data || data.length < 6 || data[0] !== PKT_MAGIC) return;
        const sessionId = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(2, true);
        if (data[1] === MSG_HEADER && data.length >= 8) {
            const name = new TextDecoder().decode(data.slice(8, 8 + 31));
            this._start(sessionId, data[6], data[7], name);
        } else if (data[1] === MSG_DATA && data.length >= DATA_HDR_SIZE + 1) {
            const index = data[6] & ~FLAG_REPORT;
            const total = data[7];
            const len = data[8];
            if (DATA_HDR_SIZE + len > data.length) return;   // malformed
            this._start(sessionId, total, 0, null);
            this._addPacket(sessionId, index, data.slice(DATA_HDR_SIZE, DATA_HDR_SIZE + len));
        }
    }

    _start(sessionId, total, durationSec, senderName) {
        let session = this.sessions.get(sessionId);
        if (session) {
            if (senderName && !session.senderName) {
                session.senderName = senderName;
                if (this.onSenderName) this.onSenderName({ sessionId, senderName });
            }
            if (durationSec && !session.durationSec) session.durationSec = durationSec;
            return;
        }
        if (total === 0 || total > VOICE_MAX_PACKETS) return;
        session = {
            sessionId,
            senderName: senderName || null,
            durationSec,
            total,
            packets: new Array(total).fill(null),
            received: 0,
            bytes: 0,
            startedAt: Date.now(),
            done: false,
        };
        this.sessions.set(sessionId, session);
        // give up waiting for the rest once the last packet is well overdue
        session.timer = setTimeout(() => this._finish(session), total * PACKET_GAP_MS + PACKET_GAP_MS + INCOMING_WAIT_MS);
        if (this.onStarted) this.onStarted({ sessionId, senderName: session.senderName, total });
        this._cleanup();
    }

    _addPacket(sessionId, index, chunk) {
        const session = this.sessions.get(sessionId);
        if (!session || session.done) return;
        if (index >= session.total || session.packets[index]) return;
        if (session.bytes + chunk.length > VOICE_MAX_BYTES) return;
        session.packets[index] = chunk;
        session.received++;
        session.bytes += chunk.length;
        if (this.onProgress) this.onProgress({ sessionId, received: session.received, total: session.total });
        if (session.received >= session.total) this._finish(session);
    }

    _finish(session) {
        if (session.done) return;
        session.done = true;
        clearTimeout(session.timer);
        if (session.received === 0) return;
        if (!session.durationSec) session.durationSec = durationSeconds(session.bytes);
        if (this.onReady) {
            this.onReady({
                sessionId: session.sessionId,
                senderName: session.senderName,
                durationSec: session.durationSec,
                total: session.total,
                packets: session.packets,
                startedAt: session.startedAt,
            });
        }
    }

    _cleanup() {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (session.done && now - session.startedAt > 15 * 60 * 1000) this.sessions.delete(id);
        }
    }
}

export { decodeNote };
