// =============================================================================
// voice_codec.js -- recording, filtering and Codec2 1200 for Meck voice messages
//
// Matches Meck Watch's voice messages (WatchVoiceScreen.h, "version B" of the
// Nov 2026 audio test): DC removal, normalise so 99.9% of samples sit below
// 90% of full scale, 150 Hz high-pass (2nd-order Butterworth, RBJ biquad),
// then a 31-tap Hamming windowed-sinc 3.6 kHz low-pass to go 16 kHz -> 8 kHz
// before Codec2. Playback runs the same low-pass to go 8 kHz -> 16 kHz.
//
// The browser records at its own rate (48 kHz on iPhone in Bluefy), so the
// audio is first brought down to the watch's 16 kHz through a 7 kHz low-pass.
//
// Codec2 runs in WebAssembly (libs/codec2, see NOTICE.md).
// =============================================================================

export const VOICE_RATE = 16000;            // the watch's working rate
export const C2_RATE = 8000;                // Codec2's rate
export const C2_FRAME_SAMPLES = 320;        // 40 ms at 8 kHz
export const C2_FRAME_BYTES = 6;            // 48 bits at 1200 bps
export const C2_FRAME_MS = 40;
export const VOICE_MAX_SECONDS = 12;
export const VOICE_MAX_BYTES = 1800;        // 12 s x 25 frames x 6 bytes
export const VOICE_PACKET_BYTES = 150;      // Codec2 bytes per voice packet
export const VOICE_MAX_PACKETS = 16;

const HPF_HZ = 150;
const LPF_HZ = 3600;
const FIR_TAPS = 31;
const LEVEL_PERMILLE = 999;
const PRE_LPF_HZ = 7000;                    // before bringing the mic rate to 16 kHz

const CODEC2_BASE = "./scripts/libs/codec2/";

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

// Hamming windowed-sinc low-pass, normalised to unity gain (as firDesign()).
function designLowPass(cutoffHz, rate, taps) {
    const M = (taps - 1) / 2;
    const fc = cutoffHz / rate;
    const h = new Float32Array(taps);
    let sum = 0;
    for (let n = 0; n < taps; n++) {
        const k = n - M;
        const sinc = (k === 0) ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
        const win = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (taps - 1));
        h[n] = sinc * win;
        sum += h[n];
    }
    for (let n = 0; n < taps; n++) h[n] /= sum;
    return h;
}

const WATCH_FIR = designLowPass(LPF_HZ, VOICE_RATE, FIR_TAPS);

function clip16(v) {
    if (v > 32767) return 32767;
    if (v < -32768) return -32768;
    return Math.trunc(v);
}

// Float samples (-1..1) at 'rate' -> Int16 samples at 16 kHz.
export function toVoiceRate(samples, rate) {
    let source = samples;
    if (rate !== VOICE_RATE) {
        // low-pass at the mic rate, then pick or interpolate 16 kHz samples
        let taps = Math.round(rate / 250) | 1;
        const h = designLowPass(PRE_LPF_HZ, rate, taps);
        const M = (taps - 1) / 2;
        const filtered = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
            let acc = 0;
            for (let t = 0; t < taps; t++) {
                const idx = i + M - t;
                if (idx >= 0 && idx < samples.length) acc += h[t] * samples[idx];
            }
            filtered[i] = acc;
        }
        source = filtered;
    }
    const outLength = Math.floor(samples.length * VOICE_RATE / rate);
    const out = new Int16Array(outLength);
    const step = rate / VOICE_RATE;
    for (let k = 0; k < outLength; k++) {
        const pos = k * step;
        const i = Math.floor(pos);
        const frac = pos - i;
        const a = source[i] ?? 0;
        const b = source[i + 1] ?? a;
        out[k] = clip16((a + (b - a) * frac) * 32767);
    }
    return out;
}

