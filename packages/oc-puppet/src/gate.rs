//! The no-steal input gate.
//!
//! Owner contract (background-only policy, absolute): the server never
//! moves the owner's pointer, injects keys into their session, steals
//! focus or overwrites their clipboard. The owner may be playing a
//! fullscreen game; puppet works purely in the background or says it
//! cannot.
//!
//! There is NO escalation path and NO injection API anywhere in this
//! module: no `SendInput`, no `SetCursorPos`, no `SetForegroundWindow`,
//! no `BringWindowToTop`, no `mouse_event`. `delivery:"sendinput"` and
//! `allow_foreground:true` are refused with a typed `no_foreground_policy`
//! error, never acted on. `tests/no_steal.rs` pins the absence with a
//! source scan (zero call sites anywhere, this module included).
//!
//! | refusal              | meaning                                  |
//! |----------------------|------------------------------------------|
//! | `no_foreground_policy` | any foreground act: refused, never sent |
//! | `no_cursor_policy`     | any pointer move: refused, never sent   |
//! | `no_clipboard_policy`  | any clipboard write: refused            |
//!
//! Reads (`screenshot`, `list_windows`, `cursor`, `clipboard_get`) stay
//! free.
//!
//! `focus_window`, `window action=focus` and `action=maximize` are refused
//! with `no_foreground_policy`: they exist only to take the foreground or
//! cover a monitor. `clipboard_set` is refused with `no_clipboard_policy`;
//! reads (`clipboard_get`) stay free.
//!
//! `Gate::decide` is the pure policy above that — verb in, delivery or typed
//! refusal out. It is unit-tested against the full matrix, and every refusal
//! happens BEFORE any message or event is produced.

use serde_json::{Map, Value};

/// `delivery:"sendinput"` or `allow_foreground:true` was asked for: the
/// background-only policy forbids every foreground act (SendInput,
/// SetForegroundWindow, focus, maximize) — the owner may be playing a
/// fullscreen game, so puppet works purely in the background or says it
/// cannot. Nothing was sent.
pub const NO_FOREGROUND_POLICY: &str = "no_foreground_policy";
/// A pointer act was asked for (`move`, or a click that needs a real
/// cursor): the background-only policy never moves the owner's pointer.
/// Posted mouse messages to a locked target stay available. Nothing was sent.
pub const NO_CURSOR_POLICY: &str = "no_cursor_policy";
/// `clipboard_set` was asked for: writing would overwrite the owner's
/// shared global clipboard (a side effect outside the target window), so
/// the background-only policy refuses it. `clipboard_get` stays. Nothing
/// was written.
pub const NO_CLIPBOARD_POLICY: &str = "no_clipboard_policy";
pub const BACKGROUND_UNAVAILABLE: &str = "background_unavailable";
/// An element matched, but it has no on-screen rectangle, so there is no
/// pixel to aim at. Typed so a caller can tell it apart from "no such
/// control" and fix it by scrolling the control into view or using invoke.
pub const OFFSCREEN_ELEMENT: &str = "offscreen_element";
pub const TARGET_REQUIRED: &str = "target_required";

/// Which delivery path a verb takes. There is no foreground/input
/// variant: every acting verb is background-only or refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// UIA pattern on a locked target (Invoke/Toggle/Expand/SelectionItem/
    /// Scroll) — no pointer, no foreground, no messages.
    Uia,
    /// `PostMessage` to the locked hwnd (exact client coords for pointer
    /// verbs, key messages for posted keyboard).
    Posted,
    /// Nothing to deliver (wait, clipboard_get, wait_for).
    None,
}

/// Typed gate refusal, rendered as `"<code>: <message>"`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateError {
    pub code: &'static str,
    pub message: String,
}

impl GateError {
    pub fn text(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }

    pub fn to_map(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("ok".to_string(), Value::from(false));
        m.insert("code".to_string(), Value::from(self.code));
        m.insert("error".to_string(), Value::from(self.text()));
        m
    }
}

