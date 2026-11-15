# Murmuration: Devpost submission and demo script

**Tagline:** A band of phones with no network. They agree by singing.

**Try it:** https://murmuration-swarm-4yqs.netlify.app (2+ devices, volume up) · **Virtual room:** https://murmuration-swarm-4yqs.netlify.app/sim.html · **Code:** https://github.com/syn-095/murmuration

**Gallery:** `screenshots/2-language.png` (thumbnail), `1-band.png`, `3-virtual-room.png`, `4-split-by-wall.png`

**Challenges:** Neptune North (Actors work better together) · DurHack Composition · QRT Tagged (Information hidden in plain sight) · Hackathons UK Hackiest Hack · Marshall Wace New Worlds

---

## Elevator pitch
Murmuration turns any phones and laptops into a band whose only connection is sound. Every chime you hear is a data packet in an invented 8-note language. With no server and no conductor, each device independently finds the shared beat, the key and a part nobody else is playing, and cancels its own unknown audio latency by listening to itself. Knock one out and it drifts off alone. Let it hear again and it finds the band by ear: you can *hear* a distributed system heal.

## Inspiration
Starlings in a murmuration and fireflies flashing in sync have no leader. Each one reacts only to its neighbours, and order emerges anyway. We wanted that, but audible: a distributed system you can listen to. The constraint we chose was the hard one: no network at all. If the devices can only talk through the air, then the music has to *be* the protocol.

## What it does
- **Joining:** open the page and tap *Join the swarm*. Your device listens first. The moment it hears a neighbour's song it jumps onto the band's beat, claims a free slot, and works out which part (bass, melody, pads, drums) is missing.
- **Talking:** each device sings a short chime once per cycle, on its own slot's downbeat. The chime carries its slot, part, the key it's playing, a song version, and *who it can hear* (acknowledgements).
- **Genres:** Dream pop, Lo-fi, Disco and Reggae. Tap the genre button and the whole band switches together. What each device plays depends on how many devices there are: alone it's a one-man band; with friends, the parts split up.
- **Agreeing:** the band agrees a key and chord progression by gossip. Every so often someone says "I fancy a change", and two cycles later every device switches key on the same downbeat.
- **Failing:** **Knock me out** makes a device deaf and scrambles its clock and key, so it audibly falls out of the band. It keeps playing on its own. When it can hear again, it stays quiet for a cycle, finds the band and locks back in.
- **Texting by song:** *Sing a message* packs 3 characters (from a 64-symbol alphabet including ♥ ★ ♪) into a chime, using the spare bit as a "this is text" flag. Every device that hears it flashes it and sings it on once, so a message can hop across the swarm with no network at all.
- **Seeing the language:** *Show the language* opens a live spectrogram of the 8 bell notes, with every decoded song boxed note by note and colour-coded by meaning. The Rosetta strip translates the latest song into words ("#3 sang: I play drums, in A minor, I hear #1 #5").
- **Virtual room:** `sim.html` runs the same agent code over a simulated room (clock offsets, 20–270 ms audio latency, the speed of sound, collisions, loss, walls), so you can watch 8 musicians split behind a wall and merge again.

## How we built it
Vanilla JS and the Web Audio API: a static site with no backend and no dependencies.
- **The modem (`modem.js`):**
  - Sending: 8 pure sine tones on C major pentatonic, C7–E8 (2.1–5.3 kHz). A packet is two preamble chords plus 13 data notes, 100 ms each.
  - Encoding: the data notes alternate between two tone sets (2 bits per note), so a room's echo of one note can never be mistaken for the next. 19 bits of payload plus a CRC-7.
  - Receiving: an AudioWorklet forwards raw mic samples, stamped with the audio clock, to a Goertzel filter bank. The preamble onset is located to sample accuracy with a triangle-peak fit.
  - Each note also rings a warm partial two octaves down, which falls *between* the detector's bins. That makes the data sound like a chime in the band's key instead of a beep, at no cost in decoding.
- **The agent (`agent.js`):**
  - Fixed 120 BPM grid, 8 one-bar slots per 16 s cycle.
  - Timing is never sent as data: *when* the preamble starts, plus *which* slot it came from, gives the sender's grid.
  - Beat sync works like fireflies: snaps toward bigger groups, small errors tracked with a gain of 0.3, and corrections slewed so they're inaudible.
  - Key changes use a two-cycle handshake. Roles are a deterministic deal. Slot clashes are found by silent listening turns plus acknowledgement masks.
