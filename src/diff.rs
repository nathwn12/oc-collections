//! Pixel-diff tool: turn "looks right" into "only the intended pixels
//! changed" by comparing two captures pixel by pixel.
//!
//! Each side is either a PNG file (`{path:"<png>"}`) or a live capture
//! target (`{target|window, display, region}` with the same selector
//! grammar as `screenshot`, captured side-effect-free at native pixels).
//! Both sides must land on the SAME pixel dimensions: a mismatch is a
//! typed `size_mismatch` naming both sizes, never a silent scale. The
//! per-pixel rule is the port of
//! `Q:\PROJECTS\PERSONAL\gladius\src\visual.rs` (`png_diff`/`DiffOpts`)
//! in `crate::cap` (per-channel delta above `threshold` counts, union
//! bbox, ratio); the returned image marks changed pixels solid red over a
//! dimmed greyscale copy of `base`. Read-only: no activation, no input.

use crate::cap::{decode_png, diff_image, finalize, Img};
use crate::screen::{dispatch_screenshot, ShotArgs};
use base64::Engine as _;
use serde_json::{Map, Value};

pub struct DiffArgs {
    pub base: Value,
    pub next: Value,
    pub threshold: i64,
    pub max_px: Option<i64>,
    pub out: Option<String>,
    pub bbox: bool,
}

/// Decode one `diff` operand to RGB pixels. `{path}` reads a PNG file;
/// anything else is captured through the screenshot path at native
/// pixels (lossless PNG, no grid, no elements) and decoded back, so the
/// window lock, region crop and display routing stay exactly the ones
/// `screenshot` proves.
fn resolve_operand(side: &str, v: &Value) -> Result<Img, String> {
    if let Value::Object(o) = v {
        if let Some(p) = o.get("path") {
            let path = p.as_str().ok_or_else(|| {
                format!("error: bad_diff: {side} path must be a string (got {p})")
            })?;
            let bytes = std::fs::read(path)
                .map_err(|e| format!("error: bad_diff: cannot read {side} {path}: {e}"))?;
            return decode_png(&bytes).map_err(|e| format!("error: bad_diff: {side}: {e}"));
        }
    }
    // Capture target: a bare string is a window selector, an object
    // carries {target|window, display, region} like screenshot.
    let shot = match v {
        Value::String(s) => ShotArgs {
            display: -1,
            region: None,
            window: Some(s.clone()),
            max_px: None,
            fmt: "png".to_string(),
            quality: None,
            grid: false,
            allow_crop_fallback: false,
            elements: false,
            out: None,
            target: None,
        },
        Value::Object(o) => {
            let window = match o.get("window") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(x) => {
                    return Err(format!(
                        "error: bad_diff: {side} window must be a string (got {x})"
                    ));
                }
            };
            let target = match o.get("target") {
                None | Some(Value::Null) => None,
                Some(t @ (Value::Object(_) | Value::String(_))) => Some(t.clone()),
                Some(x) => {
                    return Err(format!(
                        "error: bad_diff: {side} target must be an object or selector string (got {x})"
                    ));
                }
            };
            let display = match o.get("display") {
                None | Some(Value::Null) => -1,
                Some(Value::Number(n)) => n.as_i64().ok_or_else(|| {
                    format!("error: bad_diff: {side} display must be an integer (got {n})")
                })?,
                Some(x) => {
                    return Err(format!(
                        "error: bad_diff: {side} display must be an integer (got {x})"
                    ));
                }
            };
            let region = match o.get("region") {
                None | Some(Value::Null) => None,
                Some(Value::Array(a)) => Some(a.clone()),
                Some(x) => {
                    return Err(format!(
                        "error: bad_diff: {side} region must be [left,top,right,bottom] (got {x})"
                    ));
                }
            };
            ShotArgs {
                display,
                region,
                window,
                max_px: None,
                fmt: "png".to_string(),
                quality: None,
                grid: false,
                allow_crop_fallback: false,
                elements: false,
                out: None,
                target,
            }
        }
        x => {
            return Err(format!(
                "error: bad_diff: {side} must be {{path:\"<png>\"}} or a capture target (got {x})"
            ));
        }
    };
    let reply: Value = serde_json::from_str(&dispatch_screenshot(&shot))
        .map_err(|e| format!("error: bad_diff: {side}: capture reply unparseable: {e}"))?;
    if reply.get("isError") == Some(&Value::from(true)) {
        let detail = reply
            .get("content")
            .and_then(|c| c.as_array())
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join(" | ")
            })
            .unwrap_or_else(|| "capture failed".to_string());
        return Err(format!("error: bad_diff: {side}: {detail}"));
    }
    let b64 = reply
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|blocks| {
            blocks
                .iter()
                .find_map(|b| b.get("data").and_then(|d| d.as_str()))
        })
        .ok_or_else(|| format!("error: bad_diff: {side}: capture returned no image"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("error: bad_diff: {side}: capture bytes are not base64: {e}"))?;
    decode_png(&bytes).map_err(|e| format!("error: bad_diff: {side}: {e}"))
}

fn err_payload(items: Vec<(&str, Value)>) -> String {
    let mut m = Map::new();
    m.insert("ok".to_string(), Value::from(false));
    for (k, v) in items {
        m.insert(k.to_string(), v);
    }
    crate::wrapped_text(&crate::py_dumps(&Value::Object(m)))
}

