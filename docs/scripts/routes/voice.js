import { app } from "../index.js";
import { Helpers } from "../libs/helpers.js";
import { Router } from "../router.js";
import { decodeNote, playPcm16k } from "../libs/voice_codec.js";
import VoiceComposer from "../libs/voice_composer.js";
import { VOICE_CHANNEL_NAME, VOICE_CHANNEL_STORE_KEY } from "../libs/voice_channel.js";

// Decoded voice messages, keyed by record id, so each is decoded once per visit
const decoded = new Map();

// The #meck-voice page: voice messages heard on the channel, and a recorder
// that sends to it.
export default class Voice {

    static async init() {
        Router.setTitle(VOICE_CHANNEL_NAME);
        this.composer = new VoiceComposer((c2) => this.send(c2));

        this._onChange = () => this.render();
        app.addEventListener("voicechannel", this._onChange);
        window.addEventListener("hashchange", () => app.removeEventListener("voicechannel", this._onChange), { once: true });

        document.getElementById("addChannelButton").addEventListener("click", () => this.addChannel());

        await this.render();
        await this.checkChannel();
    }

    // Shows the "Add #meck-voice" button if the connected radio doesn't have the channel.
    static async checkChannel() {
        const button = document.getElementById("addChannelButton");
        if (!button) return;
        if (!app.isConnected) {
            button.classList.add("hidden");
            return;
        }
        try {
            // Already found when the radio connected: no need to read every slot again
            const known = app.voiceChannel.channelIdx;
            const idx = (known != null && known >= 0) ? known : await app.voiceChannel.findChannel();
            button.classList.toggle("hidden", idx >= 0);
            if (idx < 0) {
                this.showNotice(`${VOICE_CHANNEL_NAME} isn't on this radio`,
                    `Add it to send and hear voice messages on the channel. (${this.describeScan()})`);
            }
        } catch (e) {
            console.warn("Voice channel: could not read channels", e);
            this.showNotice("Couldn't read the radio's channels", `Check the radio is connected and try again. (${e?.message || "no reply"})`);
        }
    }

    static async addChannel() {
        const button = document.getElementById("addChannelButton");
        button.setAttribute("loading", "");
        try {
            const idx = await app.voiceChannel.addChannel();
            if (idx < 0) {
                this.showNotice("No free channel slot", `Remove a channel on the radio, then add ${VOICE_CHANNEL_NAME}.`);
            } else {
                button.classList.add("hidden");
                this.showNotice("No voice messages yet", `Voice messages sent to ${VOICE_CHANNEL_NAME} by anyone on the channel appear here.`);
            }
        } catch (e) {
            console.warn("Voice channel: could not add the channel", e);
            this.showNotice("Couldn't add the channel", "Check the radio is connected and try again.");
        }
        button.removeAttribute("loading");
    }

    // What the last channel read found, for the notice: "Read 20 slots: Public, #sydney. No answer from slot 4."
    static describeScan() {
        const scan = app.voiceChannel.lastScan;
        if (!scan) return "Channels not read";
        const named = scan.channels.filter(c => c.name).map(c => c.name);
        let text = `Read ${scan.channels.length} of ${scan.maxChannels} slots: ${named.length ? named.join(", ") : "all empty"}.`;
        if (scan.failed.length) text += ` No answer from slot ${scan.failed.join(", ")}.`;
        return text;
    }

    static showNotice(title, text) {
        const t = document.getElementById("voiceNoticeTitle");
        const x = document.getElementById("voiceNoticeText");
        if (t) t.textContent = title;
        if (x) x.textContent = text;
    }

