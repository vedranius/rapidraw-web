use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::library::file_ops::read_file_mapped;

pub struct MemoryBudget {
    total: u64,
    available: Mutex<u64>,
    released: Condvar,
}

/// A counting semaphore for blocking threads: at most `max` holders at once.
pub struct Slots {
    max: usize,
    used: Mutex<usize>,
    released: Condvar,
}

pub struct SlotGuard<'a>(&'a Slots);

impl Slots {
    pub const fn new(max: usize) -> Self {
        Self {
            max,
            used: Mutex::new(0),
            released: Condvar::new(),
        }
    }

    pub fn acquire(&self) -> SlotGuard<'_> {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        while *used >= self.max.max(1) {
            used = self.released.wait(used).unwrap_or_else(|e| e.into_inner());
        }
        *used += 1;
        SlotGuard(self)
    }
}

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        *self.0.used.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        self.0.released.notify_one();
    }
}

pub struct MemoryReservation {
    budget: Arc<MemoryBudget>,
    bytes: u64,
}

impl MemoryBudget {
    pub fn new(total: u64) -> Arc<Self> {
        Arc::new(Self {
            total,
            available: Mutex::new(total),
            released: Condvar::new(),
        })
    }

    pub fn from_total_ram(fraction: f64) -> Arc<Self> {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        // Under a systemd MemoryMax (or a container limit) the cgroup is the real
        // ceiling, not the machine's RAM.
        let total = sys
            .cgroup_limits()
            .map(|limits| limits.total_memory)
            .filter(|&limit| limit > 0)
            .map_or(sys.total_memory(), |limit| limit.min(sys.total_memory()));
        Self::new((total as f64 * fraction) as u64)
    }

    pub fn reserve(
        self: &Arc<Self>,
        bytes: u64,
        cancellation_token: Option<&AtomicBool>,
    ) -> Option<MemoryReservation> {
        let bytes = bytes.min(self.total);
        let mut available = self.available.lock().unwrap_or_else(|e| e.into_inner());
        while *available < bytes {
            if cancellation_token.is_some_and(|token| token.load(Ordering::SeqCst)) {
                return None;
            }
            available = self
                .released
                .wait_timeout(available, Duration::from_millis(200))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        *available -= bytes;
        Some(MemoryReservation {
            budget: Arc::clone(self),
            bytes,
        })
    }
}

impl Drop for MemoryReservation {
    fn drop(&mut self) {
        *self
            .budget
            .available
            .lock()
            .unwrap_or_else(|e| e.into_inner()) += self.bytes;
        self.budget.released.notify_all();
    }
}

pub fn image_pixel_count(path: &Path, is_raw: bool) -> Option<u64> {
    if is_raw {
        return raw_pixel_count(&read_file_mapped(path).ok()?);
    }
    let (width, height) = image::image_dimensions(path).ok()?;
    Some(width as u64 * height as u64)
}

pub fn raw_pixel_count(file_bytes: &[u8]) -> Option<u64> {
    let (width, height) = crate::decode::raw_processing::raw_dimensions(file_bytes)?;
    Some(width as u64 * height as u64)
}
