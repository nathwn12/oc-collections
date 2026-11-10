# Third-party notices

`puppet` itself is MIT-licensed — see [LICENSE](LICENSE). The crates below are the
dependency graph of the server binary (build-time and proc-macro crates included). Each
crate is redistributed under the terms its own manifest declares, and its full licence
text ships with its source.

The versions are the ones locked in `Cargo.lock`; regenerate this list with
`cargo metadata --format-version 1 --locked`.

## Terms that are not plain MIT/Apache-2.0

- `jpeg-encoder` — `(MIT OR Apache-2.0) AND IJG`: the IJG (Independent JPEG Group)
  terms apply to the quantisation tables it carries.
- `unicode-ident` — `(MIT OR Apache-2.0) AND Unicode-3.0`: the Unicode data files carry
  the Unicode licence.
- `miniz_oxide` — `MIT OR Zlib OR Apache-2.0`; `foldhash` and `zlib-rs` — `Zlib`;
  `adler2` — `0BSD OR MIT OR Apache-2.0`; `memchr` — `Unlicense OR MIT`.

## Crates

| Crate | Version | License (as declared) |
|---|---|---|
| `adler2` | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| `base64` | 0.23.1 | MIT OR Apache-2.0 |
| `bitflags` | 2.13.2 | MIT OR Apache-2.0 |
| `cfg-if` | 1.0.5 | MIT OR Apache-2.0 |
| `crc32fast` | 1.5.4 | MIT OR Apache-2.0 |
| `equivalent` | 1.0.3 | Apache-2.0 OR MIT |
| `fdeflate` | 0.3.7 | MIT OR Apache-2.0 |
| `flate2` | 1.1.11 | MIT OR Apache-2.0 |
| `foldhash` | 0.2.0 | Zlib |
| `hashbrown` | 0.17.1 | MIT OR Apache-2.0 |
| `indexmap` | 2.14.2 | Apache-2.0 OR MIT |
| `itoa` | 1.0.19 | MIT OR Apache-2.0 |
| `jpeg-encoder` | 0.7.1 | (MIT OR Apache-2.0) AND IJG |
| `memchr` | 2.8.3 | Unlicense OR MIT |
| `miniz_oxide` | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| `miniz_oxide` | 0.9.1 | MIT OR Zlib OR Apache-2.0 |
| `png` | 0.18.1 | MIT OR Apache-2.0 |
| `proc-macro2` | 1.0.107 | MIT OR Apache-2.0 |
| `quote` | 1.0.47 | MIT OR Apache-2.0 |
| `serde` | 1.0.229 | MIT OR Apache-2.0 |
| `serde_core` | 1.0.229 | MIT OR Apache-2.0 |
| `serde_derive` | 1.0.229 | MIT OR Apache-2.0 |
| `serde_json` | 1.0.154 | MIT OR Apache-2.0 |
| `simd-adler32` | 0.3.10 | MIT |
| `syn` | 2.0.119 | MIT OR Apache-2.0 |
| `syn` | 3.0.10 | MIT OR Apache-2.0 |
| `unicode-ident` | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| `windows` | 0.62.2 | MIT OR Apache-2.0 |
| `windows-collections` | 0.3.2 | MIT OR Apache-2.0 |
| `windows-core` | 0.62.2 | MIT OR Apache-2.0 |
| `windows-future` | 0.3.2 | MIT OR Apache-2.0 |
| `windows-implement` | 0.60.2 | MIT OR Apache-2.0 |
| `windows-interface` | 0.59.3 | MIT OR Apache-2.0 |
| `windows-link` | 0.2.1 | MIT OR Apache-2.0 |
| `windows-numerics` | 0.3.1 | MIT OR Apache-2.0 |
| `windows-result` | 0.4.1 | MIT OR Apache-2.0 |
| `windows-strings` | 0.5.1 | MIT OR Apache-2.0 |
| `windows-sys` | 0.61.2 | MIT OR Apache-2.0 |
| `windows-threading` | 0.2.1 | MIT OR Apache-2.0 |
| `zlib-rs` | 0.6.8 | Zlib |
| `zmij` | 1.0.23 | MIT |
