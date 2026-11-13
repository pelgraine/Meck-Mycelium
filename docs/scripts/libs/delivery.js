// =============================================================================
// delivery.js -- what happened to the messages this app sent:
//
//   Channel messages: "Heard by N repeaters". The radio passes the app every
//   packet it hears (PUSH_CODE_LOG_RX_DATA, 0x88), before duplicates are
//   dropped. When a repeater passes our message on, the radio hears that copy.
//   A copy is recognised by unlocking it with the channel key and finding our
//   own timestamp and text. Later copies are recognised by their bytes.
//
//   Direct messages: "Delivered" when the recipient's confirmation arrives
//   (PUSH_CODE_SEND_CONFIRMED, 0x82, carrying the code the radio gave back
//   in RESP_CODE_SENT), "Not confirmed" if none arrives in the radio's
//   estimated time. Sent by flood, copies passed on by repeaters are counted
//   too. A direct message can't be unlocked by the app, so a copy is
//   recognised by its two one-byte hashes (to the contact, from this radio)
//   and, after the first one, by its bytes.
//
// The repeater that heard us directly is the first hash in a copy's path.
// Packet layout, cipher and MAC as upstream MeshCore (Packet.cpp,
// Mesh::createGroupDatagram, Utils::encryptThenMAC): AES-128 ECB with the
// 16-byte channel key, zero padded; a 2-byte HMAC-SHA256 over the
// ciphertext, keyed with the channel key followed by 16 zero bytes.
// =============================================================================

import Packet from "./meshcore/packet.js";

const TRACK_MS = 5 * 60 * 1000;        // copies are counted for 5 minutes after sending
const CONFIRM_MARGIN_MS = 5000;        // added to the radio's estimated time before "Not confirmed"

const toHex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

// ---- Crypto (Web Crypto has no AES-ECB; it is built from AES-CBC) ----

async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function channelHash(secret) {
    return (await sha256(secret))[0];
}

async function mac2(secret, data) {
    const keyBytes = new Uint8Array(32);
    keyBytes.set(secret.slice(0, 16));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, data)).slice(0, 2);
}

// AES-128 ECB decryption of whole 16-byte blocks. CBC decryption with a zero
// IV gives D(C[i]) xor C[i-1]; a final block is added so the padding check
// passes (it decrypts to sixteen 0x10 bytes, which are then dropped).
export async function aesEcbDecrypt(key16, data) {
    if (data.length === 0 || data.length % 16 !== 0) return null;
    const key = await crypto.subtle.importKey("raw", key16.slice(0, 16), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
    const zeroIv = new Uint8Array(16);
    const last = data.slice(data.length - 16);
    const padBlock = new Uint8Array(16).fill(16);
    for (let i = 0; i < 16; i++) padBlock[i] ^= last[i];
    const extra = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: zeroIv }, key, padBlock)).slice(0, 16);
    const input = new Uint8Array(data.length + 16);
    input.set(data);
    input.set(extra, data.length);
    const out = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: zeroIv }, key, input));
    for (let i = 16; i < out.length; i++) out[i] ^= data[i - 16];
    return out;
}

// Group payload [channel hash][MAC 2][ciphertext] -> plaintext, or null if the MAC doesn't match.
export async function decryptGroupPayload(secret, payload) {
    if (payload.length < 3 + 16) return null;
    const cipher = payload.slice(3);
    if (cipher.length % 16 !== 0) return null;
    const mac = await mac2(secret, cipher);
    if (mac[0] !== payload[1] || mac[1] !== payload[2]) return null;
    return aesEcbDecrypt(secret, cipher);
}

// Group text plaintext: [timestamp 4 LE][type][text, zero padded]
export function parseGroupText(plain) {
    if (!plain || plain.length < 5) return null;
    const timestamp = new DataView(plain.buffer, plain.byteOffset).getUint32(0, true);
    let end = plain.indexOf(0, 5);
    if (end < 0) end = plain.length;
    return { timestamp, txtType: plain[4], text: new TextDecoder().decode(plain.slice(5, end)) };
}

// ---- Repeater names ----

// Name(s) of the repeaters whose public key starts with this path hash, or the hash itself.
export function repeaterName(idHex, contacts) {
    const matches = (contacts || []).filter(c =>
        (c.type === 2 || c.type === 3) && c.publicKey && toHex(c.publicKey.slice(0, idHex.length / 2)) === idHex);
    if (matches.length === 0) return idHex.toUpperCase();
    return matches.map(c => c.advName).join(" or ") + ` (${idHex.toUpperCase()})`;
}

// ---- Wording ----

function heardCount(heard) {
    return heard?.repeaters?.length ?? 0;
}

function heardText(heard) {
    const n = heardCount(heard);
    return `Heard by ${n} repeater${n === 1 ? "" : "s"}`;
}

export function channelStatusText(message) {
    if (message.status === "sending") return "Sending…";
    if (message.status === "failed") return "Not sent";
    if (heardCount(message.heard) > 0) return heardText(message.heard);
    if (message.status === "sent") return "Sent, no repeats heard yet";
    return "";
}

export function directStatusText(delivery) {
    if (!delivery) return "";
    let text = {
        sending: "Sending…",
        failed: "Not sent",
        waiting: "Sent, waiting for confirmation",
        delivered: "Delivered",
        unconfirmed: "Not confirmed",
    }[delivery.status] ?? "";
    if (delivery.status === "delivered" && delivery.roundTrip != null) text += ` (${(delivery.roundTrip / 1000).toFixed(1)} s)`;
    if (heardCount(delivery.heard) > 0) text += ` · ${heardText(delivery.heard).toLowerCase()}`;
    return text;
}

