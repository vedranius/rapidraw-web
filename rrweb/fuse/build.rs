// Windows: winfsp-x64.dll se učitava odgođeno (delayload), tek nakon što ga src/windows.rs nađe u WinFsp
// instalaciji; bez toga se rrweb-fuse.exe ne bi ni pokrenuo na računalu bez WinFsp-a (i --check ne bi radio).
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let dll = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
            Ok("aarch64") => "winfsp-a64",
            _ => "winfsp-x64",
        };
        println!("cargo:rustc-link-lib=dylib=delayimp");
        println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}.dll");
    }
}
