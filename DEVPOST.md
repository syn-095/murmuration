# Murmuration: Devpost submission and pitch notes

**Project name:** Murmuration

**Elevator pitch (171/200 characters):**
> A band of phones that talk only through sound. Every chime is data: with no server or conductor they find a shared beat, key and parts by ear, and heal when one drops out.

**Links:**
- Try it: https://murmuration-swarm-4yqs.netlify.app (2+ devices, volume up, tap *Join the swarm*)
- Virtual room: https://murmuration-swarm-4yqs.netlify.app/sim.html
- Code: https://github.com/syn-095/murmuration

**Gallery:** `screenshots/2-language.png` (thumbnail), `1-band.png`, `3-virtual-room.png`, `4-split-by-wall.png`

**Challenges:** Neptune North (Actors work better together) · DurHack Composition · QRT Tagged (Information hidden in plain sight) · Hackathons UK Hackiest Hack · Marshall Wace New Worlds

---

## Inspiration
Starlings in a murmuration and fireflies flashing in sync have no leader. Each one reacts only to its neighbours, and order emerges anyway. We wanted a distributed system you can *listen* to. So we picked the hard constraint: once the page has loaded, the devices never use the network. If they can only talk through the air, the music has to *be* the protocol.

## What it does
- **Joining:** open the page and tap *Join the swarm*. Your device listens. The moment it hears a neighbour's chime it jumps onto the band's beat, claims a free slot, and works out which part (bass, melody, pads, drums) is missing.
- **Talking:** every chime is a data packet in an invented 8-note language. It says which slot the device sings in, its part, the song, and *who it can hear* (acknowledgements). Empty bars are filled with extra "beacon" chimes, always leaving two free for newcomers, so the band talks often and newcomers find it fast.
- **Agreeing:** devices agree on a key and chord progression by gossip. Every so often one says "I fancy a change", and the whole band switches on the same downbeat.
- **Genres:** Dream pop, Lo-fi, Disco and Reggae. Tap the genre button on any device and the whole band counts down and switches together. Each device's part depends on how many devices there are: alone it's a one-man band, two devices split the arrangement, four or more each take one part.
- **Failing gracefully:** *Knock me out* makes a device deaf and scrambles its clock and key, so it audibly falls out of the band, and it plays on alone. When it can hear again, it listens quietly for a cycle, finds the band and locks back in. You can *hear* the network heal.
- **Texting by song:** *Sing a message* hides 3 characters (from a 64-symbol alphabet including ♥ ★ ♪) in a chime. Every device that hears it flashes it and sings it on once, so a message hops across the swarm through the air.
- **Seeing the language:** *Show the language* is a live spectrogram of the 8 bell notes, with every decoded chime boxed note by note and colour-coded by meaning. The Rosetta strip translates each chime into words: "#3 sang: I play drums, in Disco · A minor, I hear #1 #5".
- **Virtual room:** `sim.html` runs the same agent code in a simulated room: clock offsets, 20–270 ms of audio latency, the speed of sound, collisions, packet loss and walls. You can watch 8 musicians split behind a wall and merge again.

## How we built it
Vanilla JavaScript and the Web Audio API: a static site with no backend and no dependencies.
- **The language (`modem.js`):**
  - Notes: 8 pure sine tones on C major pentatonic, C7–E8 (2.1–5.3 kHz), above most crowd noise.
  - Packet: two preamble chords, then 13 data notes. Each note is a 16th note (125 ms at 120 BPM), so chimes sit on the beat grid.
  - Encoding: data notes alternate between two tone sets (2 bits each), so a room's echo of one note is never mistaken for the next. 19 bits of payload plus a CRC-7.
  - Meaning in the order: the preamble's chord order says whether this is a device's own slot or a spare-bar beacon.
  - Receiving: an AudioWorklet stamps raw mic samples with the audio clock, then a Goertzel filter bank finds the preamble onset to sample accuracy.
  - Sounding good: each note also rings a warm partial that *arpeggiates the chord the band is playing*. It falls between the detector's bins, so it costs nothing in decoding, but the data sounds like part of the music.
- **The musician (`agent.js`):**
  - Fixed 120 BPM grid of 8 one-bar slots. Timing is never sent as data: *when* a chime starts, plus *which bar* it belongs to, gives the sender's grid.
  - Firefly-style sync: snap toward bigger groups, track small errors with gain 0.3, and slew corrections so they're inaudible.
  - Key and genre changes use a handshake, so every device switches on the same downbeat.
  - Roles are a deterministic deal. Slot clashes are caught by silent listening turns plus acknowledgement masks.
- **The latency trick:** browsers add 20–250 ms of unknown audio latency, which would wreck sync. But every device hears *its own* chime through its own mic, which measures its round trip. Comparing a neighbour's arrival with your own (same mic, same input path) cancels the input path. What's left lines up the moments sound leaves each speaker, which is what listeners hear.
- **Testing:** headless Node tests run the real DSP on synthetic audio (crowd babble, room reverb, collisions, speaker clipping), and the real agent code in the simulated room (joining, steady state, split/heal, knock-outs, genre changes).

## Challenges we ran into
- **Room echo was the real enemy, not noise.** A hall's reverb outlasts a note. Alternating tone sets took decoding under heavy reverb from about 30% to 80–93%.
- **Bell-like decaying notes pushed errors to 70%.** The data carrier has to be held, so the bell character moved into a separate "body" partial.
- **iOS Safari plays audio much quieter while the mic is open** (WebKit bugs 218012, 236219 and 311451, still open). iPhones get a boost and a limiter; laptops and Android phones make the best anchors.
- **iOS freezes the audio clock behind dialogs.** A phone typing a message came back seconds out of step. Now every device detects a stalled audio clock and catches up by exactly the stall.
- **Two devices in the same slot can never hear each other:** each drowns the other out with its own speaker. Silent listening turns and acknowledgement masks fixed it.
- **Live testing found bugs the simulator didn't,** e.g. a knocked-out phone coming back singing at the exact moment the laptop sang, so neither could hear the other. A returning device now listens silently for a cycle first.

