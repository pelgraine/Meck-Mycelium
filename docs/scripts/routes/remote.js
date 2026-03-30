import { MQTTClient } from "../libs/mqtt_client.js";
import { snackbar } from "../libs/mdui/mdui.js";

// Shared MQTT client instance (persists across route navigations)
if (!window._mqttClient) {
    window._mqttClient = new MQTTClient();
}
const mqttClient = window._mqttClient;

export default class Remote {
    static _boundTelemetry = null;
    static _boundResponse = null;
    static _boundConnected = null;
    static _boundDisconnected = null;

    static async init(parameters) {
        // Load saved config into form fields
        const config = MQTTClient.loadConfig();
        if (config) {
            document.getElementById("cfgBroker").value = config.broker || "";
            document.getElementById("cfgPort").value = config.wsPort || 8884;
            document.getElementById("cfgDeviceId").value = config.deviceId || "";
            document.getElementById("cfgUsername").value = config.username || "";
            document.getElementById("cfgPassword").value = config.password || "";
        }

        // Wire up buttons
        document.getElementById("mqttConnectBtn").addEventListener("click", () => this.toggleConnection());
        document.getElementById("cfgSaveBtn").addEventListener("click", () => this.saveAndConnect());
        document.getElementById("cfgClearBtn").addEventListener("click", () => this.clearConfig());
        document.getElementById("cliSendBtn").addEventListener("click", () => this.sendCliCommand());
        document.getElementById("otaSendBtn").addEventListener("click", () => this.sendOTA());

        // Enter key sends CLI command
        document.getElementById("cliInput").addEventListener("keydown", (e) => {
            if (e.key === "Enter") this.sendCliCommand();
        });

        // Quick command buttons
        document.querySelectorAll(".quickCmd").forEach(btn => {
            btn.addEventListener("click", () => {
                const cmd = btn.getAttribute("data-cmd");
                if (cmd === "reboot") {
                    if (!confirm("Reboot the remote repeater?")) return;
                }
                this.sendCommand(cmd);
            });
        });

        // Subscribe to MQTT events
        this._boundTelemetry = (e) => this.onTelemetry(e.detail);
        this._boundResponse = (e) => this.onResponse(e.detail);
        this._boundConnected = () => this.updateUI();
        this._boundDisconnected = () => this.updateUI();

        mqttClient.addEventListener("telemetry", this._boundTelemetry);
        mqttClient.addEventListener("response", this._boundResponse);
        mqttClient.addEventListener("connected", this._boundConnected);
        mqttClient.addEventListener("disconnected", this._boundDisconnected);

        // If already connected, populate with last telemetry
        if (mqttClient.connected && mqttClient.lastTelemetry) {
            this.onTelemetry(mqttClient.lastTelemetry);
        }

        this.updateUI();
    }

    static updateUI() {
        const connected = mqttClient.connected;
        const icon = document.getElementById("mqttStatusIcon");
        const text = document.getElementById("mqttStatusText");
        const deviceId = document.getElementById("mqttDeviceId");
        const connectBtn = document.getElementById("mqttConnectBtn");
        const configCard = document.getElementById("configCard");
        const telemetrySection = document.getElementById("telemetrySection");

        if (connected) {
            icon.setAttribute("name", "cloud_done");
            icon.style.color = "rgb(var(--mdui-color-primary))";
            text.innerText = "Connected";
            deviceId.innerText = mqttClient.config?.deviceId || "";
            connectBtn.innerText = "Disconnect";
            configCard.style.display = "none";
            telemetrySection.style.display = "block";
        } else {
            icon.setAttribute("name", "cloud_off");
            icon.style.color = "rgb(var(--mdui-color-error))";
            text.innerText = "Not Connected";
            deviceId.innerText = "";
            connectBtn.innerText = "Connect";
            configCard.style.display = "block";
            telemetrySection.style.display = "none";
        }
    }

