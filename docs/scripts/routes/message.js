import { app } from "../index.js";
import { Helpers } from "../libs/helpers.js";
import { Router } from "../router.js";

export default class Contacts {
    static async init(parameters) {
        console.log(parameters);
        
        const publicKey = Uint8Array.fromHex(parameters.id);
        const contact = await app.device.findContactByPublicKeyPrefix(publicKey);

        document.getElementById("sendButton").addEventListener("click", () => this.handleSend(contact));
        app.addEventListener("message", () => this.renderMessages(contact));

        Router.setTitle(contact.advName);
        this.renderMessages(contact);
    }
    
    static async renderMessages(targeCtontact) {
        const messages = await app.db.getByIndex("messages", "publicKey", targeCtontact.publicKey);
        console.log(messages);

        if (!messages || messages?.length === 0) return;

        const messageTemplate = document.getElementById("messageTemplate");
        const messageList = document.getElementById("messageList");

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
            if (message.message.text && message.message.text.startsWith("VE3:")) {
                const parts = message.message.text.substring(4).split(':');
                const durSec = parts.length >= 4 ? parseInt(parts[3], 36) : '?';

                const voiceDiv = document.createElement('div');
                voiceDiv.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:20px;background:rgba(var(--mdui-color-primary),0.15);cursor:pointer;width:fit-content;';
                voiceDiv.innerHTML = `<mdui-icon name="play_arrow" style="font-size:24px;color:rgb(var(--mdui-color-primary))"></mdui-icon><span style="color:rgb(var(--mdui-color-on-surface))">Voice message (${durSec}s)</span>`;
                
                voiceDiv.addEventListener('click', () => {
                    // Try to replay from cache, or show unavailable
                    const sessions = app.voiceRx.decodedAudio;
                    const sessionId = parseInt(parts[0], 36);
                    const buffer = sessions.get(sessionId);
                    if (buffer) {
                        app.voiceRx.playAudioBuffer(buffer);
                        voiceDiv.querySelector('mdui-icon').setAttribute('name', 'volume_up');
                        setTimeout(() => voiceDiv.querySelector('mdui-icon').setAttribute('name', 'play_arrow'), durSec * 1000);
                    } else {
                        voiceDiv.querySelector('span').textContent = `Voice message (${durSec}s) — expired`;
                    }
                });
                
                messageItem.getElementById("messageContent").replaceChildren(voiceDiv);
            } else {
                messageItem.getElementById("messageContent").innerText = message.message.text;
            }

            newItems.push(messageItem);
        }

        messageList.replaceChildren(...newItems);
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

    static cleanup() {

    }
}
