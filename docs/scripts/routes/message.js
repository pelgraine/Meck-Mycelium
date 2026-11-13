import { app } from "../index.js";
import { Helpers } from "../libs/helpers.js";
import { Router } from "../router.js";
import { decodeNote, playPcm16k } from "../libs/voice_codec.js";
import VoiceComposer from "../libs/voice_composer.js";
import { parseVE3 } from "../libs/voice_receiver.js";
import { directPathOf } from "../libs/voice_sender.js";
import { directStatusText, heardDetails } from "../libs/delivery.js";
import { showDetails } from "../libs/details_dialog.js";

// Decoded voice messages, keyed by message record id, so each is decoded once per visit
const decodedNotes = new Map();

export default class Contacts {
    static async init(parameters) {
        console.log(parameters);

        const publicKey = Uint8Array.fromHex(parameters.id);
        const contact = await app.device.findContactByPublicKeyPrefix(publicKey);

        document.getElementById("sendButton").addEventListener("click", () => this.handleSend(contact));
        app.addEventListener("message", () => this.renderMessages(contact));

        this.setupVoice(contact);

        Router.setTitle(contact.advName);
        this.renderMessages(contact);
    }

    static async renderMessages(targeCtontact) {
        const messages = await app.db.getByIndex("messages", "publicKey", targeCtontact.publicKey);
        console.log(messages);

        if (!messages || messages?.length === 0) return;

        const messageTemplate = document.getElementById("messageTemplate");
        const messageList = document.getElementById("messageList");
        if (!messageTemplate || !messageList) return; // left this chat

        messageList.classList.remove("hidden");
        document.getElementById("emptyMessage").classList.add("hidden");

        const newItems = [];
        for (const message of messages) {
            const messageItem = messageTemplate.content.cloneNode(true);

            const isSelf = Helpers.compareUint(message.message.pubKeyPrefix, app.info.publicKey);
            const contact = isSelf ? app.info : targeCtontact;
            const name = contact.name ?? contact.advName;

            messageItem.getElementById("contactAvatar").innerText = Helpers.getLastEmoji(name) ?? name[0];
            messageItem.getElementById("contactAvatar").style.backgroundColor = (contact.type === 2) ? "rgb(var(--mdui-color-on-secondary-dark))" : Helpers.stringToColour(name);
            messageItem.getElementById("contactName").innerText = isSelf ? `You (${name})` : name;
            messageItem.getElementById("messageTimeStamp").value = new Date(message.timestamp);

            // Check if this is a VE3 voice message
            const envelope = parseVE3(message.message.text);
            if (envelope) {
                const msgSpan = messageItem.getElementById("messageContent");
                this.renderVoiceMessage(msgSpan, message, envelope, isSelf);
            } else {
                messageItem.getElementById("messageContent").innerText = message.message.text;
            }

            if (isSelf && message.delivery) {
                const status = messageItem.getElementById("messageStatus");
                status.textContent = directStatusText(message.delivery);
                if (!["sending", "failed"].includes(message.delivery.status)) {
                    status.classList.add("tappable");
                    status.addEventListener("click", () => showDetails("Delivery", this.deliveryDetails(message.delivery)));
                }
            }

            newItems.push(messageItem);
        }

        messageList.replaceChildren(...newItems);
    }

    static renderVoiceMessage(msgSpan, message, envelope, isSelf) {
        const durSec = envelope.durationSec;
        const voice = message.voice;
        let note = "";
        if (isSelf && voice?.sending) {
            note = ` (sending ${voice.sent ?? 0} of ${voice.total})`;
        } else if (isSelf && voice?.failed) {
            note = " (not sent)";
        } else if (isSelf && voice && voice.sent != null && voice.sent < voice.total) {
            note = ` (${voice.sent} of ${voice.total} packets sent)`;
        } else if (!isSelf && voice && voice.received < envelope.totalPackets) {
            note = ` (${voice.received} of ${envelope.totalPackets} packets)`;
        }
        const label = `🎙️ Voice message (${durSec}s)${note}`;
        msgSpan.textContent = `${label} ▶`;
        msgSpan.classList.add("voice-message");

        msgSpan.addEventListener('click', async () => {
            try {
                let samples = decodedNotes.get(message.id);
                if (!samples && voice?.packets) {
                    msgSpan.textContent = `${label} …`;
                    samples = await decodeNote(voice.packets);
                    decodedNotes.set(message.id, samples);
                }
                if (!samples) {
                    samples = app.voiceRx.decodedAudio?.get(envelope.sessionId);
                }
                if (!samples) {
                    msgSpan.textContent = `${label} — tap after receiving`;
                    return;
                }
                msgSpan.textContent = `${label} 🔊`;
                await playPcm16k(samples);
                msgSpan.textContent = `${label} ▶`;
            } catch (e) {
                console.warn("Voice: playback failed", e);
                msgSpan.textContent = `${label} — could not play`;
            }
        });
    }