    static async toggleConnection() {
        if (mqttClient.connected) {
            mqttClient.disconnect();
            snackbar({ message: "Disconnected", autoCloseDelay: 2000, closeOnOutsideClick: true });
            return;
        }

        const config = MQTTClient.loadConfig();
        if (!config || !config.broker) {
            snackbar({ message: "No saved config — fill in the fields below", autoCloseDelay: 3000, closeOnOutsideClick: true });
            return;
        }

        await this.doConnect(config);
    }

    static async saveAndConnect() {
        const config = {
            broker: document.getElementById("cfgBroker").value.trim(),
            wsPort: parseInt(document.getElementById("cfgPort").value) || 8884,
            deviceId: document.getElementById("cfgDeviceId").value.trim(),
            username: document.getElementById("cfgUsername").value.trim(),
            password: document.getElementById("cfgPassword").value,
        };

        if (!config.broker || !config.deviceId || !config.username) {
            snackbar({ message: "Broker, Device ID, and Username are required", autoCloseDelay: 3000, closeOnOutsideClick: true });
            return;
        }

        MQTTClient.saveConfig(config);
        await this.doConnect(config);
    }

    static async doConnect(config) {
        const connectBtn = document.getElementById("mqttConnectBtn");
        const statusText = document.getElementById("mqttStatusText");

        connectBtn.setAttribute("loading", "true");
        statusText.innerText = "Connecting...";

        try {
            await mqttClient.connect(config);
            snackbar({ message: `Connected to ${config.deviceId}`, autoCloseDelay: 2000, closeOnOutsideClick: true });
        } catch (e) {
            snackbar({ message: `Connection failed: ${e.message || e}`, autoCloseDelay: 4000, closeOnOutsideClick: true });
            statusText.innerText = "Connection Failed";
        }

        connectBtn.removeAttribute("loading");
        this.updateUI();
    }

    static clearConfig() {
        MQTTClient.clearConfig();
        document.getElementById("cfgBroker").value = "";
        document.getElementById("cfgPort").value = "8884";
        document.getElementById("cfgDeviceId").value = "";
        document.getElementById("cfgUsername").value = "";
        document.getElementById("cfgPassword").value = "";
        snackbar({ message: "Config cleared", autoCloseDelay: 2000, closeOnOutsideClick: true });
    }

    static onTelemetry(data) {
        const el = (id) => document.getElementById(id);
        if (!el("telName")) return;

        el("telName").innerText = data.name || "—";

        if (data.uptime !== undefined) {
            const h = Math.floor(data.uptime / 3600);
            const m = Math.floor((data.uptime % 3600) / 60);
            el("telUptime").innerText = `${h}h ${m}m`;
        }

        if (data.batt_mv !== undefined) {
            el("telBatt").innerText = `${data.batt_mv} mV (${data.batt_pct}%)`;
        }

        if (data.heap !== undefined) {
            el("telHeap").innerText = `${Math.round(data.heap / 1024)} KB`;
        }

        el("telLastUpdate").innerText = new Date().toLocaleTimeString();

        // Radio
        if (data.freq !== undefined) {
            el("telFreq").innerText = `${data.freq.toFixed(3)} MHz`;
        }
        if (data.bw !== undefined) {
            el("telRadio").innerText = `${data.bw} kHz / SF${data.sf} / CR${data.cr}`;
        }
        if (data.tx !== undefined) {
            el("telTx").innerText = `${data.tx} dBm`;
        }

        // Cellular
        if (data.csq !== undefined) {
            const bars = data.bars || 0;
            const barStr = "▰".repeat(bars) + "▱".repeat(5 - bars);
            el("telSignal").innerText = `${barStr}  CSQ ${data.csq}`;
        }
        el("telOper").innerText = data.oper || "—";
        el("telApn").innerText = data.apn || "—";
        el("telIp").innerText = data.ip || "—";
    }