## Accomplishments we're proud of
- **The language:** 100% decoding down to −15 dB SNR in crowd babble, about 1–2 ms timing error, and zero false packets in 60 s of noise.
- **The swarm:** a 4 ms mean audible beat spread across devices with very different, unknown latencies, at 30% packet loss.
- **Joining:** a newcomer locks in a median of 16 s (down from 36 s).
- **Recovery:** a knocked-out device re-locks in a median of 13 s, without dragging anyone else off the beat.
- **It's music:** four genres, arrangements that adapt to band size, and data chimes that harmonise with the chords.

## What we learned
- Pulse-coupled oscillator sync, gossip consensus, and why "follow the bigger group" heals splits.
- Acoustic channel design: why echo and the choice of frequency band matter more than noise.
- Goertzel filter banks, preamble timing, and where browsers lie about latency.

## What's next
- **Acoustic instruments:** classical and jazz with small sampled instruments (piano, strings, upright bass), preloaded once, instead of synthesized voices.
- **More genres:** a wider song field in the packet, so genres no longer have to share 3 bits with sections.
- **Fully offline:** cache the whole app, so a device can even *join* in airplane mode.
- **Firefly fields:** reuse slots out of earshot, so a whole hall of phones becomes one multi-hop band.
- Tempo voting, and a conductor-less piece written for 30 phones.

## Built with
JavaScript · Web Audio API · AudioWorklet · getUserMedia · Canvas · Node.js (tests) · Netlify (static hosting)

**AI disclosure:** the product contains no generative AI. Every chime, chord and decision comes from hand-written DSP and agent code running on the device. It was built with AI assistance (Claude Code).

---

# Pitch notes (for practice, not for Devpost)

## Set-up before the judges arrive
- Devices 30–60 cm apart, volume at maximum, no Bluetooth speakers.
- Join **every** device (tap *Join the swarm*) and let them lock: you'll see "band of N".
- Then switch on **airplane mode** on all of them, Wi-Fi off too. Never switch it on *before* tapping Join: the page fetches one more file when you join.
- On the laptop, open *Show the language*. Keep `sim.html` in another tab.

## Two-minute demo
| Time | Do | Say |
|---|---|---|
| 0:00 | Hold up the playing devices | "These phones are a band, and they only talk to each other through sound. The internet was used once, to download the page: they're all in airplane mode now." |
| 0:15 | Point at the spectrogram when a chime lands | "Every chime is a data packet in a language we invented: 8 notes, 26 bits. Here it's decoded note by note: who sang, which part they play, which song, and who they can hear. And *when* the chime lands carries the beat, without sending a single bit." |
| 0:40 | Press **Knock me out** on a phone | "Now we cut one off. It's deaf, it's lost its place: listen to it drift. But it doesn't stop; it plays on by itself." |
| 1:00 | Press **Let me hear again** | "Give it its ears back. It listens quietly, finds the band, and locks back in. You can hear the network heal." (LOCKED flash) |
| 1:20 | Tap the genre button | "Any device can propose a change. The others hear it, everyone counts down, and the whole band switches on the same downbeat, with no conductor." |
| 1:40 | Switch to `sim.html`, add the wall, then remove it | "Same code in a simulated room: split them and they carry on separately; reunite them and they merge. 4 ms beat spread at 30% packet loss." |
| 1:55 | — | "Murmuration: a band that agrees by ear." |

## One-minute version (if judges are short on time)
1. "Phones that form a band through sound alone: airplane mode on, no server, no conductor." (let them listen)
2. "Every chime is data; here it is decoded." (spectrogram)
3. Knock one out → let it hear again → "it heals itself."
4. "Murmuration: a band that agrees by ear."

## Lines tuned for each challenge
- **Neptune North:** "Every device is an independent actor with a shared goal. Cut its comms and it keeps working alone; reconnect it and it rejoins without a hub."
- **QRT Tagged:** "A physical language for digital data: an 8-note alphabet, a CRC, and timing that carries information on its own. You can even text by song."
- **Composition:** "The data *is* the music: the chimes arpeggiate the chords the band is playing."
- **Hackiest Hack:** "A consensus protocol whose physical layer is phones chiming at each other across a hackathon hall, working around three open WebKit bugs."

## Likely questions
- **"Is it really not using the network?"** "Only to load the page. Put them in airplane mode and watch." (the demo already shows it)
- **"How do they sync, with different audio latencies?"** "Each device hears its own chime and measures its round trip. Comparing a neighbour's arrival with your own, through the same mic, cancels the unknown latency. We get 4 ms spread."
- **"What happens in a noisy room?"** "The chimes sit at 2–5 kHz, above most speech. We decode at −15 dB SNR in simulated crowd noise. In a really loud hall, move the devices closer."
- **"How many devices?"** "8 slots per band today. Spare bars carry extra beacons while the band is small. Multi-hop 'firefly fields' would scale it to a whole hall."
- **"Why does it take a few seconds to join?"** "Each device sings in its own bar of a 16-second cycle, so a newcomer has to hear someone first. The median join is 16 seconds; spare-bar beacons speed it up."
- **"Is there AI in it?"** "No generative AI in the product: it's hand-written signal processing and agent logic. We used Claude Code to help build it."

**If the hall is too loud:** move the devices to about 20 cm apart, and lean on `sim.html` for the split/merge part.