pub fn dispatch_diff(a: &DiffArgs) -> String {
    if !(0..=255).contains(&a.threshold) {
        return err_payload(vec![(
            "error",
            Value::from(format!(
                "error: bad_diff: threshold must be 0-255 (got {})",
                a.threshold
            )),
        )]);
    }
    let thr = a.threshold as u8;
    let base = match resolve_operand("base", &a.base) {
        Ok(im) => im,
        Err(e) => return err_payload(vec![("error", Value::from(e))]),
    };
    let next = match resolve_operand("next", &a.next) {
        Ok(im) => im,
        Err(e) => return err_payload(vec![("error", Value::from(e))]),
    };
    let d = match crate::cap::pixel_diff(&base, &next, thr) {
        Ok(d) => d,
        Err(e) => {
            // Typed refusal: both sizes named, no silent scale. The images
            // never meet, so there is no diff PNG to write or return.
            return err_payload(vec![
                ("code", Value::from("size_mismatch")),
                ("error", Value::from(e)),
                (
                    "base",
                    Value::from({
                        let mut m = Map::new();
                        m.insert("w".to_string(), Value::from(base.w as i64));
                        m.insert("h".to_string(), Value::from(base.h as i64));
                        m
                    }),
                ),
                (
                    "next",
                    Value::from({
                        let mut m = Map::new();
                        m.insert("w".to_string(), Value::from(next.w as i64));
                        m.insert("h".to_string(), Value::from(next.h as i64));
                        m
                    }),
                ),
            ]);
        }
    };
    let mut payload = Map::new();
    payload.insert("ok".to_string(), Value::from(true));
    payload.insert("changed".to_string(), Value::from(d.changed));
    payload.insert("total".to_string(), Value::from(d.total));
    payload.insert("ratio".to_string(), Value::from(d.ratio));
    payload.insert(
        "bbox".to_string(),
        match (a.bbox, d.bbox) {
            (true, Some(b)) => Value::from(vec![
                Value::from(b[0]),
                Value::from(b[1]),
                Value::from(b[2]),
                Value::from(b[3]),
            ]),
            _ => Value::Null,
        },
    );
    payload.insert("identical".to_string(), Value::from(d.identical));
    let mut base_o = Map::new();
    base_o.insert("w".to_string(), Value::from(base.w as i64));
    base_o.insert("h".to_string(), Value::from(base.h as i64));
    payload.insert("base".to_string(), Value::from(base_o));
    let mut next_o = Map::new();
    next_o.insert("w".to_string(), Value::from(next.w as i64));
    next_o.insert("h".to_string(), Value::from(next.h as i64));
    payload.insert("next".to_string(), Value::from(next_o));
    payload.insert("threshold".to_string(), Value::from(a.threshold));
    if d.identical {
        // No changed pixels, no diff image: an all-dimmed file still lands
        // when `out` is set so the path contract holds on both outcomes.
        if let Some(path) = a.out.as_deref() {
            let flat = Img {
                w: base.w,
                h: base.h,
                px: {
                    let n = base.w as usize * base.h as usize;
                    let mut px = vec![0u8; n * 3];
                    for (i, chunk) in px.chunks_exact_mut(3).enumerate() {
                        let dim = (crate::cap::gray_of(
                            base.px[3 * i],
                            base.px[3 * i + 1],
                            base.px[3 * i + 2],
                        ) as u32
                            * 3
                            / 5) as u8;
                        chunk[0] = dim;
                        chunk[1] = dim;
                        chunk[2] = dim;
                    }
                    px
                },
            };
            let (data, _, _, _, _, _) = match finalize(flat, a.max_px, "png", None, false) {
                Ok(v) => v,
                Err(e) => return err_payload(vec![("error", Value::from(e))]),
            };
            match crate::cap::write_bytes_out(path, &data) {
                Ok(()) => {
                    payload.insert(
                        "diff_out".to_string(),
                        Value::from(crate::cap::out_object(path, data.len(), "png")),
                    );
                }
                Err(e) => return err_payload(vec![("error", Value::from(e))]),
            }
        } else {
            payload.insert("diff_out".to_string(), Value::Null);
        }
        return crate::wrapped_text(&crate::py_dumps(&Value::Object(payload)));
    }
    // Changed: the red-over-dimmed visualization, long-edge clamped for
    // the wire (full-res pixels decided the counts above, never the
    // clamped ones).
    let viz = match diff_image(&base, &next, thr) {
        Ok(im) => im,
        Err(e) => return err_payload(vec![("error", Value::from(e))]),
    };
    let (data, _, _, _, _, _) = match finalize(viz, a.max_px, "png", None, false) {
        Ok(v) => v,
        Err(e) => return err_payload(vec![("error", Value::from(e))]),
    };
    if let Some(path) = a.out.as_deref() {
        match crate::cap::write_bytes_out(path, &data) {
            Ok(()) => {
                payload.insert(
                    "diff_out".to_string(),
                    Value::from(crate::cap::out_object(path, data.len(), "png")),
                );
            }
            Err(e) => return err_payload(vec![("error", Value::from(e))]),
        }
    } else {
        payload.insert("diff_out".to_string(), Value::Null);
    }
    let blocks = vec![
        crate::image_block(
            &base64::engine::general_purpose::STANDARD.encode(&data),
            "image/png",
        ),
        crate::text_block(&crate::py_dumps(&Value::Object(payload.clone()))),
    ];
    crate::screenshot_ok(&blocks, &Value::Object(payload))
}