    static onResponse(text) {
        const log = document.getElementById("cliLog");
        if (!log) return;

        // Update OTA status if this is an OTA message
        if (text.startsWith("OTA:")) {
            const otaStatus = document.getElementById("otaStatus");
            if (otaStatus) otaStatus.innerText = text;
        }

        const time = new Date().toLocaleTimeString();
        const entry = document.createElement("div");
        entry.style.marginBottom = "6px";
        entry.innerHTML = `<span style="opacity:0.5;">[${time}]</span> ${this.escapeHtml(text)}`;

        // Clear placeholder on first response
        if (log.querySelector("span[style]") && log.children.length === 1) {
            log.innerHTML = "";
        }

        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
    }

    static sendCliCommand() {
        const input = document.getElementById("cliInput");
        const cmd = input.value.trim();
        if (!cmd) return;

        if (mqttClient.sendCommand(cmd)) {
            const log = document.getElementById("cliLog");
            if (log.querySelector("span[style]") && log.children.length === 1) {
                log.innerHTML = "";
            }

            const time = new Date().toLocaleTimeString();
            const entry = document.createElement("div");
            entry.style.marginBottom = "6px";
            entry.style.opacity = "0.7";
            entry.innerHTML = `<span style="opacity:0.5;">[${time}]</span> > ${this.escapeHtml(cmd)}`;
            log.appendChild(entry);
            log.scrollTop = log.scrollHeight;

            input.value = "";
        } else {
            snackbar({ message: "Not connected", autoCloseDelay: 2000, closeOnOutsideClick: true });
        }
    }

    static sendCommand(cmd) {
        if (mqttClient.sendCommand(cmd)) {
            const log = document.getElementById("cliLog");
            if (log && log.querySelector("span[style]") && log.children.length === 1) {
                log.innerHTML = "";
            }
            const time = new Date().toLocaleTimeString();
            const entry = document.createElement("div");
            entry.style.marginBottom = "6px";
            entry.style.opacity = "0.7";
            entry.innerHTML = `<span style="opacity:0.5;">[${time}]</span> > ${this.escapeHtml(cmd)}`;
            if (log) { log.appendChild(entry); log.scrollTop = log.scrollHeight; }
        } else {
            snackbar({ message: "Not connected", autoCloseDelay: 2000, closeOnOutsideClick: true });
        }
    }

    static sendOTA() {
        const url = document.getElementById("otaUrl").value.trim();
        if (!url) {
            snackbar({ message: "Enter a firmware URL", autoCloseDelay: 2000, closeOnOutsideClick: true });
            return;
        }
        if (!url.endsWith(".bin")) {
            if (!confirm("URL doesn't end in .bin — are you sure this is a firmware file?")) return;
        }
        if (!confirm(`Flash firmware from:\n${url}\n\nThe device will disconnect and reboot. Continue?`)) return;

        if (mqttClient.sendOTA(url)) {
            document.getElementById("otaStatus").innerText = "OTA request sent — device will download and flash...";

            const log = document.getElementById("cliLog");
            if (log) {
                if (log.querySelector("span[style]") && log.children.length === 1) {
                    log.innerHTML = "";
                }
                const time = new Date().toLocaleTimeString();
                const entry = document.createElement("div");
                entry.style.marginBottom = "6px";
                entry.style.opacity = "0.7";
                entry.innerHTML = `<span style="opacity:0.5;">[${time}]</span> > OTA: ${this.escapeHtml(url)}`;
                log.appendChild(entry);
                log.scrollTop = log.scrollHeight;
            }
        } else {
            snackbar({ message: "Not connected", autoCloseDelay: 2000, closeOnOutsideClick: true });
        }
    }

    static escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    static cleanup() {
        if (this._boundTelemetry) mqttClient.removeEventListener("telemetry", this._boundTelemetry);
        if (this._boundResponse) mqttClient.removeEventListener("response", this._boundResponse);
        if (this._boundConnected) mqttClient.removeEventListener("connected", this._boundConnected);
        if (this._boundDisconnected) mqttClient.removeEventListener("disconnected", this._boundDisconnected);
    }
}
