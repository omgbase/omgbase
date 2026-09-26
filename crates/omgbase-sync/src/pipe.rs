//! An in-memory pipe: a `Write` half that hands byte chunks to a blocking
//! `Read` half over a channel. Lets a test or a conformance runner connect an
//! [`crate::ExternalSource`] to a scripted adapter running on a thread
//! without spawning a process. Dropping the writer is EOF for the reader.

use std::io::{Read, Write};
use std::sync::mpsc::{Receiver, Sender, channel};

/// The writing end.
#[derive(Debug)]
pub struct PipeWriter {
    tx: Sender<Vec<u8>>,
}

/// The reading end (blocks until bytes arrive or the writer is dropped).
#[derive(Debug)]
pub struct PipeReader {
    rx: Receiver<Vec<u8>>,
    pending: Vec<u8>,
    at: usize,
}

/// A connected `(writer, reader)` pair.
#[must_use]
pub fn pipe() -> (PipeWriter, PipeReader) {
    let (tx, rx) = channel();
    (
        PipeWriter { tx },
        PipeReader {
            rx,
            pending: Vec::new(),
            at: 0,
        },
    )
}

impl Write for PipeWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        self.tx
            .send(buf.to_vec())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "reader dropped"))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Read for PipeReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.at >= self.pending.len() {
            match self.rx.recv() {
                Ok(chunk) => {
                    self.pending = chunk;
                    self.at = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.pending.len() - self.at);
        buf[..n].copy_from_slice(&self.pending[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

/// Who speaks a transcript line: the adapter (`In`, written to the engine)
/// or the engine (`Out`, a request the adapter waits for).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    In,
    Out,
}

/// A scripted adapter on a thread (the reference's `fake-adapter.mjs`): it
/// writes every leading `In` line, then for each `Out` entry waits for one
/// request line from the engine (recording it) before playing the `In` lines
/// that follow. It stays alive until the engine closes its end, then returns
/// the request lines it received.
#[derive(Debug)]
pub struct ScriptedAdapter {
    handle: std::thread::JoinHandle<Vec<String>>,
}

impl ScriptedAdapter {
    /// Spawn over a fresh pipe pair; returns the adapter and the engine's
    /// ends (`from_adapter`, `to_adapter`) for [`crate::ExternalSource::connect`].
    #[must_use]
    pub fn spawn(transcript: Vec<(Dir, String)>) -> (Self, PipeReader, PipeWriter) {
        let (to_engine, from_adapter) = pipe();
        let (to_adapter, from_engine) = pipe();
        let handle = std::thread::spawn(move || {
            let mut out = to_engine;
            let mut i = 0;
            let mut received = Vec::new();
            let play = |i: &mut usize, out: &mut PipeWriter| {
                while *i < transcript.len() && transcript[*i].0 == Dir::In {
                    if writeln!(out, "{}", transcript[*i].1).is_err() {
                        return;
                    }
                    *i += 1;
                }
            };
            play(&mut i, &mut out);
            use std::io::BufRead;
            for line in std::io::BufReader::new(from_engine).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                received.push(line);
                if i < transcript.len() && transcript[i].0 == Dir::Out {
                    i += 1;
                }
                play(&mut i, &mut out);
            }
            received
        });
        (Self { handle }, from_adapter, to_adapter)
    }

    /// The request lines the adapter received, once the engine has closed.
    #[must_use]
    pub fn received(self) -> Vec<String> {
        self.handle.join().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;

    #[test]
    fn lines_cross_and_drop_is_eof() {
        let (mut w, r) = pipe();
        let reader = std::thread::spawn(move || {
            let mut lines = Vec::new();
            for line in std::io::BufReader::new(r).lines() {
                lines.push(line.unwrap());
            }
            lines
        });
        w.write_all(b"one\ntw").unwrap();
        w.write_all(b"o\n").unwrap();
        w.flush().unwrap();
        w.write_all(b"three").unwrap();
        drop(w);
        assert_eq!(reader.join().unwrap(), ["one", "two", "three"]);
        let (mut w, r) = pipe();
        drop(r);
        assert!(w.write_all(b"x").is_err());
    }
}
