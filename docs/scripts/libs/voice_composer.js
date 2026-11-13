// =============================================================================
// voice_composer.js -- the record / review controls shared by the DM chat and
// the #voice page: tap the mic to record (12 s at most), tap again to
// stop, then Play, Send or Discard.
//
// Expects these elements on the page: micButton, voiceBar, voiceStatus,
// voicePlayButton, voiceSendButton, voiceDiscardButton, voiceLevel,
// voiceLevelFill.
// =============================================================================

import { VoiceRecorder, encodeRecording, decodeNote, splitPackets, playPcm16k, stopPlayback, getAudioContext, durationSeconds } from "./voice_codec.js";

export default class VoiceComposer {

    // onSend(c2) is called when Send is tapped; it does the sending and calls
    // this.status() as it goes. It should throw to keep the recording for a retry.
    constructor(onSend) {
        this.onSend = onSend;
        this.recorder = null;
        this.c2 = null;
        this.preview = null;
        this.busy = false;
        this.ticker = null;

        const el = (id) => document.getElementById(id);
        this.ui = {
            bar: el("voiceBar"),
            status: el("voiceStatus"),
            play: el("voicePlayButton"),
            send: el("voiceSendButton"),
            discard: el("voiceDiscardButton"),
            level: el("voiceLevel"),
            levelFill: el("voiceLevelFill"),
            mic: el("micButton"),
        };

        // Stop recording and playback when leaving the page
        this._onLeave = () => this.stop();
        window.addEventListener("hashchange", this._onLeave, { once: true });

        if (!navigator.mediaDevices?.getUserMedia) {
            this.ui.mic.setAttribute("disabled", "");
            this.ui.mic.title = "This browser has no microphone access";
            return;
        }

        this.ui.mic.addEventListener("click", () => this.toggleRecording());
        this.ui.play.addEventListener("click", () => this.playPreview());
        this.ui.send.addEventListener("click", () => this.send());
        this.ui.discard.addEventListener("click", () => this.discard());
    }

    show(status, { play = false, send = false, discard = false, level = false } = {}) {
        const ui = this.ui;
        ui.bar.classList.remove("hidden");
        ui.status.textContent = status;
        ui.play.classList.toggle("hidden", !play);
        ui.send.classList.toggle("hidden", !send);
        ui.discard.classList.toggle("hidden", !discard);
        ui.level.classList.toggle("hidden", !level);
        if (!level) ui.levelFill.style.width = "0";
    }

    // Updates the status line only
    status(text) {
        this.ui.status.textContent = text;
    }

    hide() {
        this.ui.bar.classList.add("hidden");
    }

    showReview(message = null) {
        this.show(message ?? `Voice message, ${durationSeconds(this.c2.length)} s`, { play: true, send: true, discard: true });
    }

    async toggleRecording() {
        if (this.busy) return;
        if (this.recorder?.recording) {
            await this.stopRecording();
            return;
        }

        stopPlayback();
        this.c2 = null;
        this.preview = null;
        getAudioContext(); // create or resume audio inside the tap (needed on iPhone)

        const recorder = new VoiceRecorder();
        recorder.onLevel = (peak) => {
            this.ui.levelFill.style.width = `${Math.min(100, peak * 100)}%`;
        };
        recorder.onAutoStop = () => this.stopRecording();
        try {
            await recorder.start();
        } catch (e) {
            console.warn("Voice: microphone not available", e);
            this.show(`Microphone not available (${e.name || e.message})`);
            return;
        }
        this.recorder = recorder;
        this.ui.mic.setAttribute("icon", "stop");
        this.show("Recording 0 s of 12", { level: true });
        this.ticker = setInterval(() => {
            this.status(`Recording ${Math.floor(recorder.elapsedSeconds())} s of 12`);
        }, 250);
    }

    async stopRecording() {
        if (!this.recorder?.recording) return;
        clearInterval(this.ticker);
        const { samples, sampleRate } = this.recorder.stop();
        this.recorder = null;
        this.ui.mic.setAttribute("icon", "mic");

        if (samples.length < sampleRate / 2) {
            this.show("Too short to keep", { discard: true });
            return;
        }

        this.busy = true;
        this.show("Encoding…");
        try {
            this.c2 = await encodeRecording(samples, sampleRate);
        } catch (e) {
            console.warn("Voice: encode failed", e);
            this.c2 = null;
        }
        this.busy = false;

        if (!this.c2 || this.c2.length === 0) {
            this.show("Encoding failed", { discard: true });
            return;
        }
        this.showReview();
    }

    async playPreview() {
        if (!this.c2) return;
        try {
            if (!this.preview) this.preview = await decodeNote(splitPackets(this.c2));
            await playPcm16k(this.preview);
        } catch (e) {
            console.warn("Voice: preview failed", e);
        }
    }

    discard() {
        stopPlayback();
        this.c2 = null;
        this.preview = null;
        this.hide();
    }

    async send() {
        if (!this.c2 || this.busy) return;
        stopPlayback();
        this.busy = true;
        // Show straight away that the tap registered, and take the buttons
        // away so they can't be tapped again while it starts
        this.show("Sending…");
        const c2 = this.c2;
        try {
            await this.onSend(c2);
            // sent (fully or partly): the recording is done with
            this.c2 = null;
            this.preview = null;
            setTimeout(() => {
                if (!this.busy && !this.c2 && !this.recorder) this.hide();
            }, 3000);
        } catch (e) {
            // kept for another try; onSend has shown why
            console.warn("Voice: send failed", e);
            if (this.c2) {
                this.ui.play.classList.remove("hidden");
                this.ui.send.classList.remove("hidden");
                this.ui.discard.classList.remove("hidden");
            }
        }
        this.busy = false;
    }

    stop() {
        if (this.recorder?.recording) {
            clearInterval(this.ticker);
            this.recorder.stop();
            this.recorder = null;
        }
        stopPlayback();
    }
}