/// Foreground escalation was asked for (`delivery:"sendinput"` or
/// `allow_foreground:true`): refused under the background-only policy —
/// the owner may be playing a fullscreen game, so puppet works purely in
/// the background or says it cannot.
pub(crate) fn no_foreground_policy(verb: &str) -> GateError {
    GateError {
        code: NO_FOREGROUND_POLICY,
        message: format!(
            "{verb} would take the foreground (SendInput/SetForegroundWindow/focus): refused \
             under the background-only policy — the owner may be playing a fullscreen game, \
             so puppet works purely in the background or says it cannot. Pass a locked target \
             for posted delivery where the verb supports it. Nothing was sent."
        ),
    }
}

pub(crate) fn no_cursor_policy(verb: &str) -> GateError {
    GateError {
        code: NO_CURSOR_POLICY,
        message: format!(
            "{verb} would move the system pointer: refused under the background-only policy \
             — the owner may be playing a fullscreen game, so puppet works purely in the \
             background or says it cannot. Pass a locked target for an exact posted click \
             with no pointer. Nothing was sent."
        ),
    }
}

/// Overwriting the owner's global clipboard is a side effect OUTSIDE the
/// target window (every application shares that clipboard): refused under
/// the background-only policy, no flag can buy it. Reads stay free.
pub(crate) fn no_clipboard_policy(verb: &str) -> GateError {
    GateError {
        code: NO_CLIPBOARD_POLICY,
        message: format!(
            "{verb} would overwrite the owner's shared global clipboard: refused under the \
             background-only policy — the owner may be playing a fullscreen game, so puppet \
             works purely in the background or says it cannot. Nothing was written."
        ),
    }
}

/// UIA text entry (`ValuePattern.SetValue`) can make the provider focus the
/// control: refused under the background-only policy — no flag can buy a
/// focus change. The control selector is named so the caller knows what was
/// left untouched.
pub(crate) fn uia_text_unavailable(element: &str) -> GateError {
    GateError {
        code: BACKGROUND_UNAVAILABLE,
        message: format!(
            "set_value/type on element \"{element}\" may take the \
             foreground (the UIA provider can focus its control): refused under the \
             background-only policy — the owner may be playing a fullscreen game, so puppet \
             works purely in the background or says it cannot. Nothing was written."
        ),
    }
}

fn target_refusal(verb: &str) -> GateError {
    GateError {
        code: TARGET_REQUIRED,
        message: format!(
            "{verb} needs an explicit target window ({{\"hwnd\":..}} or another target field); \
             this server never falls back to the foreground window. Nothing was sent."
        ),
    }
}

fn background_refusal(verb: &str, why: &str) -> GateError {
    GateError {
        code: BACKGROUND_UNAVAILABLE,
        message: format!(
            "{verb} has no background delivery to a locked target: {why}. Nothing was sent."
        ),
    }
}

/// The flags a call carries, and whether it named a target. The flags
/// survive in the schema so old callers get a typed refusal instead of an
/// "unexpected keyword" error — but no flag buys an injection: `decide`
/// never consults them for delivery.
#[derive(Clone, Copy, Debug)]
pub struct Gate {
    pub has_target: bool,
    pub allow_foreground: bool,
    pub allow_cursor: bool,
    /// Retained for schema compatibility; `clipboard_set` is refused whether
    /// or not it is set.
    pub allow_clipboard: bool,
    /// True only for `desktop:"hidden"`: a private desktop the server created
    /// for one launched program. Posted keyboard to the hidden desktop stays
    /// available (no owner session to desync there); the owner's desktop is
    /// posted-to only with a locked target.
    pub private_desktop: bool,
}

impl Gate {
    pub fn new(has_target: bool, allow_foreground: bool, allow_cursor: bool) -> Self {
        Gate {
            has_target,
            allow_foreground,
            allow_cursor,
            allow_clipboard: false,
            private_desktop: false,
        }
    }

    /// Retained for schema compatibility; no flag buys a clipboard write.
    pub fn allow_clipboard(mut self, allow: bool) -> Self {
        self.allow_clipboard = allow;
        self
    }

    /// Mark this call as driving a PRIVATE desktop (the server's own hidden
    /// desktop), where posted keyboard to the launched program stays
    /// available.
    pub fn private_desktop(mut self, private: bool) -> Self {
        self.private_desktop = private;
        self
    }

