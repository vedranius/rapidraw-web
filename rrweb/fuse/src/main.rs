// rrweb-fuse: folder s klijentskog računala (browser, File System Access API) kao disk na Linux serveru,
// da ga RapidRAW čita kao obične fajlove. Sam ne zna ništa o mreži: svaku FUSE operaciju šalje relayu
// (rrweb/relay/remote.mjs) preko stdin/stdout i čeka odgovor; relay dohvaća bajtove s klijenta i cachea ih.
//   rrweb-fuse <mountpoint>
// Okvir u oba smjera: [u32 LE duljina JSON zaglavlja][u32 LE duljina podataka][zaglavlje][podaci].
// Zaglavlje zahtjeva: {"id", "op", "path", ...}; odgovora: {"id", "err": errno} ili {"id", ...rezultat}.
// Kraj stdina (relay je stao) = unmount i izlaz.
use fuser::{
    Config, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, LockOwner,
    MountOption, OpenFlags, RenameFlags, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty,
    ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite, Request, TimeOrNow, WriteFlags,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TTL: Duration = Duration::from_secs(1);

type Reply = (Value, Vec<u8>);

/// Veza s relayem: zahtjevi idu na stdout, odgovori stižu na stdin (čita ih zasebna nit).
struct Link {
    out: Mutex<std::io::Stdout>,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
}

impl Link {
    fn send(&self, head: &Value, data: &[u8]) -> std::io::Result<()> {
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

    fn call(&self, mut head: Value, data: &[u8]) -> Result<Reply, Errno> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        head["id"] = json!(id);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if self.send(&head, data).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(Errno::EIO);
        }
        let (reply, payload) = rx.recv().map_err(|_| Errno::EIO)?; // relay je stao
        match reply.get("err").and_then(Value::as_i64) {
            Some(e) => Err(Errno::from_i32(e as i32)),
            None => Ok((reply, payload)),
        }
    }

    /// Čita odgovore sa stdina dok relay ne zatvori vezu
    fn read_replies(&self) {
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
}

/// Inode ↔ putanja relativna na korijen dijeljenog foldera ("" = korijen, separator "/")
struct Inodes {
    by_ino: HashMap<u64, String>,
    by_path: HashMap<String, u64>,
    next: u64,
}

impl Inodes {
    fn ino(&mut self, path: &str) -> u64 {
        if let Some(&ino) = self.by_path.get(path) {
            return ino;
        }
        self.next += 1;
        self.by_ino.insert(self.next, path.to_string());
        self.by_path.insert(path.to_string(), self.next);
        self.next
    }

    fn rename(&mut self, from: &str, to: &str) {
        let prefix = format!("{from}/");
        let moved: Vec<(String, u64)> = self.by_path.iter()
            .filter(|(p, _)| *p == from || p.starts_with(&prefix))
            .map(|(p, &i)| (p.clone(), i))
            .collect();
        for (old, ino) in moved {
            let new = format!("{to}{}", &old[from.len()..]);
            self.by_path.remove(&old);
            self.by_path.insert(new.clone(), ino);
            self.by_ino.insert(ino, new);
        }
    }
}

struct Fs {
    link: Arc<Link>,
    inodes: Mutex<Inodes>,
    uid: u32,
    gid: u32,
}

fn child(parent: &str, name: &OsStr) -> String {
    let name = name.to_string_lossy();
    if parent.is_empty() { name.into_owned() } else { format!("{parent}/{name}") }
}

impl Fs {
    fn path(&self, ino: INodeNo) -> Result<String, Errno> {
        self.inodes.lock().unwrap().by_ino.get(&ino.0).cloned().ok_or(Errno::ENOENT)
    }

    /// {"kind": "dir"|"file", "size", "mtime" (ms)} → FileAttr
    fn attr(&self, path: &str, v: &Value) -> FileAttr {
        let dir = v.get("kind").and_then(Value::as_str) == Some("dir");
        let size = v.get("size").and_then(Value::as_u64).unwrap_or(0);
        let mtime = UNIX_EPOCH + Duration::from_millis(v.get("mtime").and_then(Value::as_u64).unwrap_or(0));
        FileAttr {
            ino: INodeNo(self.inodes.lock().unwrap().ino(path)),
            size,
            blocks: size.div_ceil(512),
            atime: mtime,
            mtime,
            ctime: mtime,
            crtime: mtime,
            kind: if dir { FileType::Directory } else { FileType::RegularFile },
            perm: if dir { 0o755 } else { 0o644 },
            nlink: if dir { 2 } else { 1 },
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: 1 << 20,
            flags: 0,
        }
    }

    fn getattr_path(&self, path: &str) -> Result<FileAttr, Errno> {
        let (v, _) = self.link.call(json!({"op": "getattr", "path": path}), &[])?;
        Ok(self.attr(path, &v))
    }
}

impl Filesystem for Fs {
    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        match self.path(parent).and_then(|p| self.getattr_path(&child(&p, name))) {
            Ok(attr) => reply.entry(&TTL, &attr, Generation(0)),
            Err(e) => reply.error(e),
        }
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        match self.path(ino).and_then(|p| self.getattr_path(&p)) {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(e) => reply.error(e),
        }
    }

    fn setattr(
        &self, _req: &Request, ino: INodeNo, _mode: Option<u32>, _uid: Option<u32>, _gid: Option<u32>,
        size: Option<u64>, _atime: Option<TimeOrNow>, _mtime: Option<TimeOrNow>, _ctime: Option<SystemTime>,
        _fh: Option<FileHandle>, _crtime: Option<SystemTime>, _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>, _flags: Option<fuser::BsdFileFlags>, reply: ReplyAttr,
    ) {
        let result = self.path(ino).and_then(|p| {
            if let Some(size) = size {
                self.link.call(json!({"op": "truncate", "path": p, "size": size}), &[])?;
            }
            self.getattr_path(&p)
        });
        match result {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(e) => reply.error(e),
        }
    }

    fn readdir(&self, _req: &Request, ino: INodeNo, _fh: FileHandle, offset: u64, mut reply: ReplyDirectory) {
        let path = match self.path(ino) {
            Ok(p) => p,
            Err(e) => return reply.error(e),
        };
        let entries = match self.link.call(json!({"op": "readdir", "path": path}), &[]) {
            Ok((v, _)) => v.get("entries").and_then(Value::as_array).cloned().unwrap_or_default(),
            Err(e) => return reply.error(e),
        };
        let mut list = vec![(ino.0, FileType::Directory, ".".to_string()), (ino.0, FileType::Directory, "..".to_string())];
        {
            let mut inodes = self.inodes.lock().unwrap();
            for e in &entries {
                let name = e.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                let kind = if e.get("kind").and_then(Value::as_str) == Some("dir") { FileType::Directory } else { FileType::RegularFile };
                let p = if path.is_empty() { name.clone() } else { format!("{path}/{name}") };
                list.push((inodes.ino(&p), kind, name));
            }
        }
        for (i, (ino, kind, name)) in list.into_iter().enumerate().skip(offset as usize) {
            if reply.add(INodeNo(ino), (i + 1) as u64, kind, name) {
                break;
            }
        }
        reply.ok();
    }

    fn open(&self, _req: &Request, _ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        reply.opened(FileHandle(0), FopenFlags::empty());
    }

    fn read(
        &self, _req: &Request, ino: INodeNo, _fh: FileHandle, offset: u64, size: u32, _flags: OpenFlags,
        _lock_owner: Option<LockOwner>, reply: ReplyData,
    ) {
        let result = self.path(ino).and_then(|p| self.link.call(json!({"op": "read", "path": p, "off": offset, "len": size}), &[]));
        match result {
            Ok((_, data)) => reply.data(&data),
            Err(e) => reply.error(e),
        }
    }

    fn write(
        &self, _req: &Request, ino: INodeNo, _fh: FileHandle, offset: u64, data: &[u8], _write_flags: WriteFlags,
        _flags: OpenFlags, _lock_owner: Option<LockOwner>, reply: ReplyWrite,
    ) {
        let result = self.path(ino).and_then(|p| self.link.call(json!({"op": "write", "path": p, "off": offset}), data));
        match result {
            Ok(_) => reply.written(data.len() as u32),
            Err(e) => reply.error(e),
        }
    }

    fn create(
        &self, _req: &Request, parent: INodeNo, name: &OsStr, _mode: u32, _umask: u32, _flags: i32, reply: ReplyCreate,
    ) {
        let result = self.path(parent).and_then(|p| {
            let path = child(&p, name);
            let (v, _) = self.link.call(json!({"op": "create", "path": path}), &[])?;
            Ok(self.attr(&path, &v))
        });
        match result {
            Ok(attr) => reply.created(&TTL, &attr, Generation(0), FileHandle(0), FopenFlags::empty()),
            Err(e) => reply.error(e),
        }
    }

    fn mkdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, _mode: u32, _umask: u32, reply: ReplyEntry) {
        let result = self.path(parent).and_then(|p| {
            let path = child(&p, name);
            let (v, _) = self.link.call(json!({"op": "mkdir", "path": path}), &[])?;
            Ok(self.attr(&path, &v))
        });
        match result {
            Ok(attr) => reply.entry(&TTL, &attr, Generation(0)),
            Err(e) => reply.error(e),
        }
    }

    fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        match self.path(parent).and_then(|p| self.link.call(json!({"op": "unlink", "path": child(&p, name)}), &[])) {
            Ok(_) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        match self.path(parent).and_then(|p| self.link.call(json!({"op": "rmdir", "path": child(&p, name)}), &[])) {
            Ok(_) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn rename(
        &self, _req: &Request, parent: INodeNo, name: &OsStr, newparent: INodeNo, newname: &OsStr, _flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        let result = self.path(parent).and_then(|p| {
            let from = child(&p, name);
            let to = child(&self.path(newparent)?, newname);
            self.link.call(json!({"op": "rename", "from": from, "to": to}), &[])?;
            self.inodes.lock().unwrap().rename(&from, &to);
            Ok(())
        });
        match result {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn flush(&self, _req: &Request, _ino: INodeNo, _fh: FileHandle, _lock_owner: LockOwner, reply: ReplyEmpty) {
        reply.ok();
    }

    // Relay na release šalje izmijenjeni fajl natrag na klijenta
    fn release(
        &self, _req: &Request, ino: INodeNo, _fh: FileHandle, _flags: OpenFlags, _lock_owner: Option<LockOwner>,
        _flush: bool, reply: ReplyEmpty,
    ) {
        match self.path(ino).and_then(|p| self.link.call(json!({"op": "release", "path": p}), &[])) {
            Ok(_) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn fsync(&self, _req: &Request, _ino: INodeNo, _fh: FileHandle, _datasync: bool, reply: ReplyEmpty) {
        reply.ok();
    }

    fn statfs(&self, _req: &Request, _ino: INodeNo, reply: ReplyStatfs) {
        // stvarni prostor je na klijentu; javi dovoljno da programi ne odustanu od pisanja
        reply.statfs(1 << 30, 1 << 29, 1 << 29, 1 << 20, 1 << 19, 4096, 255, 4096);
    }
}

fn main() {
    let Some(mountpoint) = std::env::args().nth(1) else {
        eprintln!("usage: rrweb-fuse <mountpoint>");
        std::process::exit(2);
    };
    let meta = std::fs::metadata(&mountpoint).unwrap_or_else(|e| {
        eprintln!("rrweb-fuse: {mountpoint}: {e}");
        std::process::exit(1);
    });
    let link = Arc::new(Link { out: Mutex::new(std::io::stdout()), next: AtomicU64::new(1), pending: Mutex::new(HashMap::new()) });
    let mut inodes = Inodes { by_ino: HashMap::new(), by_path: HashMap::new(), next: 1 };
    inodes.by_ino.insert(INodeNo::ROOT.0, String::new());
    inodes.by_path.insert(String::new(), INodeNo::ROOT.0);
    let fs = Fs { link: link.clone(), inodes: Mutex::new(inodes), uid: meta.uid(), gid: meta.gid() };

    let mut config = Config::default();
    config.mount_options = vec![
        MountOption::FSName("rrweb".into()),
        MountOption::Subtype("rrweb".into()),
        MountOption::NoAtime,
        MountOption::NoDev,
        MountOption::NoSuid,
    ];
    config.n_threads = Some(8); // operacije čekaju mrežu; ostale ne smiju stati
    let session = fuser::spawn_mount(fs, &mountpoint, &config).unwrap_or_else(|e| {
        eprintln!("rrweb-fuse: mount {mountpoint}: {e}");
        std::process::exit(1);
    });
    let _ = link.send(&json!({"id": 0, "op": "mounted"}), &[]);
    link.read_replies();
    if let Err(e) = session.umount_and_join() {
        eprintln!("rrweb-fuse: unmount: {e}");
    }
}
