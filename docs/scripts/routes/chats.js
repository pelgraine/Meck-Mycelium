import { app } from "../index.js";
import { Helpers } from "../libs/helpers.js";
import { Router } from "../router.js";
import { dialog, prompt, alert, snackbar } from "../libs/mdui/mdui.js";
import { channelKey, channelKind, hashtagSecret, randomSecret, fromHex, toHex } from "../libs/channels.js";

// The Chats tab: #voice, then the radio's channels with their last
// message and unread count, and a button to add a channel.
export default class Chats {

    static async init() {
        this._onChange = () => this.render();
        for (const event of ["channels", "channelmessage", "connected", "disconnected"]) {
            app.addEventListener(event, this._onChange);
        }
        document.getElementById("addChannelButton").addEventListener("click", () => this.addChannel());
        await this.render();
    }

    static cleanup() {
        for (const event of ["channels", "channelmessage", "connected", "disconnected"]) {
            app.removeEventListener(event, this._onChange);
        }
    }

    static showNotice(title, text) {
        const notice = document.getElementById("chatsNotice");
        if (!notice) return;
        if (!title) {
            notice.classList.add("hidden");
            return;
        }
        notice.classList.remove("hidden");
        document.getElementById("chatsNoticeTitle").textContent = title;
        document.getElementById("chatsNoticeText").textContent = text;
    }

    static async render() {
        const list = document.getElementById("channelList");
        const template = document.getElementById("channelItemTemplate");
        if (!list || !template) return; // left the page

        if (!app.isConnected) {
            list.replaceChildren();
            this.showNotice("No radio connected", "Connect your radio in Settings to see its channels.");
            return;
        }
        const channels = [...(app.channels || [])].sort((a, b) => a.channelIdx - b.channelIdx);
        if (channels.length === 0) {
            list.replaceChildren();
            this.showNotice("No channels yet", "Tap Add channel to join or create one.");
            return;
        }
        this.showNotice(null);

        const items = [];
        for (const channel of channels) {
            const item = template.content.cloneNode(true);
            const key = channelKey(channel.secret);
            const records = await app.db.getByIndex("messages", "publicKey", key);
            const last = records.length ? records[records.length - 1].channelMessage : null;
            const unread = records.filter(r => r.unread).length;

            item.getElementById("channelAvatar").innerText = Helpers.getLastEmoji(channel.name) ?? (channel.name.replace(/^#/, "")[0] || "#");
            item.getElementById("channelAvatar").style.backgroundColor = Helpers.stringToColour(channel.name);
            item.getElementById("channelName").innerText = channel.name;
            item.getElementById("channelPreview").innerText = last
                ? `${last.outgoing ? "You" : (last.senderName || "Unknown")}: ${last.text}`
                : channelKind(channel);
            const badge = item.getElementById("channelUnread");
            if (unread > 0) {
                badge.textContent = unread > 99 ? "99+" : String(unread);
                badge.classList.remove("hidden");
            }
            item.getElementById("channelItem").addEventListener("click", () => {
                Router.navagateTo("channel", { key: toHex(channel.secret) });
            });
            items.push(item);
        }
        list.replaceChildren(...items);
    }

    // ---- Adding a channel ----

    static addChannel() {
        if (!app.isConnected) {
            snackbar({ message: "Connect your radio first", closeOnOutsideClick: true });
            return;
        }
        dialog({
            headline: "Add channel",
            description: "Hashtag channels are public: anyone who adds the same name can read them. Private channels need their key shared with the people you want in them.",
            actions: [
                { text: "Cancel" },
                { text: "Join private", onClick: () => this.joinPrivate() },
                { text: "New private", onClick: () => this.newPrivate() },
                { text: "Hashtag", onClick: () => this.addHashtag() },
            ]
        });
    }

    static addHashtag() {
        prompt({
            headline: "Hashtag channel",
            description: "The channel's name, for example #sydney.",
            confirmText: "Add",
            cancelText: "Cancel",
            textFieldOptions: { label: "Name", placeholder: "#sydney" },
            validator: (value) => this.checkName(value.startsWith("#") ? value : `#${value}`),
            onConfirm: async (value) => {
                // Name as typed: the key comes from the exact name, so "#Sydney" and "#sydney" differ
                const name = value.trim().startsWith("#") ? value.trim() : `#${value.trim()}`;
                await this.saveChannel(name, await hashtagSecret(name));
            }
        });
    }

    static newPrivate() {
        prompt({
            headline: "New private channel",
            description: "A name for the channel. A new key is made for it, which you then share with the people you want in it.",
            confirmText: "Create",
            cancelText: "Cancel",
            textFieldOptions: { label: "Name" },
            validator: (value) => this.checkName(value),
            onConfirm: async (value) => {
                const secret = randomSecret();
                if (await this.saveChannel(value.trim(), secret)) this.showKey(value.trim(), secret);
            }
        });
    }

    static joinPrivate() {
        prompt({
            headline: "Join private channel",
            description: "The channel's name.",
            confirmText: "Next",
            cancelText: "Cancel",
            textFieldOptions: { label: "Name" },
            validator: (value) => this.checkName(value),
            onConfirm: (name) => {
                prompt({
                    headline: `Key for ${name.trim()}`,
                    description: "The channel's key: 32 letters and numbers (0-9, a-f), from whoever made the channel.",
                    confirmText: "Join",
                    cancelText: "Cancel",
                    textFieldOptions: { label: "Key" },
                    validator: (key) => (fromHex(key)?.length === 16) || "That isn't a 32-character key",
                    onConfirm: async (key) => {
                        await this.saveChannel(name.trim(), fromHex(key));
                    }
                });
            }
        });
    }

    static checkName(value) {
        const name = (value || "").trim();
        if (!name || name === "#") return "Enter a name";
        if (new TextEncoder().encode(name).length > 31) return "That name is too long";
        return true;
    }

    static showKey(name, secret) {
        alert({
            headline: `Key for ${name}`,
            description: `Share this key with the people you want in the channel: ${toHex(secret)}`,
            confirmText: "Done",
        });
    }

    // Writes the channel into the first empty slot on the radio. Returns true if added.
    static async saveChannel(name, secret) {
        const hex = toHex(secret);
        if ((app.channels || []).some(c => toHex(c.secret) === hex)) {
            snackbar({ message: `${name} is already on this radio`, closeOnOutsideClick: true });
            return false;
        }
        const empty = (app.channelScan?.channels || []).find(c => !c.name);
        if (!empty) {
            alert({
                headline: "No free channel slot",
                description: "Remove a channel you don't use, then try again.",
                confirmText: "OK",
            });
            return false;
        }
        try {
            await app.device.setChannel(empty.channelIdx, name, secret);
        } catch (e) {
            console.warn("Channels: could not add", e);
            snackbar({ message: `Couldn't add ${name}`, closeOnOutsideClick: true });
            return false;
        }
        await app.loadChannels();
        snackbar({ message: `Added ${name}`, closeOnOutsideClick: true });
        return true;
    }
}
