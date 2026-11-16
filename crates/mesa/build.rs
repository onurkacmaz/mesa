//! Compiles the command schemas into the binary.
//!
//! Nearly 500 of them ship, about seven megabytes in all. In the binary they
//! are read-only data the OS pages in only when touched, and each one is
//! parsed the first time its command is typed — so a session still pays only
//! for the one or two commands it actually uses, and there is no folder next
//! to the executable for a packaging step to forget.

use std::{env, fs, path::Path};

fn main() {
    let dir = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("assets/command-schemas");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".json").map(str::to_string)
        })
        .collect();
    names.sort();
    let mut out = String::from("pub static SCHEMAS: &[(&str, &str)] = &[\n");
    for name in names {
        out.push_str(&format!(
            "    ({name:?}, include_str!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/assets/command-schemas/{name}.json\"))),\n"
        ));
    }
    out.push_str("];\n");
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("schemas.rs"), out).unwrap();
}
