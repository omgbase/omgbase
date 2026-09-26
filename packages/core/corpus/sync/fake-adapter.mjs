#!/usr/bin/env node
// The scripted fake adapter for spec/sync `protocol.json` (README §8). Plays a
// transcript: every `in` entry is a line this process writes to stdout (the
// handshake, responses, unsolicited `{"event":"batch"}` lines); every `out`
// entry is one request line it waits for on stdin. Each received line is
// appended to the log file so the runner can compare the engine's requests byte
// for byte with the transcript's `out` lines. Stays alive until stdin closes
// (the engine's `close()`), then exits 0. Plain JS so it can be spawned as-is.
import { appendFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

const transcript = JSON.parse(process.env.OMGBASE_FAKE_ADAPTER_TRANSCRIPT ?? "[]");
const log = process.env.OMGBASE_FAKE_ADAPTER_LOG;
let i = 0;

function emit(line) {
  // Synchronous: a pipe write through process.stdout may be lost at exit.
  writeSync(1, line + "\n");
}

function play() {
  while (i < transcript.length && transcript[i].dir === "in") {
    emit(transcript[i].line);
    i++;
  }
}

play();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  if (log) appendFileSync(log, line + "\n");
  if (i < transcript.length && transcript[i].dir === "out") i++;
  play();
});
rl.on("close", () => process.exit(0));
