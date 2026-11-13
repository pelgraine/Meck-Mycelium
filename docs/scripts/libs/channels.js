// =============================================================================
// channels.js -- channel helpers for the Chats tab and channel chats.
//
// Channel messages are saved in the "messages" store under a key made from
// the channel's secret ("chan:<hex>"), so they stay with the channel even if
// it moves to another slot on the radio.
//
// Incoming channel text arrives from the firmware as "<sender>: <text>"
// (BaseChatMesh::sendGroupMessage). The sender is split off the same way as
// MeshCore Open's _splitSenderText (github.com/zjs81/meshcore-open, MIT).
// =============================================================================

export const PUBLIC_CHANNEL_SECRET_HEX = "8b3387e9c5cdea6ac9e5edbaa115cd72";
export const MAX_TEXT_LEN = 160;   // firmware MAX_TEXT_LEN: "<sender>: " plus the message

export function toHex(bytes) {
    return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex) {
    const clean = (hex || "").replace(/[^0-9a-f]/gi, "");
    if (clean.length % 2 !== 0) return null;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    return bytes;
}

export function channelKey(secret) {
    return `chan:${toHex(secret)}`;
}

// Public hashtag channel key: first 16 bytes of SHA-256 of "#name".
export async function hashtagSecret(name) {
    const full = name.startsWith("#") ? name : `#${name}`;
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(full));
    return new Uint8Array(hash).slice(0, 16);
}

export function randomSecret() {
    const secret = new Uint8Array(16);
    crypto.getRandomValues(secret);
    return secret;
}

// "Name: text" -> { senderName, text }. A colon after the 50th character, or a
// "name" containing ':', '[' or ']', means there's no sender prefix.
export function splitSender(text) {
    const colon = (text || "").indexOf(":");
    if (colon > 0 && colon < text.length - 1 && colon < 50) {
        const sender = text.substring(0, colon);
        if (/[:\[\]]/.test(sender)) return { senderName: null, text };
        const offset = text[colon + 1] === " " ? colon + 2 : colon + 1;
        return { senderName: sender, text: text.substring(offset) };
    }
    return { senderName: null, text: text || "" };
}

// Most bytes a message can have on a channel, given the sender name the
// firmware puts in front of it ("<name>: ").
export function maxChannelTextBytes(myName) {
    const nameBytes = new TextEncoder().encode(myName || "").length;
    return Math.max(0, MAX_TEXT_LEN - nameBytes - 2);
}

export function utf8Length(text) {
    return new TextEncoder().encode(text).length;
}

export function isEmptyChannel(channel) {
    return !channel || !channel.name;
}

export function channelKind(channel) {
    if (!channel) return "";
    if (toHex(channel.secret || []) === PUBLIC_CHANNEL_SECRET_HEX) return "Public channel";
    if ((channel.name || "").startsWith("#")) return "Hashtag channel";
    return "Private channel";
}
