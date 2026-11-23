//! The wire contract between the Tauri host and the pinned `agent-desktop` driver:
//! line-delimited JSON on the driver's private stdio, one request per line, one
//! response per line, plus the driver's `ready` announcement on start.
//!
//! This module is the ONE place both sides read the shape from (`agent-desktop.rs`
//! is the other side), so the two cannot drift: the pin constants, the frame
//! types, the reference format and the action schema live here as plain serde
//! types with no host or OS dependency. Pure functions throughout, pinned by the
//! tests at the bottom of this file.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The pinned driver build the host accepts. Any other name, version or protocol
/// is refused at the handshake with both versions in the error.
pub const DRIVER_NAME: &str = "agent-desktop";
pub const DRIVER_VERSION: &str = "1.1.0";
pub const DRIVER_PROTOCOL: u32 = 1;

// ---------------------------------------------------------------- frames

/// A request: host → driver.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReqFrame {
    pub t: String,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub args: Value,
}

/// A response: driver → host (and the shape the host answers the sidecar with).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResFrame {
    pub t: String,
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub result: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A one-way event: driver → host (`ready` on start, later others if needed).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventFrame {
    pub t: String,
    pub name: String,
    #[serde(default)]
    pub payload: Value,
}

/// What the driver announces when it starts; the host checks the pin against it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriverReady {
    pub name: String,
    pub version: String,
    pub protocol: u32,
}

/// The pin check: exactly this name, this version, this protocol — or the reason
/// both sides disagree, so the error names the build that was actually found.
pub fn check_pin(ready: &DriverReady) -> Result<(), String> {
    if ready.name != DRIVER_NAME {
        return Err(format!(
            "the driver announced itself as \"{}\", not \"{}\"",
            ready.name, DRIVER_NAME
        ));
    }
    if ready.version != DRIVER_VERSION || ready.protocol != DRIVER_PROTOCOL {
        return Err(format!(
            "the driver build is not the pinned one: found {} protocol {}, pinned {} protocol {}",
            ready.version, ready.protocol, DRIVER_VERSION, DRIVER_PROTOCOL
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------- windows and nodes

/// One visible top-level window from `listWindows`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriverWindow {
    pub hwnd: i64,
    pub pid: u32,
    pub title: String,
    pub process: String,
    #[serde(rename = "className")]
    pub class_name: String,
}

/// One accessibility node of an observe snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInfo {
    /// Window-scoped, single-observe reference: `e<observeGen>.<index>`.
    #[serde(rename = "ref")]
    pub reference: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(rename = "className", default, skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub offscreen: bool,
    /// x, y, width, height in screen pixels.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rect: Vec<i32>,
    /// The action kinds this element accepts (the closed set of the action schema).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub patterns: Vec<String>,
    /// The element's visible state where the tree shows one: `on`/`off`/
    /// `indeterminate` for toggles, `expanded`/`collapsed` for combos, and
    /// `selected`/`unselected` for list items. The loop's verify rules read
    /// this (a toggle is verified by its state flipping, a select by the
    /// chosen name reporting selected). Absent when the element shows none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

fn default_true() -> bool {
    true
}

/// One window's accessibility tree summary: the fresh snapshot `observe` returns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObserveResult {
    pub window: DriverWindow,
    /// Bumped on every observe of the window session; every earlier ref is stale.
    #[serde(rename = "observeGen")]
    pub observe_gen: u64,
    pub focused: bool,
    pub nodes: Vec<NodeInfo>,
    pub truncated: bool,
}

/// The observe request: one window, an optional node cap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObserveRequest {
    pub hwnd: i64,
    #[serde(default)]
    pub max_nodes: Option<u32>,
}

/// One action. The closed v1 set: the pattern the driver uses is part of the
/// contract, and there is no keyboard or coordinate kind anywhere in it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentAction {
    Click {
        #[serde(rename = "ref")]
        reference: String,
    },
    SetValue {
        #[serde(rename = "ref")]
        reference: String,
        text: String,
    },
    Toggle {
        #[serde(rename = "ref")]
        reference: String,
    },
    Select {
        #[serde(rename = "ref")]
        reference: String,
        value: String,
    },
    Expand {
        #[serde(rename = "ref")]
        reference: String,
    },
    Collapse {
        #[serde(rename = "ref")]
        reference: String,
    },
}

impl AgentAction {
    /// The reference the action targets, whatever kind it is.
    pub fn reference(&self) -> &str {
        match self {
            AgentAction::Click { reference }
            | AgentAction::SetValue { reference, .. }
            | AgentAction::Toggle { reference }
            | AgentAction::Select { reference, .. }
            | AgentAction::Expand { reference }
            | AgentAction::Collapse { reference } => reference,
        }
    }
}

/// The act request: hwnd + one action (the action object carries its own ref).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActRequest {
    pub hwnd: i64,
    pub action: AgentAction,
}

