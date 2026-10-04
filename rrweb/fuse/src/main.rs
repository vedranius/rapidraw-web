// rrweb-fuse: folder s klijentskog računala (browser, File System Access API) kao disk na serveru, da ga
// RapidRAW čita kao obične fajlove. Sam ne zna ništa o mreži: svaku operaciju šalje relayu
// (rrweb/relay/remote.mjs) preko stdin/stdout i čeka odgovor; relay dohvaća bajtove s klijenta i cachea ih.
//   rrweb-fuse <mountpoint>   Linux: FUSE (unix.rs, bez libfuse); Windows: WinFsp (windows.rs)
//   rrweb-fuse --check        izlaz 0 = ovo računalo može montirati (Windows: WinFsp je instaliran)
// Okvir u oba smjera: [u32 LE duljina JSON zaglavlja][u32 LE duljina podataka][zaglavlje][podaci].
// Zaglavlje zahtjeva: {"id", "op", "path", ...}; odgovora: {"id", "err": errno} ili {"id", ...rezultat}.
// Kraj stdina (relay je stao) = unmount i izlaz.
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};

#[cfg(target_os = "linux")]
mod unix;
#[cfg(target_os = "linux")]
use unix as platform;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

pub const EIO: i32 = 5;

pub type Reply = (Value, Vec<u8>);

/// Veza s relayem: zahtjevi idu na stdout, odgovori stižu na stdin (čita ih zasebna nit).
pub struct Link {
    out: Mutex<std::io::Stdout>,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
}

impl Link {
    pub fn send(&self, head: &Value, data: &[u8]) -> std::io::Result<()> {
        let h = serde_json::to_vec(head).expect("json");
        let mut frame = Vec::with_capacity(8 + h.len() + data.len());
        frame.extend_from_slice(&(h.len() as u32).to_le_bytes());
        frame.extend_from_slice(&(data.len() as u32).to_le_bytes());
        frame.extend_from_slice(&h);
        frame.extend_from_slice(data);
        let mut out = self.out.lock().unwrap();
        out.write_all(&frame)?;
        out.flush()
    }

    /// Zahtjev relayu; greška je POSIX errno (relay: ENOENT, EIO, …)
    pub fn call(&self, mut head: Value, data: &[u8]) -> Result<Reply, i32> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        head["id"] = json!(id);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if self.send(&head, data).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(EIO);
        }
        let (reply, payload) = rx.recv().map_err(|_| EIO)?; // relay je stao
        match reply.get("err").and_then(Value::as_i64) {
            Some(e) => Err(e as i32),
            None => Ok((reply, payload)),
        }
    }

    /// Čita odgovore sa stdina dok relay ne zatvori vezu
    pub fn read_replies(&self) {
        let mut input = std::io::stdin().lock();
        let mut len = [0u8; 8];
        while input.read_exact(&mut len).is_ok() {
            let hlen = u32::from_le_bytes(len[0..4].try_into().unwrap()) as usize;
            let dlen = u32::from_le_bytes(len[4..8].try_into().unwrap()) as usize;
            let mut head = vec![0u8; hlen];
            let mut data = vec![0u8; dlen];
            if input.read_exact(&mut head).is_err() || input.read_exact(&mut data).is_err() {
                break;
            }
            let Ok(head) = serde_json::from_slice::<Value>(&head) else { continue };
            let id = head.get("id").and_then(Value::as_u64).unwrap_or(0);
            if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
                let _ = tx.send((head, data));
            }
        }
        self.pending.lock().unwrap().clear(); // čekatelji dobiju EIO
    }

    pub fn mounted(&self) {
        let _ = self.send(&json!({"id": 0, "op": "mounted"}), &[]);
    }
}

fn main() {
    let Some(arg) = std::env::args().nth(1) else {
        eprintln!("usage: rrweb-fuse <mountpoint> | --check");
        std::process::exit(2);
    };
    if arg == "--check" {
        std::process::exit(match platform::check() {
            Ok(()) => 0,
            Err(reason) => {
                eprintln!("{reason}");
                1
            }
        });
    }
    let link = Arc::new(Link { out: Mutex::new(std::io::stdout()), next: AtomicU64::new(1), pending: Mutex::new(HashMap::new()) });
    platform::run(&arg, link);
}