    /// Decide the delivery path for one action, or refuse before acting.
    /// Background-only: delivery is posted/UIA to a locked target, or a
    /// typed refusal. There is no foreground/input path to unlock.
    ///
    /// `has_coords`: x/y supplied. `has_element`: an element selector
    /// supplied.
    pub fn decide(
        &self,
        verb: &str,
        has_coords: bool,
        has_element: bool,
    ) -> Result<Delivery, GateError> {
        match verb {
            "move" => {
                // A cursor move is not representable as a window message,
                // and the pointer is never moved.
                Err(no_cursor_policy("move"))
            }
            "click" => {
                if has_element {
                    if self.has_target {
                        Ok(Delivery::Uia)
                    } else {
                        Err(target_refusal("click on an element"))
                    }
                } else if has_coords {
                    if self.has_target {
                        Ok(Delivery::Posted)
                    } else {
                        Err(no_cursor_policy("click x/y"))
                    }
                } else if self.has_target {
                    Err(background_refusal(
                        "click",
                        "a posted click needs exact client x/y (or an element)",
                    ))
                } else {
                    Err(no_cursor_policy("click"))
                }
            }
            "down" | "up" => {
                if self.has_target {
                    if has_coords {
                        Ok(Delivery::Posted)
                    } else {
                        Err(background_refusal(
                            verb,
                            "a posted button message needs exact client x/y",
                        ))
                    }
                } else {
                    Err(no_cursor_policy(verb))
                }
            }
            "drag" => {
                if self.has_target {
                    Ok(Delivery::Posted)
                } else {
                    Err(no_cursor_policy("drag"))
                }
            }
            "scroll" => {
                if has_element {
                    if self.has_target {
                        Ok(Delivery::Uia)
                    } else {
                        Err(target_refusal("scroll on an element"))
                    }
                } else if has_coords {
                    if self.has_target {
                        Ok(Delivery::Posted)
                    } else {
                        Err(no_cursor_policy("scroll x/y"))
                    }
                } else if self.has_target {
                    Err(background_refusal(
                        "scroll",
                        "a posted wheel message needs the exact point (x/y)",
                    ))
                } else {
                    Err(no_cursor_policy("scroll"))
                }
            }
            "type" | "key" | "hotkey" => {
                // `type` on an element is UIA ValuePattern.SetValue: the
                // provider may FOCUS the control, so it is refused under the
                // background-only policy (the burst names the control).
                if verb == "type" && has_element {
                    return Err(background_refusal(
                        "type on an element",
                        "UIA ValuePattern.SetValue may focus the control; use the per-action \
                         refusal naming the element",
                    ));
                }
                // Posted keyboard to a locked target (the private hidden
                // desktop keeps its existing posted path); without a target
                // there is nothing to post to and the foreground is never
                // an option.
                if self.has_target {
                    return Ok(Delivery::Posted);
                }
                Err(target_refusal(verb))
            }
            "invoke" => {
                if !self.has_target {
                    return Err(target_refusal(verb));
                }
                // Invoke/toggle/expand are background-safe (no focus change
                // observed or documented).
                Ok(Delivery::Uia)
            }
            "set_value" => {
                if !self.has_target {
                    return Err(target_refusal(verb));
                }
                Err(background_refusal(
                    "set_value",
                    "UIA ValuePattern.SetValue may focus the control",
                ))
            }
            "focus_window" => {
                // Focusing IS taking the foreground: refused, always.
                Err(no_foreground_policy("focus_window"))
            }
            // Writing the clipboard mutates owner-global state that lives
            // outside the target window: refused, no flag buys it. Reads
            // (`clipboard_get`) stay free.
            "clipboard_set" => Err(no_clipboard_policy("clipboard_set")),
            _ => Ok(Delivery::None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(has_target: bool, fg: bool, cur: bool) -> Gate {
        Gate::new(has_target, fg, cur)
    }

    fn code(r: Result<Delivery, GateError>) -> Option<&'static str> {
        r.err().map(|e| e.code)
    }

    #[test]
    fn default_gate_refuses_every_injecting_verb() {
        let gate = g(false, false, false);
        // No target, no flags: every injecting verb is refused, typed.
        // Pointer verbs name the cursor policy; keyboard names the missing
        // target (the foreground is never an option).
        assert_eq!(
            code(gate.decide("move", true, false)),
            Some(NO_CURSOR_POLICY)
        );
        assert_eq!(
            code(gate.decide("move", false, false)),
            Some(NO_CURSOR_POLICY)
        );
        assert_eq!(
            code(gate.decide("click", true, false)),
            Some(NO_CURSOR_POLICY)
        );
        assert_eq!(
            code(gate.decide("click", false, false)),
            Some(NO_CURSOR_POLICY)
        );
        assert_eq!(
            code(gate.decide("down", false, false)),
            Some(NO_CURSOR_POLICY)
        );
        assert_eq!(
            code(gate.decide("up", false, false)),
            Some(NO_CURSOR_POLICY)
        );
        assert_eq!(
            code(gate.decide("drag", false, false)),
            Some(NO_CURSOR_POLICY)
        );
        assert_eq!(
            code(gate.decide("scroll", true, false)),
            Some(NO_CURSOR_POLICY)
        );
        assert_eq!(
            code(gate.decide("scroll", false, false)),
            Some(NO_CURSOR_POLICY)
        );
        assert_eq!(
            code(gate.decide("type", false, false)),
            Some(TARGET_REQUIRED)
        );
        assert_eq!(
            code(gate.decide("key", false, false)),
            Some(TARGET_REQUIRED)
        );
        assert_eq!(
            code(gate.decide("hotkey", false, false)),
            Some(TARGET_REQUIRED)
        );
        assert_eq!(
            code(gate.decide("focus_window", false, false)),
            Some(NO_FOREGROUND_POLICY)
        );
        assert_eq!(
            code(gate.decide("invoke", false, true)),
            Some(TARGET_REQUIRED)
        );
        assert_eq!(
            code(gate.decide("set_value", false, true)),
            Some(TARGET_REQUIRED)
        );
        assert_eq!(
            code(gate.decide("click", false, true)),
            Some(TARGET_REQUIRED)
        );
        assert_eq!(
            code(gate.decide("scroll", false, true)),
            Some(TARGET_REQUIRED)
        );
        // Read-only verbs never need a permit.
        assert_eq!(gate.decide("wait", false, false), Ok(Delivery::None));
        assert_eq!(gate.decide("wait_for", false, false), Ok(Delivery::None));
        assert_eq!(
            gate.decide("clipboard_get", false, false),
            Ok(Delivery::None)
        );
        // Writing the owner's clipboard is refused under the policy, and
        // no flag buys it.
        assert_eq!(
            code(gate.decide("clipboard_set", false, false)),
            Some(NO_CLIPBOARD_POLICY)
        );
    }

    #[test]
    fn clipboard_write_is_always_refused() {
        let e = g(false, false, false)
            .decide("clipboard_set", false, false)
            .unwrap_err();
        assert_eq!(e.code, NO_CLIPBOARD_POLICY);
        assert!(
            e.text().contains("background-only policy"),
            "refusal must name the rule: {}",
            e.text()
        );
        assert!(
            e.text().starts_with(NO_CLIPBOARD_POLICY) && e.text().contains("Nothing was written."),
            "refusal must be typed and state nothing changed: {}",
            e.text()
        );
        // No flag buys clipboard access — not even all three together.
        for gate in [g(false, true, true), g(true, true, true)] {
            assert_eq!(
                code(gate.decide("clipboard_set", false, false)),
                Some(NO_CLIPBOARD_POLICY),
                "no flag authorises a clipboard write"
            );
        }
        // The retained builder changes nothing.
        let allow = g(false, false, false).allow_clipboard(true);
        assert_eq!(
            code(allow.decide("clipboard_set", false, false)),
            Some(NO_CLIPBOARD_POLICY)
        );
        assert_eq!(
            allow.decide("clipboard_get", false, false),
            Ok(Delivery::None)
        );
        assert_eq!(
            code(allow.decide("type", false, false)),
            Some(TARGET_REQUIRED)
        );
        assert_eq!(
            code(allow.decide("move", true, false)),
            Some(NO_CURSOR_POLICY)
        );
    }

    #[test]
    fn flags_buy_nothing_no_foreground_path_exists() {
        // Every flag combination still refuses: there is no escalation path
        // left to unlock. Without a target, keyboard names the missing
        // target and pointer verbs name the cursor policy.
        for gate in [g(false, true, false), g(false, true, true)] {
            assert_eq!(
                code(gate.decide("type", false, false)),
                Some(TARGET_REQUIRED)
            );
            assert_eq!(
                code(gate.decide("key", false, false)),
                Some(TARGET_REQUIRED)
            );
            assert_eq!(
                code(gate.decide("hotkey", false, false)),
                Some(TARGET_REQUIRED)
            );
            assert_eq!(
                code(gate.decide("down", false, false)),
                Some(NO_CURSOR_POLICY)
            );
            assert_eq!(
                code(gate.decide("click", false, false)),
                Some(NO_CURSOR_POLICY)
            );
            assert_eq!(
                code(gate.decide("focus_window", false, false)),
                Some(NO_FOREGROUND_POLICY)
            );
            // ...and flags never authorise a pointer move either.
            assert_eq!(
                code(gate.decide("move", true, false)),
                Some(NO_CURSOR_POLICY)
            );
            assert_eq!(
                code(gate.decide("click", true, false)),
                Some(NO_CURSOR_POLICY)
            );
            assert_eq!(
                code(gate.decide("drag", false, false)),
                Some(NO_CURSOR_POLICY)
            );
            assert_eq!(
                code(gate.decide("scroll", true, false)),
                Some(NO_CURSOR_POLICY)
            );
        }
        // With a target the flags still buy nothing new: posted delivery was
        // already available without them, and the policy verbs keep refusing.
        let gate = g(true, true, true);
        assert_eq!(gate.decide("type", false, false), Ok(Delivery::Posted));
        assert_eq!(gate.decide("key", false, false), Ok(Delivery::Posted));
        assert_eq!(gate.decide("hotkey", false, false), Ok(Delivery::Posted));
        assert_eq!(gate.decide("click", true, false), Ok(Delivery::Posted));
        assert_eq!(gate.decide("drag", false, false), Ok(Delivery::Posted));
        assert_eq!(gate.decide("click", false, true), Ok(Delivery::Uia));
        assert_eq!(
            code(gate.decide("move", true, false)),
            Some(NO_CURSOR_POLICY)
        );
        assert_eq!(
            code(gate.decide("focus_window", false, false)),
            Some(NO_FOREGROUND_POLICY)
        );
        assert_eq!(
            code(gate.decide("clipboard_set", false, false)),
            Some(NO_CLIPBOARD_POLICY)
        );
        assert_eq!(
            code(gate.decide("set_value", false, true)),
            Some(BACKGROUND_UNAVAILABLE)
        );
    }

    #[test]
    fn pointer_verbs_refuse_with_no_cursor_policy() {
        // allow_cursor alone changes nothing: the pointer is never moved.
        let cursor_only = g(false, false, true);
        for (verb, coords) in [
            ("move", true),
            ("click", true),
            ("drag", false),
            ("scroll", true),
        ] {
            assert_eq!(
                code(cursor_only.decide(verb, coords, false)),
                Some(NO_CURSOR_POLICY),
                "{verb} with allow_cursor must still be refused"
            );
        }
        // ...and the keyboard path never opens from the cursor flag.
        assert_eq!(
            code(cursor_only.decide("type", false, false)),
            Some(TARGET_REQUIRED)
        );
        // Both flags: still refused, everywhere.
        let both = g(false, true, true);
        assert_eq!(
            both.decide("move", true, false).unwrap_err().code,
            NO_CURSOR_POLICY
        );
        assert_eq!(
            code(both.decide("click", true, false)),
            Some(NO_CURSOR_POLICY)
        );
        assert_eq!(
            code(both.decide("drag", false, false)),
            Some(NO_CURSOR_POLICY)
        );
        assert_eq!(
            code(both.decide("scroll", true, false)),
            Some(NO_CURSOR_POLICY)
        );
    }

    #[test]
    fn a_target_switches_to_uia_and_posted_delivery_without_flags() {
        let gate = g(true, false, false);
        assert_eq!(gate.decide("click", true, false), Ok(Delivery::Posted));
        assert_eq!(gate.decide("click", false, true), Ok(Delivery::Uia));
        assert_eq!(gate.decide("down", true, false), Ok(Delivery::Posted));
        assert_eq!(gate.decide("up", true, false), Ok(Delivery::Posted));
        // A posted button message needs an exact point.
        let e = gate.decide("down", false, false).unwrap_err();
        assert_eq!(e.code, BACKGROUND_UNAVAILABLE);
        assert_eq!(gate.decide("drag", false, false), Ok(Delivery::Posted));
        assert_eq!(gate.decide("scroll", true, false), Ok(Delivery::Posted));
        assert_eq!(gate.decide("scroll", false, true), Ok(Delivery::Uia));
        // Keyboard posts to the locked target: `type` on an element is UIA
        // SetValue, whose provider may focus the control, so it is refused.
        assert_eq!(
            code(gate.decide("type", false, true)),
            Some(BACKGROUND_UNAVAILABLE)
        );
        for verb in ["type", "key", "hotkey"] {
            assert_eq!(
                gate.decide(verb, false, false),
                Ok(Delivery::Posted),
                "{verb} posts to a locked target"
            );
            // ...but never without one: the foreground is not a fallback.
            let e = g(false, false, false)
                .decide(verb, false, false)
                .unwrap_err();
            assert_eq!(e.code, TARGET_REQUIRED, "{verb}");
        }
        // The private-desktop (hidden) mode keeps its posted path.
        let private = g(true, false, false).private_desktop(true);
        assert_eq!(private.decide("type", false, false), Ok(Delivery::Posted));
        assert_eq!(private.decide("key", false, false), Ok(Delivery::Posted));
        // UIA invoke/toggle/expand/scroll stay background-safe; UIA text
        // entry does not (the provider may focus the control).
        assert_eq!(gate.decide("invoke", false, true), Ok(Delivery::Uia));
        assert_eq!(
            code(gate.decide("set_value", false, true)),
            Some(BACKGROUND_UNAVAILABLE)
        );
        // Verbs with no message equivalent name the reason; a move is never
        // a posted click.
        let e = gate.decide("move", true, false).unwrap_err();
        assert_eq!(e.code, NO_CURSOR_POLICY);
        assert!(e.text().contains("background-only policy"), "{}", e.text());
        let e = gate.decide("click", false, false).unwrap_err();
        assert_eq!(e.code, BACKGROUND_UNAVAILABLE);
        assert!(e.text().contains("needs exact client x/y"), "{}", e.text());
        let e = gate.decide("scroll", false, false).unwrap_err();
        assert_eq!(e.code, BACKGROUND_UNAVAILABLE);
    }

    #[test]
    fn no_permits_no_injection_apis() {
        // The background-only policy holds no permits and no injection API:
        // SendInput/SetCursorPos/SetForegroundWindow/BringWindowToTop have
        // zero call sites anywhere, gate.rs included. mouse_event stays
        // banned outright.
        let gate = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/gate.rs"))
            .expect("gate.rs readable");
        let prod = gate.split("#[cfg(test)]").next().unwrap_or("");
        // Literals are concat!-assembled so the tests/no_steal.rs source
        // scan never sees a live `Name(` call site in this test.
        for sym in [
            concat!("Send", "Input("),
            concat!("Set", "CursorPos("),
            concat!("Set", "ForegroundWindow("),
            concat!("Bring", "WindowToTop("),
            concat!("mouse", "_event("),
            "ForegroundPermit",
            "CursorPermit",
            "ClipboardPermit",
        ] {
            assert!(
                !prod.contains(sym),
                "gate.rs must not mention {sym}: the escalation path is deleted"
            );
        }
    }

    #[test]
    fn refusals_name_the_recovery_in_every_code() {
        for (gate, verb) in [
            (g(false, false, false), "type"),
            (g(false, false, false), "move"),
            (g(true, false, false), "move"),
            (g(false, false, false), "invoke"),
        ] {
            let e = gate.decide(verb, true, false).unwrap_err();
            let t = e.text();
            assert!(
                t.starts_with(e.code),
                "refusal text must start with its code: {t}"
            );
            assert!(
                t.contains("Nothing was sent.") || t.contains("Nothing was written."),
                "refusal must state no input: {t}"
            );
        }
        // The policy refusals name the rule, not a flag to pass.
        for verb in ["focus_window", "clipboard_set", "move"] {
            let e = g(false, false, false)
                .decide(verb, true, false)
                .unwrap_err();
            assert!(
                e.text().contains("background-only policy"),
                "{verb} must name the rule: {}",
                e.text()
            );
            assert!(
                !e.text().contains("allow_foreground:true")
                    && !e.text().contains("allow_cursor:true")
                    && !e.text().contains("allow_clipboard:true"),
                "{verb} must not beg for a flag: {}",
                e.text()
            );
        }
    }
}