// 16 kHz Int16 -> 8 kHz Int16 ready for Codec2 (the watch's prepareForEncode()).
export function prepareForEncode(pcm16k) {
    const n = pcm16k.length;
    const pcm = new Int16Array(pcm16k);
    if (n === 0) return new Int16Array(0);

    // DC removal and the 99.9% level (histogram of 256 steps of 128)
    let sum = 0;
    for (let i = 0; i < n; i++) sum += pcm[i];
    const dc = Math.trunc(sum / n);
    const hist = new Uint32Array(256);
    let peak = 0;
    for (let i = 0; i < n; i++) {
        let v = pcm[i] - dc;
        if (v > 32767) v = 32767;
        if (v < -32768) v = -32768;
        pcm[i] = v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        hist[Math.min(a >> 7, 255)]++;
    }
    const want = Math.floor(n * LEVEL_PERMILLE / 1000);
    let seen = 0;
    let level = peak;
    for (let b = 0; b < 256; b++) {
        seen += hist[b];
        if (seen >= want) { level = (b + 1) << 7; break; }
    }
    if (level > peak) level = peak;
    if (level >= 100) {
        const gain = 29491 / level;   // 90% of full scale
        for (let i = 0; i < n; i++) pcm[i] = clip16(pcm[i] * gain);
    }

    // 2nd-order Butterworth high-pass (RBJ biquad)
    const w0 = 2 * Math.PI * HPF_HZ / VOICE_RATE;
    const alpha = Math.sin(w0) / (2 * 0.7071);
    const cw = Math.cos(w0);
    const a0 = 1 + alpha;
    const b0 = ((1 + cw) / 2) / a0, b1 = (-(1 + cw)) / a0, b2 = b0;
    const a1 = (-2 * cw) / a0, a2 = (1 - alpha) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
        const x = pcm[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        pcm[i] = clip16(y);
    }

    // 3.6 kHz low-pass and decimate by 2
    const M = (FIR_TAPS - 1) / 2;
    const n8 = Math.floor(n / 2);
    const out = new Int16Array(n8);
    for (let k = 0; k < n8; k++) {
        const centre = k * 2;
        let acc = 0;
        for (let t = 0; t < FIR_TAPS; t++) {
            const idx = centre + M - t;
            if (idx >= 0 && idx < n) acc += WATCH_FIR[t] * pcm[idx];
        }
        out[k] = clip16(acc);
    }
    return out;
}

// 8 kHz Int16 -> 16 kHz Float32 (-1..1) for playback (the watch's upsampleForPlay()).
export function upsampleForPlay(pcm8k) {
    const M = (FIR_TAPS - 1) / 2;
    const n16 = pcm8k.length * 2;
    const out = new Float32Array(n16);
    for (let m = 0; m < n16; m++) {
        let acc = 0;
        for (let t = 0; t < FIR_TAPS; t++) {
            const idx = m + M - t;
            if (idx >= 0 && idx < n16 && (idx & 1) === 0) acc += WATCH_FIR[t] * pcm8k[idx / 2];
        }
        out[m] = clip16(2 * acc) / 32768;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Codec2 (WebAssembly)
// ---------------------------------------------------------------------------

const scriptLoads = {};

function loadScript(file, globalName) {
    if (typeof window[globalName] === "function") return Promise.resolve();
    if (!scriptLoads[file]) {
        scriptLoads[file] = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = CODEC2_BASE + file;
            script.onload = () => (typeof window[globalName] === "function")
                ? resolve()
                : reject(new Error(`${globalName} not found after loading ${file}`));
            script.onerror = () => {
                delete scriptLoads[file];
                reject(new Error(`Failed to load ${file}`));
            };
            document.head.appendChild(script);
        });
    }
    return scriptLoads[file];
}

// Runs c2enc or c2dec as a command-line program on an in-memory file.
function runCodec2(factoryName, inputName, outputName, input) {
    return new Promise((resolve, reject) => {
        const module = {
            arguments: ["1200", inputName, outputName],
            preRun: () => {
                module.FS.writeFile(inputName, input);
            },
            postRun: () => {
                try {
                    resolve(module.FS.readFile(outputName, { encoding: "binary" }));
                } catch (e) {
                    reject(e);
                }
            },
            locateFile: (path) => CODEC2_BASE + path,
            print: () => {},
            printErr: () => {},
        };
        try {
            window[factoryName](module);
        } catch (e) {
            reject(e);
        }
    });
}

// 8 kHz Int16 (whole frames) -> Codec2 1200 bytes, at most 12 seconds.
export async function encodeCodec2(pcm8k) {
    await loadScript("c2enc.js", "createC2Enc");
    const usable = Math.min(pcm8k.length - (pcm8k.length % C2_FRAME_SAMPLES),
                            VOICE_MAX_SECONDS * C2_RATE);
    if (usable <= 0) return new Uint8Array(0);
    const input = new Uint8Array(pcm8k.buffer, pcm8k.byteOffset, usable * 2).slice();
    const out = await runCodec2("createC2Enc", "input.raw", "output.bit", input);
    return new Uint8Array(out.slice(0, Math.min(out.length - (out.length % C2_FRAME_BYTES), VOICE_MAX_BYTES)));
}

// Codec2 1200 bytes -> 8 kHz Int16.
export async function decodeCodec2(c2) {
    await loadScript("c2dec.js", "createC2Dec");
    const usable = c2.length - (c2.length % C2_FRAME_BYTES);
    if (usable <= 0) return new Int16Array(0);
    const out = await runCodec2("createC2Dec", "input.bit", "output.raw", new Uint8Array(c2.slice(0, usable)));
    const bytes = new Uint8Array(out);
    return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2)).slice();
}

