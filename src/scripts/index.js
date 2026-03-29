import { setColorScheme, setTheme, snackbar } from "./libs/mdui/mdui.js";
import { WebSerialConnection, Constants, WebBleConnection } from "./libs/meshcore/index.js";
import { Router } from "./router.js";
import { SimpleDB } from "./storage.js";
import { CustomElements } from "./customElements.js";
import VoiceReceiver from './libs/voice_receiver.js';

class App extends EventTarget {
    constructor() {
        super();

        this.db = new SimpleDB("appData", 1, {
            settings: {
                keyPath: "key",
                indexes: []
            },
            contacts: {
                keyPath: "publicKey",
                indexes: []
            },
            messages: {
                keyPath: "id",
                autoIncrement: true,
                indexes: [
                    { name: "publicKey", keyPath: "publicKey" }
                ]
            },
        });

this.voiceRx = new VoiceReceiver();

        this.voiceRx.onSessionStarted = ({ senderName, durationSec }) => {
            snackbar({
                message: `Voice message from ${senderName} (${durationSec}s) — receiving...`,
                autoCloseDelay: 3000,
                closeOnOutsideClick: true
            });
        };

        this.voiceRx.onProgress = ({ senderName, received, total }) => {
            console.log(`Voice: ${received}/${total} packets from ${senderName}`);
        };

        this.voiceRx.onVoiceReady = ({ senderName, durationSec }) => {
            snackbar({
                message: `Playing voice from ${senderName} (${durationSec}s)`,
                autoCloseDelay: 3000,
                closeOnOutsideClick: true
            });
        };

        this.defineUserInterface();
        this.setupSettings();
    }

    // All the messy ui stuff goes here!
    defineUserInterface() {
        this.ui = {};

        this.ui.backButton = document.getElementById("backButton");
        this.ui.refreshButton = document.getElementById("refreshButton");

        this.ui.advertZeroHopButton = document.getElementById("advertZeroHopButton");
        this.ui.advertFloodButton = document.getElementById("advertFloodButton");
        this.ui.advertClipboardButton = document.getElementById("advertClipboardButton");

        this.ui.radioIndercator = document.getElementById("radioIndercator");
        this.ui.radioIndercatorName = document.getElementById("radioIndercatorName");

        this.ui.backButton.addEventListener("click", () => {
            if (this.ui.backButton.href) return;

            Router.navagateBack();
        });

        this.ui.refreshButton.addEventListener("click", () => {
            if (this.isConnected) async () => this.contacts = await this.device.getContacts();

            Router.handleRoute();
        });

        this.ui.advertZeroHopButton.addEventListener("click", () => {
            this.device?.sendZeroHopAdvert();
        });

        this.ui.advertFloodButton.addEventListener("click", () => {
            this.device?.sendFloodAdvert();
        });

        this.ui.advertClipboardButton.addEventListener("click", () => {
            // TODO: Add copy to clipboard
        });
    }

    async setupSettings() {
        const colourSchemes = {
            "red": "#ffb3a9",
            "purple": "#f9aaff",
            "blue": "#9dc9ff",
            "green": "#77db76",
            "yellow": "#dac812"
        }
        
        const settingsDefaults = {
            "theme": "auto",
            "scheme": "blue",
            "contactsSort": "Recent",
            "contactsFilter": ["pinned", "users", "roomservers", "repeaters"]
        }

        // Set all the defaults if needed
        for (const [setting, value] of Object.entries(settingsDefaults)) {
            if (!await this.db.has("settings", setting)) {
                await this.db.add("settings", { key: setting, value: value });
            } 
        }

        const theme = await this.db.get("settings", "theme");
        const scheme = await this.db.get("settings", "scheme");
        
        setTheme(theme.value);
        setColorScheme(colourSchemes[scheme.value]);
    }

    async connect(method) {
        this.ui.radioIndercator.setAttribute("loading", "true");

        try {
            switch (method) {
                case "serial":
                    this.device = await WebSerialConnection.open();
                    break;
                case "bluetooth":
                    try {
                        this.device = await WebBleConnection.open();
                    } catch (error) {
                        this.device = null;
                        this.ui.radioIndercator.removeAttribute("loading");

                        snackbar({
                            message: "Web Bluetooth is unavailable",
                            action: "Help",
                            closeOnOutsideClick: true,
                            onActionClick: () => {
                                window.open(
                                    "https://support.google.com/chrome/answer/6362090",
                                    "_blank"
                                );
                            }
                        });
                    }
                    break;
            }
        } catch {
            this.device = null;
            this.ui.radioIndercator.removeAttribute("loading");
        }

        this.subscribeEvents();
    }

