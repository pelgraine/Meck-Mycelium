import { app } from "../index.js";
import { Helpers } from "../libs/helpers.js";
import { Router } from "../router.js";
import { confirm, alert, snackbar } from "../libs/mdui/mdui.js";
import { channelKey, maxChannelTextBytes, utf8Length, fromHex, toHex } from "../libs/channels.js";
import { channelStatusText, heardDetails } from "../libs/delivery.js";
import { showDetails } from "../libs/details_dialog.js";

// One channel's chat: its messages, and a box to send to it.
export default class Channel {

    static async init(parameters) {
        this.secretHex = (parameters.key || "").toLowerCase();
        this.key = channelKey(fromHex(this.secretHex) || []);
        app.openChannelKey = this.key;

        this._onMessage = (event) => {
            if (event.detail?.key === this.key) this.markReadAndRender();
        };
        this._onChannels = () => this.updateHeader();
        app.addEventListener("channelmessage", this._onMessage);
        app.addEventListener("channels", this._onChannels);

        document.getElementById("sendButton").addEventListener("click", () => this.send());
        document.getElementById("messageTextField").addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                this.send();
            }
        });
        document.getElementById("channelKeyButton").addEventListener("click", () => this.showKey());
        document.getElementById("channelRemoveButton").addEventListener("click", () => this.remove());

        this.updateHeader();
        await this.markReadAndRender();
    }

    static cleanup() {
        if (app.openChannelKey === this.key) app.openChannelKey = null;
        app.removeEventListener("channelmessage", this._onMessage);
        app.removeEventListener("channels", this._onChannels);
    }

    // The channel as the radio has it now (its slot can change), or null.
    static channel() {
        return (app.channels || []).find(c => toHex(c.secret) === this.secretHex) ?? null;
    }

    static updateHeader() {
        const channel = this.channel();
        Router.setTitle(channel?.name ?? "Channel");
        const field = document.getElementById("messageTextField");
        if (field) field.maxlength = maxChannelTextBytes(app.info?.name);
    }

    static async markReadAndRender() {
        const records = await app.db.getByIndex("messages", "publicKey", this.key);
        for (const record of records) {
            if (record.unread) {
                record.unread = false;
                await app.db.put("messages", record);
            }
        }
        await this.render(records);
    }

    static async render(records = null) {
        const list = document.getElementById("messageList");
        const template = document.getElementById("messageTemplate");
        if (!list || !template) return; // left the page
        records = records ?? await app.db.getByIndex("messages", "publicKey", this.key);

        if (records.length === 0) {
            list.classList.add("hidden");
            document.getElementById("emptyMessage").classList.remove("hidden");
            return;
        }
        list.classList.remove("hidden");
        document.getElementById("emptyMessage").classList.add("hidden");

        const myName = app.info?.name ?? "You";
        const items = [];
        for (const record of records) {
            const message = record.channelMessage;
            if (!message) continue;
            const item = template.content.cloneNode(true);
            const name = message.outgoing ? myName : (message.senderName || "Unknown");
            item.getElementById("senderAvatar").innerText = Helpers.getLastEmoji(name) ?? name[0];
            item.getElementById("senderAvatar").style.backgroundColor = Helpers.stringToColour(name);
            item.getElementById("senderName").innerText = message.outgoing ? `You (${myName})` : name;
            item.getElementById("messageTimeStamp").value = new Date(record.timestamp);
            item.getElementById("messageContent").innerText = message.text;
            const status = item.getElementById("messageStatus");
            if (message.outgoing) {
                status.textContent = channelStatusText(message);
                if (message.status === "sent") {
                    status.classList.add("tappable");
                    status.addEventListener("click", () => showDetails("Repeats", heardDetails(message.heard, app.contacts)));
                }
            } else if (message.pathLen != null) {
                status.textContent = message.pathLen === 0xFF ? "direct" : `${message.pathLen & 63} hops`;
            }
            items.push(item);
        }
        list.replaceChildren(...items);
    }

    static async send() {
        const field = document.getElementById("messageTextField");
        const text = (field.value || "").trim();
        if (!text) return;

        const channel = this.channel();
        if (!app.isConnected || !channel) {
            snackbar({ message: app.isConnected ? "This channel isn't on the radio any more" : "Connect your radio first", closeOnOutsideClick: true });
            return;
        }
        const limit = maxChannelTextBytes(app.info?.name);
        if (utf8Length(text) > limit) {
            snackbar({ message: `That's too long for a channel message (${limit} bytes at most)`, closeOnOutsideClick: true });
            return;
        }

        field.value = "";
        const record = {
            publicKey: this.key,
            channelMessage: {
                senderName: app.info?.name,
                text,
                senderTimestamp: Math.floor(Date.now() / 1000),
                channelIdx: channel.channelIdx,
                outgoing: true,
                status: "sending",
            },
            unread: false,
            timestamp: Date.now()
        };
        record.id = await app.db.add("messages", record);
        await this.render();

        let sentTimestamp = null;
        try {
            const result = await app.device.sendChannelTextMessage(channel.channelIdx, text);
            record.channelMessage.status = "sent";
            sentTimestamp = result?.senderTimestamp ?? null;
            if (sentTimestamp != null) record.channelMessage.senderTimestamp = sentTimestamp;
        } catch (e) {
            console.warn("Channels: send failed", e);
            record.channelMessage.status = "failed";
        }
        await app.db.put("messages", record);
        app.dispatchEvent(new CustomEvent("channelmessage", { detail: { key: this.key } }));
        // Count repeaters passing it on
        if (sentTimestamp != null) {
            await app.delivery.trackChannelSend({ recordId: record.id, storeKey: this.key, secret: channel.secret, timestamp: sentTimestamp, text });
        }
    }

    static showKey() {
        const channel = this.channel();
        if (!channel) return;
        const isHashtag = channel.name.startsWith("#");
        alert({
            headline: `Key for ${channel.name}`,
            description: isHashtag
                ? `Anyone can join this hashtag channel by adding ${channel.name}. Its key is ${toHex(channel.secret)}.`
                : `Share this key with the people you want in the channel: ${toHex(channel.secret)}`,
            confirmText: "Done",
        });
    }

    static remove() {
        const channel = this.channel();
        if (!channel || !app.isConnected) return;
        confirm({
            headline: `Remove ${channel.name}?`,
            description: "It will be removed from your radio. Messages already saved in this app are kept, and come back if you add the channel again.",
            confirmText: "Remove",
            cancelText: "Cancel",
            onConfirm: async () => {
                try {
                    await app.device.deleteChannel(channel.channelIdx);
                    await app.loadChannels();
                    snackbar({ message: `Removed ${channel.name}`, closeOnOutsideClick: true });
                    Router.navagateTo("chats");
                } catch (e) {
                    console.warn("Channels: could not remove", e);
                    snackbar({ message: `Couldn't remove ${channel.name}`, closeOnOutsideClick: true });
                }
            }
        });
    }
}
