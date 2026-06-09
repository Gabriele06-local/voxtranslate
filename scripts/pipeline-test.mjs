#!/usr/bin/env node
// Multi-party end-to-end pipeline test (no microphone).
//
// Connects several symmetric participants, each in a different language, then
// has them speak in turn by streaming a pre-recorded webm/opus file. Verifies
// that every other participant receives the utterance translated into THEIR
// language (in parallel), while same-language peers receive the transcript.
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

class Participant {
  constructor(name, lang) {
    this.name = name;
    this.lang = lang;
    this.id = `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
    this.received = []; // { type, from, from_id, text, target_lang, lang }
  }
  connect() {
    const p = new URLSearchParams({ room, lang: this.lang, id: this.id, name: this.name });
    this.ws = new WebSocket(`ws://${WS_HOST}/ws?${p}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'interim') return; // self-feedback, noisy
      this.received.push(m);
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
      await sleep(200); // ~mimic MediaRecorder 250ms live cadence
    }
    await sleep(2500); // let Deepgram finalize the last segment
    this.ws.send(JSON.stringify({ type: 'stop' }));
    await sleep(2500); // allow finals + translations to route
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summarize(p) {
  const transcripts = p.received.filter((m) => m.type === 'transcript');
  const translations = p.received.filter((m) => m.type === 'translation');
  return { transcripts, translations };
}

const run = async () => {
  console.log(`room=${room}`);
  const alice = new Participant('Alice', 'it');
  const bob = new Participant('Bob', 'en');
  const carla = new Participant('Carla', 'es');
  await Promise.all([alice.connect(), bob.connect(), carla.connect()]);
  console.log('connected: Alice(it), Bob(en), Carla(es)\n');

  let pass = true;
  const check = (cond, label) => {
    console.log(`${cond ? '✅' : '❌'} ${label}`);
    if (!cond) pass = false;
  };

  // ---- Round 1: Alice speaks Italian ----
  console.log('— Alice speaks Italian —');
  await alice.speak(itFile);
  const aliceSays = summarize(alice).transcripts.map((m) => m.text).join(' ');
  const bobGetsFromAlice = summarize(bob).translations.filter((m) => m.from === 'Alice');
  const carlaGetsFromAlice = summarize(carla).translations.filter((m) => m.from === 'Alice');
  console.log(`  Alice transcript : "${aliceSays}"`);
  console.log(`  Bob   (en) hears : "${bobGetsFromAlice.map((m) => m.translated).join(' ')}"`);
  console.log(`  Carla (es) hears : "${carlaGetsFromAlice.map((m) => m.translated).join(' ')}"`);
  check(aliceSays.length > 0, 'Alice receives her own transcript');
  check(bobGetsFromAlice.length > 0 && bobGetsFromAlice.every((m) => m.target_lang === 'en'),
    'Bob receives Alice translated to en');
  check(carlaGetsFromAlice.length > 0 && carlaGetsFromAlice.every((m) => m.target_lang === 'es'),
    'Carla receives Alice translated to es');

  // ---- Round 2: Bob speaks English (if a sample was provided) ----
  if (enFile) {
    console.log('\n— Bob speaks English —');
    await bob.speak(enFile);
    const bobSays = summarize(bob).transcripts.map((m) => m.text).join(' ');
    const aliceGetsFromBob = summarize(alice).translations.filter((m) => m.from === 'Bob');
    const carlaGetsFromBob = summarize(carla).translations.filter((m) => m.from === 'Bob');
    console.log(`  Bob transcript   : "${bobSays}"`);
    console.log(`  Alice (it) hears : "${aliceGetsFromBob.map((m) => m.translated).join(' ')}"`);
    console.log(`  Carla (es) hears : "${carlaGetsFromBob.map((m) => m.translated).join(' ')}"`);
    check(bobSays.length > 0, 'Bob receives his own transcript');
    check(aliceGetsFromBob.length > 0 && aliceGetsFromBob.every((m) => m.target_lang === 'it'),
      'Alice receives Bob translated to it');
    check(carlaGetsFromBob.length > 0 && carlaGetsFromBob.every((m) => m.target_lang === 'es'),
      'Carla receives Bob translated to es');
  }

  console.log(pass ? '\n✅ MULTI-PARTY PASS' : '\n❌ MULTI-PARTY FAIL');
  process.exit(pass ? 0 : 1);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
