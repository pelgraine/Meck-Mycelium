# Mycelium
A (soon to be) feature-rich app for messaging on meshcore networks while maintining compatibility with non Mycelium clients.

**Open the app:** https://pelgraine.github.io/Meck-Mycelium/

## Voice messages

Voice messages travel over 2.4 GHz MeshCore. Two kinds of device can send and play them. You can use either:

**a) Meck devices with 2.4 GHz radios: no phone needed**

- Meck-P4 on the LR2021 T-Display P4, and Meck Watch on the SX1280 T-Watch S3, record, encode and play voice messages on the device itself.
- Only these 2.4 GHz builds have voice. Other Meck-P4 and Meck Watch builds don't.

or

**b) Any other 2.4 GHz node: use Meck Mycelium**

- With other nodes, including ones running ordinary (stock) MeshCore firmware, Meck Mycelium does the work on your phone or computer.
- It records your voice, squashes the audio, and hands it to your node to send. When a voice message arrives, it plays it for you.
- Your node doesn't need a microphone or any special firmware.

**They all work together**

- Voice messages sent from Meck Mycelium can be heard on Meck-P4 and Meck Watch, and theirs can be heard in Meck Mycelium.

There are two ways to send one:

- **To the #voice channel.** Everyone who has the #voice channel hears it. It travels by flood, so repeaters with the region voice added pass it along, and you don't need a direct route to anyone. Repeaters without that region don't carry it, so it doesn't go out all over the mesh. This is the main way to use voice.
- **To one person (a voice DM).** Only that person gets it, but your node needs a direct path to them. See "Sending a voice message to one person" below.

### What you need

**A 2.4 GHz node with stock MeshCore companion firmware**

- Any node that runs MeshCore on 2.4 GHz.
- Bluetooth companion firmware, version 1.18.0 or newer. Most people connect over Bluetooth, and it's the only way on an iPhone or iPad. (On a computer or Android device you can use the USB companion firmware and a cable instead, if you prefer.)
- Set to the same 2.4 GHz radio settings as the voice mesh near you. Mycelium can't change radio settings, so set these first with the MeshCore app. If you're not sure what they are, ask your local mesh group.
- Mycelium only sends voice messages from a node on 2.4 GHz. A voice message is many packets, which would crowd a sub-GHz mesh, so on a 915 MHz (or other sub-GHz) node the **microphone** button is greyed out.
- Mycelium reads your node's frequency when it connects. If you change the frequency while connected, disconnect and connect again so Mycelium sees the change.

**Repeaters that carry voice**

- Voice messages are tagged with a region called **voice**. A repeater only passes them on if voice is in its list of regions.
- That has to be true of **every** repeater the message goes through, not just the one nearest you.
- If you run a repeater and want it to carry voice, add the voice region to it.

**A phone or computer with a browser that can talk to your node over Bluetooth**