    static async handleSend(contact) {
        const messageTextFeild = document.getElementById("messageTextFeild");
        const message = messageTextFeild.value;

        messageTextFeild.value = "";

        const record = {
            publicKey: contact.publicKey,
            message: {
                pathLen: 0,
                pubKeyPrefix: app.info.publicKey,
                senderTimestamp: Math.floor(Date.now() / 1000),
                text: message,
                txtType: 0
            },
            timestamp: Date.now(),
            delivery: { status: "sending" }
        };
        record.id = await app.db.add("messages", record);
        this.renderMessages(contact);

        let sent;
        try {
            sent = await app.device.sendTextMessage(contact.publicKey, message);
        } catch (e) {
            console.warn("Message: send failed", e);
            record.delivery = { status: "failed" };
            await app.db.put("messages", record);
            this.renderMessages(contact);
            return;
        }

        console.log(message);
        // Waits for the recipient's confirmation, and counts repeaters passing it on
        app.delivery.trackDirectSend({ recordId: record.id, contactKey: contact.publicKey, selfKey: app.info.publicKey, sent });
    }

    static deliveryDetails(delivery) {
        const lines = [];
        if (delivery.status === "delivered") {
            lines.push("Delivered: the recipient's radio confirmed it" +
                (delivery.roundTrip != null ? `, ${(delivery.roundTrip / 1000).toFixed(1)} s after sending.` : "."));
        } else if (delivery.status === "unconfirmed") {
            lines.push("Not confirmed: no confirmation came back from the recipient's radio in the expected time. It may still have arrived.");
        } else {
            lines.push("Sent. Waiting for the recipient's radio to confirm it.");
        }
        lines.push("");
        if (delivery.isFlood) lines.push(heardDetails(delivery.heard, app.contacts));
        else lines.push("Sent along a known path, so repeats aren't counted.");
        return lines.join("\n");
    }

    // =========================================================================
    // Voice messages: record (12 s at most), review (Play / Send / Discard), send
    // =========================================================================

    static setupVoice(contact) {
        this.voiceContact = contact;
        this.composer = new VoiceComposer((c2) => this.sendVoice(c2));
    }

    // Called by the composer's Send. Throws (keeping the recording) if it can't start.
    static async sendVoice(c2) {
        const composer = this.composer;
        if (!app.isConnected) {
            composer.show("Not connected to a radio");
            throw new Error("Not connected");
        }

        // Use the latest copy of the contact, which carries its current path
        const contact = (app.contacts || []).find(c => Helpers.compareUint(c.publicKey, this.voiceContact.publicKey)) ?? this.voiceContact;
        if (!directPathOf(contact)) {
            composer.show(`No direct path to ${contact.advName}`);
            throw new Error("No direct path");
        }

        const note = app.voiceTx.prepare(c2);
        const record = {
            publicKey: contact.publicKey,
            message: {
                pathLen: 0,
                pubKeyPrefix: app.info.publicKey,
                senderTimestamp: Math.floor(Date.now() / 1000),
                text: note.envelope,
                txtType: 0
            },
            voice: { packets: note.packets, total: note.packets.length, sent: 0, sending: true },
            timestamp: Date.now()
        };
        record.id = await app.db.add("messages", record);
        this.renderMessages(contact);
        composer.show(`Sending 0 of ${note.packets.length}…`);

        try {
            const result = await app.voiceTx.transmit(contact, note, ({ sent, total }) => {
                composer.status(`Sending ${sent} of ${total}…`);
            });
            record.voice = { packets: note.packets, total: result.total, sent: result.sent };
            composer.show(result.sent === result.total ? "Voice message sent" : `Sent ${result.sent} of ${result.total} packets`);
        } catch (e) {
            console.warn("Voice: send failed", e);
            record.voice = { packets: note.packets, total: note.packets.length, sent: 0, failed: true };
            composer.show("Send failed");
        }
        await app.db.put("messages", record);
        this.renderMessages(contact);
    }

    static cleanup() {
        this.composer?.stop();
    }
}