    static async render() {
        const list = document.getElementById("voiceList");
        const template = document.getElementById("voiceItemTemplate");
        if (!list || !template) return; // left the page

        const records = await app.db.getByIndex("messages", "publicKey", VOICE_CHANNEL_STORE_KEY);
        const notice = document.getElementById("voiceNotice");
        if (!records || records.length === 0) {
            list.classList.add("hidden");
            notice.classList.remove("hidden");
            return;
        }
        list.classList.remove("hidden");
        notice.classList.add("hidden");

        const items = [];
        for (const record of records) {
            const voice = record.channelVoice;
            if (!voice) continue;
            const item = template.content.cloneNode(true);
            const name = voice.outgoing ? `You (${app.info?.name ?? "this radio"})` : (voice.senderName || "Unknown sender");
            const avatarName = voice.outgoing ? (app.info?.name ?? "?") : (voice.senderName || "?");

            item.getElementById("voiceAvatar").innerText = Helpers.getLastEmoji(avatarName) ?? avatarName[0];
            item.getElementById("voiceAvatar").style.backgroundColor = Helpers.stringToColour(avatarName);
            item.getElementById("voiceTitle").innerText = name;
            item.getElementById("voiceTimeStamp").value = new Date(record.timestamp);

            let note = "";
            if (voice.outgoing && voice.sending) note = ` (sending ${voice.sent ?? 0} of ${voice.total})`;
            else if (voice.outgoing && voice.sent < voice.total) note = ` (${voice.sent} of ${voice.total} packets sent)`;
            else if (!voice.outgoing && voice.received < voice.total) note = ` (${voice.received} of ${voice.total} packets)`;
            const label = `🎙️ Voice message (${voice.durationSec}s)${note}`;

            const content = item.getElementById("voiceContent");
            content.textContent = `${label} ▶`;
            if (voice.unread) {
                const dot = document.createElement("span");
                dot.className = "voice-new";
                dot.textContent = " • new";
                content.appendChild(dot);
            }
            content.addEventListener("click", () => this.play(record, content, label));
            items.push(item);
        }
        list.replaceChildren(...items);
    }

    static async play(record, content, label) {
        try {
            let samples = decoded.get(record.id);
            if (!samples) {
                content.textContent = `${label} …`;
                samples = await decodeNote(record.channelVoice.packets);
                decoded.set(record.id, samples);
            }
            if (record.channelVoice.unread) {
                record.channelVoice.unread = false;
                await app.db.put("messages", record);
            }
            content.textContent = `${label} 🔊`;
            await playPcm16k(samples);
            content.textContent = `${label} ▶`;
        } catch (e) {
            console.warn("Voice channel: playback failed", e);
            content.textContent = `${label} — could not play`;
        }
    }

    // Called by the composer's Send. Throws (keeping the recording) if it can't start.
    static async send(c2) {
        const composer = this.composer;
        if (!app.isConnected) {
            composer.show("Not connected to a radio");
            throw new Error("Not connected");
        }
        // Use the slot found when the radio connected; only read the channels
        // again (slow: every slot, one at a time) if that isn't known
        let idx = app.voiceChannel.channelIdx;
        if (idx == null || idx < 0) {
            composer.show("Checking the radio's channels…");
            idx = await app.voiceChannel.findChannel();
        }
        if (idx < 0) {
            composer.show(`Add ${VOICE_CHANNEL_NAME} to this radio first. ${this.describeScan()}`);
            document.getElementById("addChannelButton")?.classList.remove("hidden");
            throw new Error("No channel");
        }

        const record = {
            publicKey: VOICE_CHANNEL_STORE_KEY,
            channelVoice: { senderName: app.info?.name, durationSec: 0, total: 0, sent: 0, packets: [], outgoing: true, sending: true },
            timestamp: Date.now()
        };
        composer.show("Sending…");
        let result = null;
        try {
            result = await app.voiceChannel.send(c2, app.info?.name, ({ sent, total }) => {
                composer.status(`Sending ${sent} of ${total}…`);
                record.channelVoice.sent = sent;
                record.channelVoice.total = total;
            });
        } catch (e) {
            console.warn("Voice channel: send failed", e);
            composer.show("Send failed");
            throw e;
        }

        record.channelVoice = {
            sessionId: result.sessionId,
            senderName: app.info?.name,
            durationSec: result.durationSec,
            total: result.total,
            sent: result.sent,
            packets: result.packets,
            outgoing: true,
        };
        await app.db.add("messages", record);
        composer.show(result.sent === result.total ? `Voice message sent to ${VOICE_CHANNEL_NAME}` : `Sent ${result.sent} of ${result.total} packets`);
        this.render();
    }

    static cleanup() {
        this.composer?.stop();
    }
}
