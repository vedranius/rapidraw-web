pub mod albums;
pub mod culling;
pub mod file_ops;
pub mod folders;
pub mod listing;
pub mod preset_converter;
pub mod presets;
pub mod sidecars;
pub mod tagging;
pub mod thumbnails;

#[cfg(test)]
pub(crate) mod bench {
    /// Appends a row to the Markdown table in RR_BENCH_OUT (the CI benchmark's job summary), if it is set
    pub fn report(row: &str) {
        println!("{row}");
        if let Ok(out) = std::env::var("RR_BENCH_OUT") {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(out)
            {
                let _ = writeln!(f, "{row}");
            }
        }
    }
}
