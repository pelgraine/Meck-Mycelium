// =============================================================================
// voice_sender.js -- sends voice messages as direct messages in the VE3 format
// used by Meck (VoiceMessageScreen.h), Meck-P4 and Meck Watch:
//
//   1. a text DM "VE3:{sid}:{mode}:{total}:{dur}" (base36 fields, mode 1 =
//      Codec2 1200)
//   2. raw data packets [0x56][sid:4 LE][index][up to 150 Codec2 bytes] along
//      the contact's direct path, the first 3 s after the DM, then every 3 s
//      (Meck's 3000 + p x 3000 ms)
//
// Sent notes are kept 15 minutes. A fetch request for one of them
// ([0x72][sid:4][flags][requester key:6][count][indices...]) is answered as
// Meck and Meck Watch do: every packet of the note is sent again, 100 ms
// apart, along the requester's path.
//
// Needs the radio firmware's raw data command (25), which sends direct only.
// =============================================================================

import { splitPackets, durationSeconds } from "./voice_codec.js";

export const VOICE_PKT_MAGIC = 0x56;
export const VOICE_FETCH_MAGIC = 0x72;
const VOICE_MODE_ID = 1;                 // Codec2 1200
const FIRST_PACKET_DELAY_MS = 3000;
const PACKET_GAP_MS = 3000;
const FETCH_PACKET_GAP_MS = 100;
const SESSION_TTL_MS = 15 * 60 * 1000;

function toBase36(value) {
    return (value >>> 0).toString(36);
}

// Encoded path length (hash size in bits 6-7, hop count in bits 0-5) -> bytes.
export function pathByteLength(pathLen) {
    return (pathLen & 63) * ((pathLen >> 6) + 1);
}

// A contact's direct path, or null if it has none (path length 0xFF).
export function directPathOf(contact) {
    const pathLen = contact.outPathLen & 0xFF;
    if (pathLen === 0xFF) return null;
    return { pathLen, path: contact.outPath.slice(0, pathByteLength(pathLen)) };
}

export function buildVoicePacket(sessionId, index, data) {
    const packet = new Uint8Array(6 + data.length);
    packet[0] = VOICE_PKT_MAGIC;
    new DataView(packet.buffer).setUint32(1, sessionId >>> 0, true);
    packet[5] = index;
    packet.set(data, 6);
    return packet;
}

export function buildEnvelope(sessionId, totalPackets, durationSec) {
    return `VE3:${toBase36(sessionId)}:${toBase36(VOICE_MODE_ID)}:${toBase36(totalPackets)}:${toBase36(durationSec)}`;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default class VoiceSender {

    constructor(getDevice, getContacts) {
        this.getDevice = getDevice;       // () => current connection or null
        this.getContacts = getContacts;   // () => current contact list
        this.sessions = new Map();        // sessionId -> { packets, sentAt }
    }

    newSessionId() {
        const id = new Uint32Array(1);
        crypto.getRandomValues(id);
        return id[0];
    }

    // Splits a note into packets and gives it a session. Returns
    // { sessionId, envelope, packets, durationSec }.
    prepare(c2) {
        const packets = splitPackets(c2);
        const sessionId = this.newSessionId();
        const durationSec = durationSeconds(c2.length);
        const envelope = buildEnvelope(sessionId, packets.length, durationSec);
        return { sessionId, envelope, packets, durationSec };
    }

    // Sends a prepared note to a contact: the VE3 DM, then the packets.
    // onProgress({ sent, total }) after each packet. Resolves with { sent, total }.
    async transmit(contact, note, onProgress = null) {
        const device = this.getDevice();
        if (!device) throw new Error("Not connected");
        const route = directPathOf(contact);
        if (!route) throw new Error("No direct path");

        const { sessionId, envelope, packets } = note;
        this.cleanup();
        this.sessions.set(sessionId, { packets, sentAt: Date.now() });

        await device.sendTextMessage(contact.publicKey, envelope);

        let sent = 0;
        for (let index = 0; index < packets.length; index++) {
            await sleep(index === 0 ? FIRST_PACKET_DELAY_MS : PACKET_GAP_MS);
            const now = this.getDevice();
            if (!now) break;
            try {
                await now.sendRawData(route.pathLen, route.path, buildVoicePacket(sessionId, index, packets[index]));
                sent++;
            } catch (e) {
                console.warn(`Voice: packet ${index} not sent`, e);
            }
            if (onProgress) onProgress({ sent, total: packets.length });
        }
        return { sent, total: packets.length };
    }

    // Handles a raw data payload. Returns true if it was a fetch request.
    async onRawData(payload) {
        if (!payload || payload.length < 6 || payload[0] !== VOICE_FETCH_MAGIC) return false;
        const sessionId = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(1, true);
        this.cleanup();
        const session = this.sessions.get(sessionId);
        if (!session) {
            console.log(`Voice: no cached session ${sessionId.toString(16)} for fetch`);
            return true;
        }
        if (payload.length < 12) return true;
        const requesterPrefix = payload.slice(6, 12);
        const requester = (this.getContacts() || []).find(c =>
            requesterPrefix.every((b, i) => b === c.publicKey[i]));
        const route = requester ? directPathOf(requester) : null;
        if (!route) {
            console.log("Voice: fetch requester not found or no direct path");
            return true;
        }
        for (let index = 0; index < session.packets.length; index++) {
            if (index > 0) await sleep(FETCH_PACKET_GAP_MS);
            const device = this.getDevice();
            if (!device) break;
            try {
                await device.sendRawData(route.pathLen, route.path, buildVoicePacket(sessionId, index, session.packets[index]));
            } catch (e) {
                console.warn(`Voice: fetch packet ${index} not sent`, e);
            }
        }
        console.log(`Voice: served ${session.packets.length} packets to ${requester.advName}`);
        return true;
    }

    cleanup() {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (now - session.sentAt > SESSION_TTL_MS) this.sessions.delete(id);
        }
    }
}