| Device | Browser to use |
| --- | --- |
| Android phone or tablet | Chrome (Edge and Samsung Internet also work) |
| Windows or Mac | Chrome or Edge |
| iPhone or iPad | The free **Bluefy** app from the App Store (Safari can't use Bluetooth) |
| Linux | Chrome or Edge, but Bluetooth isn't switched on by default there, so a USB cable is easier |

Firefox can't use Bluetooth at all. Firefox 151 or newer can connect with a USB cable.

USB cables work in Chrome and Edge on Windows, Mac and Linux, and in Chrome 148 or newer on Android.

This table is based on MDN's browser support data (checked 13 November 2026). So far, voice messages have only been tried on an iPhone in Bluefy. If something doesn't work in your browser, please let us know.

### Setting up (once)

1. **Open the app** at https://pelgraine.github.io/Meck-Mycelium/ in one of the browsers above.
2. **Connect your node.**
   - Go to the **Settings** tab and tap **Connect Device**.
   - Choose **Ble** (Bluetooth). Only choose **Usb** if your node is plugged into a computer or Android device with a cable.
   - Pick your node from the list. If you're asked for a PIN, enter your node's Bluetooth PIN.
   - The chip at the top right changes to **Connected** once the contacts abd channels sync is complete.
3. **Open the voice channel.** Go to the **Chats** tab and tap **#voice**.
4. **Add the channel if asked.** If the page says #voice isn't on your node, tap **Add #voice to this radio**. You only need to do this once per node.

### Sending a voice message to #voice

1. On the **#voice** page, tap the **microphone** button.
2. The first time, your browser asks to use the microphone. Tap **Allow**.
3. Speak. You can record for up to 12 seconds. The bar shows your voice level, and recording stops by itself at 12 seconds.
4. Tap the **stop** button when you've finished.
5. Choose what to do:
   - **Play** to listen back first,
   - **Send** to send it,
   - **Discard** to throw it away and start again.
6. After you tap **Send**, **keep the page open** until it says **Voice message sent**.
   - The message goes out in small pieces, about 3 seconds apart, so a 12-second message takes about 40 seconds to send.
   - If you close the page or lock your phone part way through, the rest won't be sent.

### Listening to voice messages

- When a voice message arrives on #voice, a pop-up tells you who it's from.
- On the **#voice** page, new messages are marked **new**. Tap one to play it.
- If some pieces of a message got lost on the way, you'll see something like "(3 of 4 packets)". It still plays, with silence where the missing part was.
- Messages are saved in your browser, so you can play them again later.

### Sending a voice message to one person

1. Go to **Contacts** and open the person's chat.
2. Tap the **microphone** button next to the message box.
3. Record, then **Play**, **Send** or **Discard**, the same as above.

This only works if your node has a **direct path** to that person. If it doesn't, you'll see "No direct path". When that happens, use #voice instead.

### If something goes wrong

| What you see | What it means |
| --- | --- |
| **Not connected to a radio** | Connect your node again from the **Settings** tab. |
| **Voice messages need a 2.4 GHz radio** | Your node is on a sub-GHz frequency, such as 915 MHz. Voice messages can only be sent from a node on 2.4 GHz. |
| **Add #voice to this radio first** | Tap **Add #voice to this radio** on the #voice page. |
| **No free channel slot** | Your node's channel list is full. Remove a channel you don't use (for example in the MeshCore app), then add #voice. |
| **Microphone not available** | Your browser isn't allowed to use the microphone. Allow it in your browser or phone settings, then try again. |
| **Too short to keep**, and the level bar stayed empty while you were recording | No sound is reaching Mycelium from the microphone, even though the timer kept counting. On an iPhone or iPad, fully close Bluefy (swipe it away in the app switcher), open it again, and try recording. On other devices, close and reopen your browser. |
| **No direct path to ...** | Your node can't reach that person directly. Use #voice instead. |
| **Sent 3 of 4 packets** | Part of the message didn't go out, usually because the page was closed or the node disconnected. Send it again. |
| **Nobody hears your messages** | Check your node is on the right 2.4 GHz radio settings, and that the repeaters between you carry the voice region. |

## Todo
*Alot of this is dependent on mycelium.js development*
***Basics***
- [x] Radio connection settings
- [ ] Radio configuration settings
- [ ] Remote node configeration
- [ ] Channel messaging
- [x] Direct messaging
- [x] Map view
- [x] Traceroute
- [ ] Setting route

***Fancy stuff***
- [ ] Markdown support
- [ ] GPS Forwarding
- [ ] Live GPS polling
- [ ] Userscripts
- [ ] File and image sharing (Zero hop only *for now*)
- [ ] Codec2 voice messages
- [ ] Message emoji reactions
- [ ] Message replying
- [ ] Message editing
- [ ] Message deleting
- [ ] Profile pictures
- [ ] Multi radio support

## Useful links

### Documentation
- [MDUI Docs](https://www.mdui.org/en/)
- [Meshcore.js](https://github.com/meshcore-dev/meshcore.js)
- [Mycelium.js](https://github.com/WattleFoxxo/mycelium.js)

### Deployments
[github.io main](https://wattlefoxxo.github.io/Mycelium/)