// A note's packets (Uint8Array or null for missing) -> 16 kHz Float32 for
// playback. Each run of packets that arrived is decoded in one go; a missing
// packet becomes the silence it would have filled (150 bytes = 1 second).
export async function decodeNote(packets) {
    const pieces = [];
    let run = [];
    const flushRun = async () => {
        if (run.length === 0) return;
        const total = run.reduce((n, p) => n + p.length, 0);
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const p of run) { joined.set(p, offset); offset += p.length; }
        pieces.push(await decodeCodec2(joined));
        run = [];
    };
    for (const packet of packets) {
        if (packet && packet.length > 0) {
            run.push(packet);
        } else {
            await flushRun();
            pieces.push(new Int16Array((VOICE_PACKET_BYTES / C2_FRAME_BYTES) * C2_FRAME_SAMPLES));
        }
    }
    await flushRun();
    const total = pieces.reduce((n, p) => n + p.length, 0);
    const pcm8k = new Int16Array(total);
    let offset = 0;
    for (const p of pieces) { pcm8k.set(p, offset); offset += p.length; }
    return upsampleForPlay(pcm8k);
}

// Splits Codec2 bytes into voice packets' worth of data.
export function splitPackets(c2) {
    const packets = [];
    for (let offset = 0; offset < c2.length && packets.length < VOICE_MAX_PACKETS; offset += VOICE_PACKET_BYTES) {
        packets.push(c2.slice(offset, offset + VOICE_PACKET_BYTES));
    }
    return packets;
}

export function durationSeconds(c2Bytes) {
    return Math.floor((Math.floor(c2Bytes / C2_FRAME_BYTES) * C2_FRAME_MS) / 1000);
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

let playbackContext = null;
let currentSource = null;

export function getAudioContext() {
    if (!playbackContext) {
        playbackContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (playbackContext.state === "suspended") playbackContext.resume();
    return playbackContext;
}

// Plays 16 kHz Float32 samples. Resolves when playback ends or is stopped.
export function playPcm16k(samples) {
    stopPlayback();
    const ctx = getAudioContext();
    const buffer = ctx.createBuffer(1, samples.length, VOICE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    currentSource = source;
    return new Promise((resolve) => {
        source.onended = () => {
            if (currentSource === source) currentSource = null;
            resolve();
        };
        source.start();
    });
}

export function stopPlayback() {
    if (currentSource) {
        try { currentSource.stop(); } catch (e) {}
        currentSource = null;
    }
}

// ---------------------------------------------------------------------------
// Recording (the same capture path as mic-test.html, which E confirmed
// records and plays back in Bluefy on iPhone, 13 Nov 2026)
// ---------------------------------------------------------------------------

export class VoiceRecorder {
    constructor() {
        this.stream = null;
        this.source = null;
        this.processor = null;
        this.chunks = [];
        this.recording = false;
        this.sampleRate = 0;
        this.onLevel = null;      // (0..1) per audio block
        this.onAutoStop = null;   // called when the 12 s limit is reached
        this._timer = null;
        this._startedAt = 0;
    }

    async start() {
        this.chunks = [];
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const ctx = getAudioContext();
        this.sampleRate = ctx.sampleRate;
        this.source = ctx.createMediaStreamSource(this.stream);
        this.processor = ctx.createScriptProcessor(4096, 1, 1);
        this.processor.onaudioprocess = (event) => {
            if (!this.recording) return;
            const data = event.inputBuffer.getChannelData(0);
            this.chunks.push(new Float32Array(data));
            if (this.onLevel) {
                let peak = 0;
                for (let i = 0; i < data.length; i++) {
                    const v = Math.abs(data[i]);
                    if (v > peak) peak = v;
                }
                this.onLevel(peak);
            }
        };
        this.source.connect(this.processor);
        this.processor.connect(ctx.destination);
        this.recording = true;
        this._startedAt = performance.now();
        this._timer = setTimeout(() => {
            if (this.recording && this.onAutoStop) this.onAutoStop();
        }, VOICE_MAX_SECONDS * 1000);
    }

    elapsedSeconds() {
        return this.recording ? (performance.now() - this._startedAt) / 1000 : 0;
    }

    // Returns { samples: Float32Array, sampleRate }.
    stop() {
        this.recording = false;
        clearTimeout(this._timer);
        if (this.processor) { this.processor.disconnect(); this.processor.onaudioprocess = null; }
        if (this.source) this.source.disconnect();
        if (this.stream) this.stream.getTracks().forEach(t => t.stop());
        this.processor = null;
        this.source = null;
        this.stream = null;
        const maxSamples = VOICE_MAX_SECONDS * this.sampleRate;
        const total = Math.min(this.chunks.reduce((n, c) => n + c.length, 0), maxSamples);
        const samples = new Float32Array(total);
        let offset = 0;
        for (const chunk of this.chunks) {
            if (offset >= total) break;
            const take = Math.min(chunk.length, total - offset);
            samples.set(chunk.subarray(0, take), offset);
            offset += take;
        }
        this.chunks = [];
        return { samples, sampleRate: this.sampleRate };
    }
}

// Recorded audio -> Codec2 1200 bytes, through the watch's filters.
export async function encodeRecording(samples, sampleRate) {
    const pcm16k = toVoiceRate(samples, sampleRate);
    const pcm8k = prepareForEncode(pcm16k);
    return encodeCodec2(pcm8k);
}