/// Parses `e<gen>.<index>`; None for anything else (never panics).
pub fn parse_ref(reference: &str) -> Option<(u64, usize)> {
    let rest = reference.strip_prefix('e')?;
    let (gen_part, idx) = rest.split_once('.')?;
    let obs_gen: u64 = gen_part.parse().ok()?;
    let idx: usize = idx.parse().ok()?;
    Some((obs_gen, idx))
}

/// Formats a reference for the given observe generation and traversal index.
pub fn format_ref(observe_gen: u64, index: usize) -> String {
    format!("e{observe_gen}.{index}")
}

// ---------------------------------------------------------------- consequential controls

/// The ONE list of controls the agent never presses, toggles or selects (shared
/// with the sidecar's `src/shared/consequential.ts`). The driver checks it at the
/// moment of the action against the element's LIVE name, so a label that changed
/// between the snapshot and the act is still judged.
const CONSEQUENTIAL_JSON: &str = include_str!("../../src/shared/consequentialControls.json");

struct ConsequentialList {
    english: Vec<Vec<String>>,
    arabic: Vec<String>,
    /// The list did not parse: every press, toggle and select is refused.
    broken: bool,
}

fn consequential_list() -> &'static ConsequentialList {
    static LIST: std::sync::OnceLock<ConsequentialList> = std::sync::OnceLock::new();
    LIST.get_or_init(|| {
        // A list that does not parse must fail closed: an empty list would let
        // every press through, so `broken` refuses them all instead.
        let v: Value = serde_json::from_str(CONSEQUENTIAL_JSON).unwrap_or(Value::Null);
        let strings = |k: &str| -> Vec<String> {
            v.get(k)
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        let english: Vec<Vec<String>> =
            strings("english").iter().map(|p| words(p)).filter(|p| !p.is_empty()).collect();
        let broken = english.is_empty();
        ConsequentialList { english, arabic: strings("arabic"), broken }
    })
}

/// Lowercase runs of ASCII letters and digits (the same split as the sidecar's).
fn words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            cur.push(c.to_ascii_lowercase());
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// The longest list entry the name matches, or None.
pub fn consequential_word(name: &str) -> Option<String> {
    let list = consequential_list();
    let w = words(name);
    let mut best: Option<String> = None;
    for p in &list.english {
        if p.len() <= w.len() && w.windows(p.len()).any(|win| win == p.as_slice()) {
            let hit = p.join(" ");
            if best.as_ref().is_none_or(|b| hit.len() > b.len()) {
                best = Some(hit);
            }
        }
    }
    if best.is_some() {
        return best;
    }
    for a in &list.arabic {
        if name.contains(a.as_str()) && best.as_ref().is_none_or(|b| a.len() > b.len()) {
            best = Some(a.clone());
        }
    }
    best
}

