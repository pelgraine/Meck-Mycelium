// =============================================================================
// MQTTClient — MQTT over WebSocket for remote repeater management
// Place in: docs/scripts/libs/mqtt_client.js
// =============================================================================

export class MQTTClient extends EventTarget {
    constructor() {
        super();
        this.client = null;
        this.connected = false;
        this.config = null;
        this.topics = {};
        this._reconnectTimer = null;
        this._reconnectDelay = 2000;
        this.lastTelemetry = null;
        this.lastTelemetryAt = null;
    }

    static loadConfig() {
        const saved = localStorage.getItem('meck_mqtt_config');
        if (!saved) return null;
        try { return JSON.parse(saved); } catch { return null; }
    }

    static saveConfig(config) {
        localStorage.setItem('meck_mqtt_config', JSON.stringify(config));
    }

    static clearConfig() {
        localStorage.removeItem('meck_mqtt_config');
    }

    async connect(config) {
        this.config = config;
        this.topics = {
            cmd: `meck/${config.deviceId}/cmd`,
            rsp: `meck/${config.deviceId}/rsp`,
            telemetry: `meck/${config.deviceId}/telemetry`,
            ota: `meck/${config.deviceId}/ota`
        };

        const brokerUrl = `wss://${config.broker}:${config.wsPort || 8884}/mqtt`;

        return new Promise((resolve, reject) => {
            try {
                this.client = mqtt.connect(brokerUrl, {
                    username: config.username,
                    password: config.password,
                    clientId: `mycelium-${Date.now().toString(36)}`,
                    clean: true,
                    reconnectPeriod: 0,
                    connectTimeout: 15000,
                    protocolVersion: 4
                });
            } catch (e) {
                reject(e);
                return;
            }

            this.client.on('connect', () => {
                this.connected = true;
                this._reconnectDelay = 2000;
                this.client.subscribe(this.topics.telemetry, { qos: 1 });
                this.client.subscribe(this.topics.rsp, { qos: 1 });
                this.dispatchEvent(new CustomEvent('connected'));
                resolve();
            });

            this.client.on('message', (topic, message) => {
                const payload = message.toString();
                if (topic === this.topics.telemetry) {
                    try {
                        const data = JSON.parse(payload);
                        this.lastTelemetry = data;
                        this.lastTelemetryAt = Date.now();
                        this.dispatchEvent(new CustomEvent('telemetry', { detail: data }));
                    } catch {}
                } else if (topic === this.topics.rsp) {
                    this.dispatchEvent(new CustomEvent('response', { detail: payload }));
                }
            });

            this.client.on('error', (err) => {
                this.dispatchEvent(new CustomEvent('error', { detail: err }));
                if (!this.connected) reject(err);
            });

            this.client.on('close', () => {
                const was = this.connected;
                this.connected = false;
                this.dispatchEvent(new CustomEvent('disconnected'));
                if (was) this._scheduleReconnect();
            });
        });
    }

    disconnect() {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        if (this.client) { this.client.end(true); this.client = null; }
        this.connected = false;
        this.dispatchEvent(new CustomEvent('disconnected'));
    }

    sendCommand(cmd) {
        if (!this.connected) return false;
        this.client.publish(this.topics.cmd, cmd, { qos: 1 });
        return true;
    }

    sendOTA(url) {
        if (!this.connected) return false;
        this.client.publish(this.topics.ota, url, { qos: 1 });
        return true;
    }

    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(async () => {
            this._reconnectTimer = null;
            try { await this.connect(this.config); }
            catch { this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000); this._scheduleReconnect(); }
        }, this._reconnectDelay);
    }
}