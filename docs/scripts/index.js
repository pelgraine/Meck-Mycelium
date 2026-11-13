import { setColorScheme, setTheme, snackbar } from "./libs/mdui/mdui.js";
import { WebSerialConnection, Constants, WebBleConnection } from "./libs/meshcore/index.js";
import { Router } from "./router.js";
import { SimpleDB } from "./storage.js";
import { CustomElements } from "./customElements.js";
import VoiceReceiver from './libs/voice_receiver.js';
import VoiceSender from './libs/voice_sender.js';
import VoiceChannel, { VOICE_CHANNEL_NAME, VOICE_CHANNEL_STORE_KEY } from './libs/voice_channel.js';
import { channelKey, splitSender } from './libs/channels.js';
import DeliveryTracker from './libs/delivery.js';

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

        this.voiceRx.onVoiceReady = async ({ senderName, durationSec, recordId, packets }) => {
            snackbar({
                message: `Playing voice from ${senderName} (${durationSec}s)`,
                autoCloseDelay: 3000,
                closeOnOutsideClick: true
            });
            // Keep the note's Codec2 data with its message, so it can be played after a reload
            if (recordId != null) {
                try {
                    const record = await this.db.get("messages", recordId);
                    if (record) {
                        record.voice = { packets: packets, received: packets.filter(p => p).length };
                        await this.db.put("messages", record);
                        this.dispatchEvent(new CustomEvent("message"));
                    }
                } catch (e) {
                    console.warn("Voice: could not save note", e);
                }
            }
        };

        this.voiceTx = new VoiceSender(
            () => (this.isConnected ? this.device : null),
            () => this.contacts,
            () => this.info
        );

        // Voice messages on the #voice channel (Meck Watch / Meck-P4 format)
        this.voiceChannel = new VoiceChannel(() => (this.isConnected ? this.device : null), () => this.info);
        this.voiceChannel.onReady = async ({ sessionId, senderName, durationSec, total, packets, startedAt }) => {
            const received = packets.filter(p => p).length;
            try {
                await this.db.add("messages", {
                    publicKey: VOICE_CHANNEL_STORE_KEY,
                    channelVoice: { sessionId, senderName, durationSec, total, packets, received, outgoing: false, unread: true },
                    timestamp: startedAt
                });
            } catch (e) {
                console.warn("Voice channel: could not save message", e);
            }
            snackbar({
                message: `Voice message from ${senderName || "someone"} on ${VOICE_CHANNEL_NAME}` + (received < total ? ` (${received} of ${total} packets)` : ""),
                autoCloseDelay: 4000,
                closeOnOutsideClick: true
            });
            this.dispatchEvent(new CustomEvent("voicechannel"));
        };

        // Delivery and repeats of messages sent from this app
        this.delivery = new DeliveryTracker(this);

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

        this.ui.syncStatus = document.getElementById("syncStatus");
        this.ui.syncStatusText = document.getElementById("syncStatusText");

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

    // Connection and sync progress, shown under the title bar
    setSyncStatus(text) {
        this.ui.syncStatusText.textContent = text;
        this.ui.syncStatus.classList.remove("hidden");
    }

    clearSyncStatus() {
        this.ui.syncStatus.classList.add("hidden");
        this.ui.syncStatusText.textContent = "";
    }

    async connect(method) {
        this.ui.radioIndercator.setAttribute("loading", "true");
        this.setSyncStatus("Connecting…");

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
                        this.clearSyncStatus();

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

        if (!this.device) {
            this.clearSyncStatus();
            return;
        }

        this.subscribeEvents();
    }

    // A recipient confirmed a direct message (PUSH_CODE_SEND_CONFIRMED)
    handleMessageAck(data) {
        this.delivery.onAck(data);
    }

    async disconnect() {
        this.device.close();
        this.device.emit("disconnected", {});

        this.dispatchEvent(new CustomEvent("disconnected"));
    }

    subscribeEvents() {
        this.device.on("connected", () => this.handleConnected());
        this.device.on("disconnected", () => this.handleDisconnected());
        this.device.on(Constants.PushCodes.MsgWaiting, () => this.syncMessages());
        this.device.on(Constants.PushCodes.SendConfirmed, (data) => this.handleMessageAck(data));
        // Every packet the radio hears, used to spot repeaters passing our messages on
        this.device.on(Constants.PushCodes.LogRxData, (data) => this.delivery.onRxLog(data));
   this.device.on(Constants.PushCodes.RawData, (data) => {
            this.voiceRx.onRawData(data.payload);   // 0x56 voice packets
            this.voiceTx.onRawData(data.payload);   // 0x72 fetch requests for notes we sent
        });
        // Meck: keep the contact list (and so each contact's path) current
        this.device.on(Constants.PushCodes.PathUpdated, () => this.refreshContacts());
        this.device.on(Constants.PushCodes.ContactDeleted, () => this.refreshContacts());
        this.device.on(Constants.PushCodes.ContactsFull, () => {
            snackbar({
                message: "The radio's contact list is full",
                closeOnOutsideClick: true
            });
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

    async refreshContacts() {
        if (!this.isConnected || !this.device) return;
        try {
            this.contacts = await this.device.getContacts();
            this.dispatchEvent(new CustomEvent("contacts"));
        } catch (e) {
            console.warn("Contact refresh failed", e);
        }
    }

    async handleConnected() {
        this.isConnected = true;
        this._connecting = true;
        this.voiceChannel.resetRadio();
        this.channels = [];

        this.setSyncStatus("Reading node…");
        this.info = await this.device.getSelfInfo();

        this.ui.radioIndercatorName.innerText = `Connected`;
        this.ui.radioIndercator.removeAttribute("loading");
        this.ui.radioIndercator.removeAttribute("disabled");

        this.contacts = await this.loadContacts();

        console.log(this);

        Router.handleRoute();
       try { CustomElements.radioOnly(); } catch(e) {}

        this.dispatchEvent(new CustomEvent("connected"));

        await this.loadChannels();
        await this.syncMessages();

        this._connecting = false;
        if (this.isConnected) this.clearSyncStatus();
    }

    // Reads the contact list, counting "Contacts 23 of 150" (the node sends the total first).
    async loadContacts() {
        const device = this.device;
        let total = null;
        let read = 0;
        const show = () => this.setSyncStatus(total != null ? `Contacts ${read} of ${total}` : `Contacts ${read}`);
        const onStart = (e) => { total = e.count; show(); };
        const onContact = () => { read++; show(); };
        show();
        device.on(Constants.ResponseCodes.ContactsStart, onStart);
        device.on(Constants.ResponseCodes.Contact, onContact);
        try {
            return await device.getContacts();
        } catch (e) {
            console.warn("Contacts: could not read", e);
            return this.contacts ?? [];
        } finally {
            device.off(Constants.ResponseCodes.ContactsStart, onStart);
            device.off(Constants.ResponseCodes.Contact, onContact);
        }
    }

    // Reads the radio's channels, counting "Channels 5 of 20". Keeps the ones in use in this.channels.
    async loadChannels() {
        if (!this.isConnected || !this.device) return;
        this.setSyncStatus("Channels…");
        try {
            const scan = await this.device.readChannels(null, (read, total) => {
                this.setSyncStatus(`Channels ${read} of ${total}`);
            });
            this.channelScan = scan;   // every slot, empty ones included (for finding a free slot)
            this.channels = scan.channels.filter(c => c.name);
            await this.voiceChannel.useScan(scan);
            this.dispatchEvent(new CustomEvent("channels"));
        } catch (e) {
            console.warn("Channels: could not read", e);
        }
        if (!this._connecting) this.clearSyncStatus();
    }

    // Fetches the messages waiting on the node, one at a time, counting
    // "Messages 3". Only one fetch runs at once; a "messages waiting" notice
    // that arrives meanwhile makes it go round again.
    async syncMessages() {
        if (!this.isConnected || !this.device) return;
        if (this._syncingMessages) {
            this._syncAgain = true;
            return;
        }
        this._syncingMessages = true;
        let count = 0;
        try {
            do {
                this._syncAgain = false;
                while (this.isConnected && this.device) {
                    const message = await Promise.race([
                        this.device.syncNextMessage(),
                        new Promise(resolve => setTimeout(() => resolve("timeout"), 10000)),
                    ]);
                    if (!message || message === "timeout") break;
                    count++;
                    this.setSyncStatus(`Messages ${count}`);
                    try {
                        await this.processMessage(message);
                    } catch (e) {
                        console.warn("Messages: could not process", e, message);
                    }
                }
            } while (this._syncAgain && this.isConnected);
        } finally {
            this._syncingMessages = false;
            if (!this._connecting && count > 0) this.clearSyncStatus();
        }
    }

    async handleDisconnected() {
        this.isConnected = false;
        this._connecting = false;
        this.voiceChannel.resetRadio();
        this.channels = [];
        this.device = null;
        this.clearSyncStatus();

        this.ui.radioIndercatorName.innerText = "Disconnected";
        this.ui.radioIndercator.removeAttribute("loading");
        this.ui.radioIndercator.setAttribute("disabled", "true");

        CustomElements.radioOnly();

        this.dispatchEvent(new CustomEvent("disconnected"));
    }

    // Kept for anything that still calls it: fetches waiting messages.
    async handleMessage() {
        return this.syncMessages();
    }

    async processMessage(message) {
        console.log(message);
        
        if (message.contactMessage) {
            const contact = await this.device.findContactByPublicKeyPrefix(message.contactMessage.pubKeyPrefix);

            const recordId = await this.db.add("messages", {
                publicKey: contact.publicKey,
                message: message.contactMessage,
                timestamp: Date.now()
            });

            // Check for VE3 voice envelope (after saving, so the note can be stored with its message)
            if (message.contactMessage.text && message.contactMessage.text.startsWith("VE3:")) {
                const senderName = contact?.advName || "Unknown";
                this.voiceRx.onVE3Envelope(senderName, message.contactMessage.text, recordId);
            }
        } else if (message.channelMessage) {
            await this.saveChannelMessage(message.channelMessage);
        } else if (message.channelData) {
            // Meck: voice messages on #voice arrive as channel data (type 0xFF56)
            if (await this.voiceChannel.isVoiceData(message.channelData)) {
                this.voiceChannel.onChannelData(message.channelData.data);
            }
        }

        this.dispatchEvent(new CustomEvent("message", message));
    }

    // Saves a channel text message under its channel's key. "Name: text" is
    // split into sender and text. Marks it unread unless that channel is open.
    async saveChannelMessage(message) {
        let channel = (this.channels || []).find(c => c.channelIdx === message.channelIdx);
        if (!channel && this.device) {
            try {
                channel = await this.device.readChannel(message.channelIdx);
                if (channel?.name) {
                    this.channels = [...(this.channels || []).filter(c => c.channelIdx !== channel.channelIdx), channel];
                    this.dispatchEvent(new CustomEvent("channels"));
                }
            } catch (e) {
                console.warn("Channels: could not read slot", message.channelIdx, e);
            }
        }
        if (!channel?.secret) {
            console.warn("Channels: message for an unknown channel slot", message);
            return;
        }
        const key = channelKey(channel.secret);
        const { senderName, text } = splitSender(message.text);
        await this.db.add("messages", {
            publicKey: key,
            channelMessage: {
                senderName,
                text,
                senderTimestamp: message.senderTimestamp,
                pathLen: message.pathLen,
                snr: message.snr,
                channelIdx: message.channelIdx,
                outgoing: false,
            },
            unread: this.openChannelKey !== key,
            timestamp: Date.now()
        });
        this.dispatchEvent(new CustomEvent("channelmessage", { detail: { key } }));
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