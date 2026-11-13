import { app } from "../index.js";
import { Helpers } from "../libs/helpers.js";
import { Router } from "../router.js";
import { VoiceRecorder, encodeRecording, decodeNote, playPcm16k, stopPlayback, getAudioContext, durationSeconds } from "../libs/voice_codec.js";
import { parseVE3 } from "../libs/voice_receiver.js";
import { directPathOf } from "../libs/voice_sender.js";

// Decoded notes, keyed by message record id, so a note is decoded once per visit
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

        await app.db.add("messages", {
            publicKey: contact.publicKey,
            message: {
                pathLen: 0,
                pubKeyPrefix: app.info.publicKey,
                senderTimestamp: Math.floor(Date.now() / 1000),
                text: message,
                txtType: 0
            },
            timestamp: Date.now()
        });

        await app.device.sendTextMessage(contact.publicKey, message);

        console.log(message);
        this.renderMessages(contact);
    }

    // =========================================================================
    // Voice notes: record (12 s at most), review (Play / Send / Discard), send
    // =========================================================================

    static setupVoice(contact) {
        this.voice = {
            contact,
            recorder: null,
            c2: null,
            preview: null,
            busy: false,
            ticker: null,
        };

        const el = (id) => document.getElementById(id);
        this.voiceUi = {
            bar: el("voiceBar"),
            status: el("voiceStatus"),
            play: el("voicePlayButton"),
            send: el("voiceSendButton"),
            discard: el("voiceDiscardButton"),
            level: el("voiceLevel"),
            levelFill: el("voiceLevelFill"),
            mic: el("micButton"),
        };

        if (!navigator.mediaDevices?.getUserMedia) {
            this.voiceUi.mic.setAttribute("disabled", "");
            this.voiceUi.mic.title = "This browser has no microphone access";
            return;
        }

        this.voiceUi.mic.addEventListener("click", () => this.toggleRecording());
        this.voiceUi.play.addEventListener("click", () => this.playPreview());
        this.voiceUi.send.addEventListener("click", () => this.sendVoice());
        this.voiceUi.discard.addEventListener("click", () => this.discardVoice());
    }

    static showVoiceBar(status, { play = false, send = false, discard = false, level = false } = {}) {
        const ui = this.voiceUi;
        ui.bar.classList.remove("hidden");
        ui.status.textContent = status;
        ui.play.classList.toggle("hidden", !play);
        ui.send.classList.toggle("hidden", !send);
        ui.discard.classList.toggle("hidden", !discard);
        ui.level.classList.toggle("hidden", !level);
        if (!level) ui.levelFill.style.width = "0";
    }

    static hideVoiceBar() {
        this.voiceUi.bar.classList.add("hidden");
    }

    static async toggleRecording() {
        const voice = this.voice;
        if (voice.busy) return;
        if (voice.recorder?.recording) {
            await this.stopRecording();
            return;
        }

        stopPlayback();
        voice.c2 = null;
        voice.preview = null;
        getAudioContext(); // create or resume audio inside the tap (needed on iPhone)

        const recorder = new VoiceRecorder();
        recorder.onLevel = (peak) => {
            this.voiceUi.levelFill.style.width = `${Math.min(100, peak * 100)}%`;
        };
        recorder.onAutoStop = () => this.stopRecording();
        try {
            await recorder.start();
        } catch (e) {
            console.warn("Voice: microphone not available", e);
            this.showVoiceBar(`Microphone not available (${e.name || e.message})`, { discard: false });
            return;
        }
        voice.recorder = recorder;
        this.voiceUi.mic.setAttribute("icon", "stop");
        this.showVoiceBar("Recording 0 s of 12", { level: true });
        voice.ticker = setInterval(() => {
            const s = Math.floor(recorder.elapsedSeconds());
            this.voiceUi.status.textContent = `Recording ${s} s of 12`;
        }, 250);
    }

    static async stopRecording() {
        const voice = this.voice;
        if (!voice.recorder?.recording) return;
        clearInterval(voice.ticker);
        const { samples, sampleRate } = voice.recorder.stop();
        voice.recorder = null;
        this.voiceUi.mic.setAttribute("icon", "mic");

        if (samples.length < sampleRate / 2) {
            this.showVoiceBar("Too short to keep", { discard: true });
            return;
        }

        voice.busy = true;
        this.showVoiceBar("Encoding…");
        try {
            voice.c2 = await encodeRecording(samples, sampleRate);
        } catch (e) {
            console.warn("Voice: encode failed", e);
            voice.c2 = null;
        }
        voice.busy = false;

        if (!voice.c2 || voice.c2.length === 0) {
            this.showVoiceBar("Encoding failed", { discard: true });
            return;
        }
        this.showVoiceBar(`Voice note, ${durationSeconds(voice.c2.length)} s`, { play: true, send: true, discard: true });
    }

    static async playPreview() {
        const voice = this.voice;
        if (!voice.c2) return;
        try {
            if (!voice.preview) {
                const { packets } = app.voiceTx.prepare(voice.c2);
                voice.preview = await decodeNote(packets);
            }
            await playPcm16k(voice.preview);
        } catch (e) {
            console.warn("Voice: preview failed", e);
        }
    }

    static discardVoice() {
        stopPlayback();
        this.voice.c2 = null;
        this.voice.preview = null;
        this.hideVoiceBar();
    }

    static async sendVoice() {
        const voice = this.voice;
        if (!voice.c2 || voice.busy) return;
        if (!app.isConnected) {
            this.showVoiceBar("Not connected to a radio", { play: true, send: true, discard: true });
            return;
        }

        // Use the latest copy of the contact, which carries its current path
        const contact = (app.contacts || []).find(c => Helpers.compareUint(c.publicKey, voice.contact.publicKey)) ?? voice.contact;
        if (!directPathOf(contact)) {
            this.showVoiceBar(`No direct path to ${contact.advName}`, { play: true, send: true, discard: true });
            return;
        }

        stopPlayback();
        voice.busy = true;
        const note = app.voiceTx.prepare(voice.c2);
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
        voice.c2 = null;
        voice.preview = null;
        this.renderMessages(contact);
        this.showVoiceBar(`Sending 0 of ${note.packets.length}…`);

        try {
            const result = await app.voiceTx.transmit(contact, note, ({ sent, total }) => {
                this.voiceUi.status.textContent = `Sending ${sent} of ${total}…`;
            });
            record.voice = { packets: note.packets, total: result.total, sent: result.sent };
            this.showVoiceBar(result.sent === result.total ? "Voice sent" : `Sent ${result.sent} of ${result.total} packets`);
        } catch (e) {
            console.warn("Voice: send failed", e);
            record.voice = { packets: note.packets, total: note.packets.length, sent: 0, failed: true };
            this.showVoiceBar("Send failed");
        }
        await app.db.put("messages", record);
        voice.busy = false;
        this.renderMessages(contact);
        setTimeout(() => {
            if (!this.voice?.busy && !this.voice?.c2 && !this.voice?.recorder) this.hideVoiceBar();
        }, 3000);
    }

    static cleanup() {
        if (this.voice?.recorder?.recording) {
            clearInterval(this.voice.ticker);
            this.voice.recorder.stop();
        }
        stopPlayback();
    }
}