// Lines for the details pop-up.
export function heardDetails(heard, contacts) {
    if (heardCount(heard) === 0) return "No repeater has been heard passing this message on.";
    const lines = [`Repeaters that heard you directly (${heardCount(heard)}):`];
    for (const r of heard.repeaters) {
        lines.push(`• ${repeaterName(r.id, contacts)}: heard ${r.copies} time${r.copies === 1 ? "" : "s"}, best SNR ${r.bestSnr.toFixed(1)} dB`);
    }
    lines.push("", `Copies heard in all: ${heard.copies}. Furthest copy heard: ${heard.maxHops} hop${heard.maxHops === 1 ? "" : "s"}.`);
    return lines.join("\n");
}

// ---- Tracker ----

export default class DeliveryTracker {

    constructor(app) {
        this.app = app;
        this.entries = [];
        this.saving = Promise.resolve();
    }

    // A channel text message the radio accepted. text is what was typed;
    // the packet carries "<node name>: <text>" and the same timestamp.
    async trackChannelSend({ recordId, storeKey, secret, timestamp, text }) {
        this.entries.push({
            kind: "channel", recordId, storeKey, secret, timestamp, text,
            hash: await channelHash(secret),
            payloadHex: null,
            heard: { copies: 0, maxHops: 0, repeaters: [] },
            until: Date.now() + TRACK_MS,
        });
    }

    // A direct message the radio accepted (its RESP_CODE_SENT reply).
    trackDirectSend({ recordId, contactKey, selfKey, sent }) {
        const entry = {
            kind: "direct", recordId,
            destHash: contactKey[0], srcHash: selfKey[0],
            isFlood: sent.result === 1,
            ackCrc: sent.expectedAckCrc >>> 0,
            status: "waiting", roundTrip: null,
            payloadHex: null,
            heard: { copies: 0, maxHops: 0, repeaters: [] },
            until: Date.now() + TRACK_MS,
        };
        this.entries.push(entry);
        entry.timer = setTimeout(() => {
            if (entry.status === "waiting") {
                entry.status = "unconfirmed";
                this.save(entry);
            }
        }, (sent.estTimeout || 0) + CONFIRM_MARGIN_MS);
        this.save(entry);
    }

    // PUSH_CODE_SEND_CONFIRMED { ackCode, roundTrip }
    onAck({ ackCode, roundTrip }) {
        const entry = this.entries.find(e => e.kind === "direct" && e.ackCrc === (ackCode >>> 0));
        if (!entry || entry.status === "delivered") return;
        entry.status = "delivered";
        entry.roundTrip = roundTrip;
        clearTimeout(entry.timer);
        this.save(entry);
    }

    // PUSH_CODE_LOG_RX_DATA { lastSnr, lastRssi, raw }
    async onRxLog({ lastSnr, raw }) {
        const now = Date.now();
        this.entries = this.entries.filter(e => e.until > now);
        if (this.entries.length === 0 || !raw || raw.length < 3) return;

        let packet;
        try { packet = Packet.fromBytes(raw); } catch (e) { return; }
        const route = packet.getRouteType();
        if (route !== Packet.ROUTE_TYPE_FLOOD && route !== Packet.ROUTE_TYPE_TRANSPORT_FLOOD) return;
        const type = packet.getPayloadType();
        const payload = packet.payload;
        const payloadHex = toHex(payload);

        for (const entry of this.entries) {
            let match = false;
            if (entry.payloadHex) {
                match = entry.payloadHex === payloadHex;
            } else if (entry.kind === "channel" && type === Packet.PAYLOAD_TYPE_GRP_TXT && payload[0] === entry.hash) {
                const msg = parseGroupText(await decryptGroupPayload(entry.secret, payload));
                match = !!msg && msg.timestamp === entry.timestamp && msg.text.endsWith(`: ${entry.text}`);
            } else if (entry.kind === "direct" && entry.isFlood && type === Packet.PAYLOAD_TYPE_TXT_MSG) {
                match = payload[0] === entry.destHash && payload[1] === entry.srcHash;
            }
            if (!match) continue;
            entry.payloadHex = payloadHex;
            this.addCopy(entry, packet, lastSnr);
            this.save(entry);
            return;
        }
    }

    addCopy(entry, packet, snr) {
        const hashes = packet.getPathHashes();
        if (hashes.length === 0) return;   // not passed on by anyone
        const id = toHex(hashes[0]);
        const heard = entry.heard;
        heard.copies++;
        heard.maxHops = Math.max(heard.maxHops, hashes.length);
        let r = heard.repeaters.find(x => x.id === id);
        if (!r) heard.repeaters.push(r = { id, copies: 0, bestSnr: snr });
        r.copies++;
        r.bestSnr = Math.max(r.bestSnr, snr);
    }

    // Writes the entry's state into its message record, one write at a time.
    save(entry) {
        this.saving = this.saving.then(async () => {
            try {
                const record = await this.app.db.get("messages", entry.recordId);
                if (!record) return;
                const heard = structuredClone(entry.heard);
                if (entry.kind === "channel") {
                    record.channelMessage.heard = heard;
                    await this.app.db.put("messages", record);
                    this.app.dispatchEvent(new CustomEvent("channelmessage", { detail: { key: entry.storeKey } }));
                } else {
                    record.delivery = { status: entry.status, roundTrip: entry.roundTrip, isFlood: entry.isFlood, heard };
                    await this.app.db.put("messages", record);
                    this.app.dispatchEvent(new CustomEvent("message"));
                }
            } catch (e) {
                console.warn("Delivery: could not save", e);
            }
        });
        return this.saving;
    }
}