/// Why the action is refused as consequential, or None. click and toggle are
/// judged on the element's name (no name: refused), select on the chosen item.
pub fn consequential_reason(action: &AgentAction, live_name: Option<&str>) -> Option<String> {
    let judged = matches!(action, AgentAction::Click { .. } | AgentAction::Toggle { .. } | AgentAction::Select { .. });
    if judged && consequential_list().broken {
        return Some("the driver's list of consequential controls could not be read, so no press is allowed".into());
    }
    match action {
        AgentAction::Click { .. } | AgentAction::Toggle { .. } => {
            let n = live_name.unwrap_or("").trim();
            if n.is_empty() {
                return Some("the control has no name, so what it does cannot be judged; the person presses it".into());
            }
            consequential_word(n).map(|hit| {
                format!("\"{n}\" may send, confirm, delete or pay (\"{hit}\"), which this agent never does; the person presses it")
            })
        }
        AgentAction::Select { value, .. } => {
            let v = value.trim();
            if v.is_empty() {
                return None;
            }
            consequential_word(v).map(|hit| {
                format!("choosing \"{v}\" may send, confirm, delete or pay (\"{hit}\"), which this agent never does; the person chooses it")
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_pin_refuses_every_other_build_with_both_versions_named() {
        let pinned = DriverReady {
            name: DRIVER_NAME.into(),
            version: DRIVER_VERSION.into(),
            protocol: DRIVER_PROTOCOL,
        };
        assert!(check_pin(&pinned).is_ok());
        for bad in [
            DriverReady { name: "other".into(), version: DRIVER_VERSION.into(), protocol: DRIVER_PROTOCOL },
            DriverReady { name: DRIVER_NAME.into(), version: "9.9.9".into(), protocol: DRIVER_PROTOCOL },
            DriverReady { name: DRIVER_NAME.into(), version: DRIVER_VERSION.into(), protocol: 7 },
        ] {
            let err = check_pin(&bad).unwrap_err();
            assert!(err.contains(DRIVER_VERSION) || err.contains(DRIVER_NAME), "error names what was found: {err}");
        }
    }

    #[test]
    fn action_frames_round_trip_the_exact_shapes_the_sidecar_sends() {
        for v in [
            json!({ "kind": "click", "ref": "e3.17" }),
            json!({ "kind": "setValue", "ref": "e3.4", "text": "hello" }),
            json!({ "kind": "toggle", "ref": "e1.2" }),
            json!({ "kind": "select", "ref": "e2.9", "value": "Weekly" }),
            json!({ "kind": "expand", "ref": "e2.1" }),
            json!({ "kind": "collapse", "ref": "e2.1" }),
        ] {
            let a: AgentAction = serde_json::from_value(v.clone()).unwrap();
            assert_eq!(serde_json::to_value(&a).unwrap(), v, "round trip of {v}");
            assert!(!a.reference().is_empty());
        }
        for bad in [
            json!({ "kind": "pressKey", "ref": "e1.1", "key": "Enter" }),
            json!({ "kind": "clickAt", "ref": "e1.1", "x": 10, "y": 10 }),
            json!({ "kind": "click" }),
            json!({ "ref": "e1.1" }),
        ] {
            assert!(serde_json::from_value::<AgentAction>(bad).is_err(), "unknown kinds must be refused");
        }
    }

    #[test]
    fn references_round_trip_and_garbage_is_refused() {
        assert_eq!(parse_ref("e0.0"), Some((0, 0)));
        assert_eq!(parse_ref("e12.340"), Some((12, 340)));
        assert_eq!(parse_ref("e12.340x"), None);
        assert_eq!(parse_ref("12.340"), None);
        assert_eq!(parse_ref("e12"), None);
        assert_eq!(parse_ref(""), None);
        assert_eq!(format_ref(12, 340), "e12.340");
    }

    #[test]
    fn frames_round_trip() {
        let req = json!({ "t": "req", "id": "c1", "method": "observe", "args": { "hwnd": 42, "maxNodes": 300 } });
        let f: ReqFrame = serde_json::from_value(req.clone()).unwrap();
        assert_eq!(f.method, "observe");
        let res = ResFrame { t: "res".into(), id: "c1".into(), ok: true, result: json!({ "observeGen": 1 }), error: None };
        assert_eq!(serde_json::to_value(&res).unwrap()["t"], "res");
        let ev = EventFrame { t: "event".into(), name: "ready".into(), payload: json!({}) };
        assert_eq!(serde_json::to_value(&ev).unwrap()["name"], "ready");
    }

    #[test]
    fn the_observe_result_names_its_generation_the_way_the_sidecar_reads_it() {
        // The sidecar's TypeScript contract reads `observeGen` (src/shared/agent.ts);
        // the live ARM64 pass caught this key arriving as observe_gen once — pinned
        // here so the wire cannot drift again.
        let obs = ObserveResult {
            window: DriverWindow { hwnd: 42, pid: 7, title: "t".into(), process: "p".into(), class_name: "c".into() },
            observe_gen: 4,
            focused: true,
            nodes: vec![],
            truncated: false,
        };
        let v = serde_json::to_value(&obs).unwrap();
        assert_eq!(v["observeGen"], 4);
        assert!(v.get("observe_gen").is_none());
        assert_eq!(v["window"]["className"], "c");
        assert_eq!(v["truncated"], false);
        // and back
        let back: ObserveResult = serde_json::from_value(v).unwrap();
        assert_eq!(back.observe_gen, 4);
    }
    #[test]
    fn consequential_controls_match_the_sidecar_cases() {
        assert!(!consequential_list().broken, "the shared list must parse");
        for name in ["Send", "Send now", "OK", "Confirm", "Yes", "Pay $20", "Place order", "Empty Trash", "Sign out", "إرسال", "حذف", "تأكيد", "موافق"] {
            assert!(consequential_word(name).is_some(), "{name}");
        }
        for name in ["Bold", "Save draft", "Insert", "Sender", "Postpone", "Bookmark", "Okapi", "Cancel", "New message", "Reply"] {
            assert!(consequential_word(name).is_none(), "{name}");
        }
        assert_eq!(consequential_word("Place  ORDER now").as_deref(), Some("place order"));
    }

    #[test]
    fn a_press_on_an_unnamed_or_consequential_control_is_refused_and_expand_is_not() {
        let click = AgentAction::Click { reference: "e1.0".into() };
        assert!(consequential_reason(&click, None).unwrap().contains("no name"));
        assert!(consequential_reason(&click, Some("  ")).is_some());
        assert!(consequential_reason(&click, Some("Send")).is_some());
        assert!(consequential_reason(&click, Some("Bold")).is_none());
        let pick = AgentAction::Select { reference: "e1.0".into(), value: "Delete".into() };
        assert!(consequential_reason(&pick, Some("Actions")).is_some());
        let expand = AgentAction::Expand { reference: "e1.0".into() };
        assert!(consequential_reason(&expand, Some("Send")).is_none());
    }
}

