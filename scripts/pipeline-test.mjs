#!/usr/bin/env node
// Multi-party subtitle pipeline test (no microphone, no video).
//
// Connects several peers, each in a different language, then has them speak by
// streaming a pre-recorded webm/opus file. Verifies the server broadcasts a
// `subtitle_final` with a `translations` map covering every language in the room
// (translated in parallel) so each peer can render its own language.
//
// Usage:
//   node scripts/pipeline-test.mjs <it.webm> [en.webm]
// Env: WS_HOST (default localhost:3001)
//
// Generate samples (macOS):
//   say -v Alice    -o it.aiff "Ciao a tutti, come va oggi?"
//   say -v Samantha -o en.aiff "Hello everyone, how is it going today?"
//   ffmpeg -y -i it.aiff -ac 1 -ar 16000 -c:a libopus -b:a 32k -f webm -live 1 it.webm
//   ffmpeg -y -i en.aiff -ac 1 -ar 16000 -c:a libopus -b:a 32k -f webm -live 1 en.webm

import { readFileSync } from 'node:fs';

const itFile = process.argv[2];
const enFile = process.argv[3];
const WS_HOST = process.env.WS_HOST || 'localhost:3001';
const room = `mp-${Date.now()}`;

if (!itFile) {
  console.error('usage: node scripts/pipeline-test.mjs <it.webm> [en.webm]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Peer {
  constructor(name, lang) {
    this.name = name;
    this.lang = lang;
    this.id = `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
    this.finals = []; // subtitle_final messages received
  }
  connect() {
    const p = new URLSearchParams({ room, lang: this.lang, id: this.id, name: this.name, public: 'true' });
    this.ws = new WebSocket(`ws://${WS_HOST}/ws?${p}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'subtitle_final') this.finals.push(m);
    };
    return new Promise((res, rej) => {
      this.ws.onopen = () => res(this);
      this.ws.onerror = (e) => rej(new Error(`${this.name} ws error: ${e.message || e}`));
    });
  }
  async speak(file) {
    const audio = readFileSync(file);
    this.ws.send(JSON.stringify({ type: 'start' }));
    await sleep(150);
    for (let off = 0; off < audio.length; off += 1024) {
      this.ws.send(audio.subarray(off, off + 1024));
      await sleep(200);
    }
    await sleep(2500);
    this.ws.send(JSON.stringify({ type: 'stop' }));
    await sleep(2500);
  }
}

const run = async () => {
  console.log(`room=${room}`);
  const alice = new Peer('Alice', 'it');
  const bob = new Peer('Bob', 'en');
  const carla = new Peer('Carla', 'es');
  await Promise.all([alice.connect(), bob.connect(), carla.connect()]);
  console.log('connected: Alice(it), Bob(en), Carla(es)\n');

  let pass = true;
  const check = (cond, label) => { console.log(`${cond ? '✅' : '❌'} ${label}`); if (!cond) pass = false; };

  const fromSpeaker = (peer, speakerId) => peer.finals.filter((m) => m.speaker_id === speakerId);
  const heard = (peer, speakerId) =>
    fromSpeaker(peer, speakerId).map((m) => m.translations?.[peer.lang] ?? m.original).join(' ');

  // Round 1: Alice speaks Italian.
  console.log('— Alice speaks Italian —');
  await alice.speak(itFile);
  console.log(`  Alice (it) sees : "${heard(alice, alice.id)}"`);
  console.log(`  Bob   (en) hears: "${heard(bob, alice.id)}"`);
  console.log(`  Carla (es) hears: "${heard(carla, alice.id)}"`);
  check(fromSpeaker(alice, alice.id).length > 0, 'Alice receives her own subtitle (original)');
  check(fromSpeaker(bob, alice.id).every((m) => m.translations?.en), 'Bob gets Alice with an en translation');
  check(fromSpeaker(carla, alice.id).every((m) => m.translations?.es), 'Carla gets Alice with an es translation');

  // Round 2: Bob speaks English (if a sample was provided).
  if (enFile) {
    console.log('\n— Bob speaks English —');
    await bob.speak(enFile);
    console.log(`  Bob   (en) sees : "${heard(bob, bob.id)}"`);
    console.log(`  Alice (it) hears: "${heard(alice, bob.id)}"`);
    console.log(`  Carla (es) hears: "${heard(carla, bob.id)}"`);
    check(fromSpeaker(alice, bob.id).every((m) => m.translations?.it), 'Alice gets Bob with an it translation');
    check(fromSpeaker(carla, bob.id).every((m) => m.translations?.es), 'Carla gets Bob with an es translation');
  }

  console.log(pass ? '\n✅ MULTI-PARTY PASS' : '\n❌ MULTI-PARTY FAIL');
  process.exit(pass ? 0 : 1);
};

run().catch((e) => { console.error(e); process.exit(1); });