    async disconnect() {
        this.device.close();
        this.device.emit("disconnected", {});

        this.dispatchEvent(new CustomEvent("disconnected"));
    }

    subscribeEvents() {
        this.device.on("connected", () => this.handleConnected());
        this.device.on("disconnected", () => this.handleDisconnected());
        this.device.on(Constants.PushCodes.MsgWaiting, () => this.handleMessage());
        this.device.on(Constants.PushCodes.SendConfirmed, () => this.handleMessageAck());
   this.device.on(Constants.PushCodes.RawData, (data) => {
            this.voiceRx.onRawData(data.payload);
        });
        // this.device.on(Constants.PushCodes.NewAdvert, () => this.handleContact()); // when companion is set to manually add contacts
    }

    async trace(path) {
        snackbar({
            message: `Sent ping`,
            autoCloseDelay: 1000,
            closeOnOutsideClick: true
        });

        const start = performance.now();

        try {
            const result = await this.device?.tracePath(path);
            const latency = Math.round(performance.now() - start);

            const hexString = new Uint8Array(result.pathHashes).toHex();
            const resultPath = (hexString.match(/.{1,2}/g) || []).map(x => `(${x})`);

            snackbar({
                message: `Ping Successful: (${latency}ms) You (${new Uint8Array([app.info.publicKey[0]]).toHex()}) -> ${resultPath.join(" -> ")} -> You (${new Uint8Array([app.info.publicKey[0]]).toHex()})`,
                closeOnOutsideClick: true
            });
        } catch (e) {
            snackbar({
                message: `Ping Failed: Timeout`,
                closeOnOutsideClick: true
            });
        }
    }

    async sendMessage() {

    }

    async handleConnected() {
        this.isConnected = true;
        this.info = await this.device.getSelfInfo();
        this.contacts = await this.device.getContacts();

        console.log(this);

        this.ui.radioIndercatorName.innerText = `Connected`;
        this.ui.radioIndercator.removeAttribute("loading");
        this.ui.radioIndercator.removeAttribute("disabled");
        
        Router.handleRoute();
       try { CustomElements.radioOnly(); } catch(e) {}

        this.dispatchEvent(new CustomEvent("connected"));
        this.voiceRx.loadCodec2Wasm('./scripts/libs/codec2/c2dec.js').catch(() => {});
    }

    async handleDisconnected() {
        this.isConnected = false;
        this.device = null;

        this.ui.radioIndercatorName.innerText = "Disconnected";
        this.ui.radioIndercator.removeAttribute("loading");
        this.ui.radioIndercator.setAttribute("disabled", "true");

        CustomElements.radioOnly();

        this.dispatchEvent(new CustomEvent("disconnected"));
    }

    async handleMessage() {
        const waitingMessages = await this.device.getWaitingMessages();

        for (const message of waitingMessages) {
            console.log(message);
            
            if (message.contactMessage) {
                const contact = await this.device.findContactByPublicKeyPrefix(message.contactMessage.pubKeyPrefix);
    
                // Check for VE3 voice envelope
                if (message.contactMessage.text && message.contactMessage.text.startsWith("VE3:")) {
                    const senderName = contact?.advName || "Unknown";
                    this.voiceRx.onVE3Envelope(senderName, message.contactMessage.text);
                }
                await this.db.add("messages", {
                    publicKey: contact.publicKey,
                    message: message.contactMessage,
                    timestamp: Date.now()
                });
            } else if (message.channelMessage) {
                console.log(message);
            }

            this.dispatchEvent(new CustomEvent("message", message));
        }
    }

    async handleContact() {
        await this.db.add("contacts", {
            publicKey: contact.publicKey,
            message: message.contactMessage,
            timestamp: Date.now()
        });

        this.dispatchEvent(new CustomEvent("contact", contact));
    }
}

export const app = new App();
window.app = app;
function createRadioSelections() {
    const elements = document.querySelectorAll("mdui-dropdown");

    elements.forEach(element => {
        element._lastClickedItem = null;

        element.addEventListener("pointerdown", async (event) => {
            const item = event.target.closest("mdui-menu-item:not([submenu])");            
            element.stayOpenOnClick = !item;
        });
    });
}

createRadioSelections();