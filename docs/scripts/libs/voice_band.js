// =============================================================================
// voice_band.js -- voice messages are only sent from 2.4 GHz radios.
//
// A voice message is many packets, which would crowd a sub-GHz mesh. The
// radio reports its frequency in kHz (MHz x 1000) in its reply to the app's
// start-up handshake (RESP_CODE_SELF_INFO), as upstream MeshCore, Meck-P4 and
// Meck Watch do. That reply is the only place the app gets the frequency, and
// sending the handshake again mid-session has side effects on the radio, so
// the value from when the app connected is used.
// =============================================================================

export const MIN_VOICE_FREQ_KHZ = 2400000;   // 2400 MHz

// Why voice can't be sent from this radio, or null if it can (or the
// frequency isn't known yet, e.g. not connected).
export function voiceBandProblem(info) {
    const khz = info?.radioFreq;
    if (typeof khz !== "number" || khz <= 0) return null;
    if (khz >= MIN_VOICE_FREQ_KHZ) return null;
    return `Voice messages need a 2.4 GHz radio. This radio is on ${(khz / 1000).toFixed(3)} MHz.`;
}

export class VoiceBandError extends Error {}

// Throws a VoiceBandError if voice can't be sent from this radio.
export function assertVoiceBand(info) {
    const problem = voiceBandProblem(info);
    if (problem) throw new VoiceBandError(problem);
}