- **The latency trick:** browsers add 20–250 ms of unknown output plus input latency, which would wreck sync. But every device hears *its own* song through its own mic, which measures its round trip. Comparing a neighbour's arrival with your own arrival (same mic, same input path) cancels the input path. What remains lines up the moments the sound leaves each speaker, which is what listeners hear.
- **Testing:** headless Node tests run the real DSP on synthetic audio (crowd babble, room reverb, collisions), and the real agent code in the simulated room (joins, steady state, split/heal, knock-out, deafness).

## Challenges we ran into
- **Room echo was the real enemy, not noise.** A hall's reverb lasts longer than a note. Alternating tone sets took decoding under heavy reverb from about 30% to 80–90%.
- **Bell-like decaying notes** pushed symbol errors to 70%. The carrier had to be held, so the bell character moved into the "body" partial.
- **iOS Safari plays Web Audio much quieter while the mic is open** (WebKit bugs 218012, 236219 and 311451, still open). We boost and limit on iPhones and use laptops and Android phones as anchors.
- **Echo cancellation must be off.** Otherwise the device deletes its own song, and the latency trick depends on hearing it.
- **Two devices singing in the same slot can never hear each other**: each drowns the other out with its own speaker. We found this with the simulator, and fixed it with silent listening turns and acknowledgement masks.
- **Live testing found one the simulator didn't:** a knocked-out phone came back singing at exactly the moment the laptop sang, so neither could hear the other. A device coming back now listens silently for a cycle first.

## Accomplishments we're proud of
- **The modem:** 100% decode down to −15 dB SNR in crowd babble, with about 2 ms timing error, and zero false packets in 60 s of noise.
- **The swarm:** 4 ms mean audible beat spread across devices with very different, unknown latencies, at 30% packet loss.
- **Recovery:** a knocked-out device re-locks in about 13 s median, without dragging anyone else off the beat.
- **It's music:** it sounds like a band, not a modem.

## What we learned
- Pulse-coupled oscillator sync, gossip consensus, and why "follow the bigger group" heals splits.
- Acoustic channel design: why the band and the echo matter more than the noise.
- Goertzel filter banks.
- Where browsers lie about latency, and how to measure the truth.

## What's next
- Multi-hop "firefly fields", with slots reused out of earshot, for a whole hall of phones.
- Tempo voting.
- A conductor-less piece written for 30 phones.

## Built with
JavaScript · Web Audio API · AudioWorklet · getUserMedia · Canvas · Node.js (tests) · Netlify (static hosting)

**AI disclosure:** the product contains no generative AI. Every chime, chord and decision is produced by hand-written DSP and agent code running on the device. It was built with AI assistance (Claude Code).

---

## Two-minute demo script
**Set-up:**
- Laptop and phone(s) 30–60 cm apart, volume at maximum, no Bluetooth speakers.
- Open `?demo` on the laptop and one phone and join them **before** the judges arrive. Keep a third device (or the phone) ready to join live.
- On the laptop, open *Show the language*. Keep `sim.html` in another tab.

| Time | Do | Say |
|---|---|---|
| 0:00 | Hold up the playing devices | "No Wi-Fi, no server, no conductor. These devices talk to each other only by singing." |
| 0:15 | Point at the laptop spectrogram when a chime lands | "Every chime is a data packet: 26 bits, and the notes are the bits. Here's that song boxed note by note: who sang, which part they're playing, what key, and who they can hear. And the *timing* of the song carries the beat, without a single bit being sent." |
| 0:40 | Join the third device (or knock out and restore) | "A newcomer starts on its own random beat. Listen… it heard a song, jumped onto the beat, and picked a part nobody was playing, all by itself." (LOCKED flash) |
| 1:05 | Press **Knock me out** | "Now we cut its comms. It's deaf, it's lost its place, it's on its own: hear it drift." |
| 1:20 | Press **Let me hear again** | "It listens quietly for a cycle, finds the band, and locks back in. You can hear the network heal." |
| 1:40 | Switch to `sim.html`, add the wall | "Same agent code in a simulated room: split them, they play on separately, take the wall away, they merge. 4 ms beat spread at 30% packet loss, and every device cancels its own latency by listening to itself." |
| 1:55 | — | "Murmuration: a band that agrees by ear." |

**If the hall is too loud:** move the devices closer together (about 20 cm) and do the demo mostly in `sim.html`. Have the backup video ready.
