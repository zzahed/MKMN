//! `agent-desktop`: the pinned native driver behind MKMN's Computer Use v1.
//!
//! A small Windows process the Tauri host spawns on demand (private stdio,
//! CREATE_NO_WINDOW, app job object). It reads line-delimited JSON requests from
//! stdin and writes one response per line to stdout (the contract in
//! `src/agent_wire.rs`), and it does exactly three things to the desktop:
//!
//!   - `listWindows` — the visible top-level windows the person may grant;
//!   - `observe`    — one fresh UI Automation snapshot of ONE window (the grant
//!     was validated by the host before this is ever called);
//!   - `act`        — one accessibility action (Invoke / Value / Toggle /
//!     SelectionItem / ExpandCollapse) on a reference from the
//!     window's LATEST observe.
//!
//! There is deliberately no keyboard path, no coordinate/mouse path and no
//! window-management method: v1 is accessibility-first, and the closed action
//! set is what makes "prepare an unsent draft" the designed success case.
//! Everything the driver does is window-scoped; it knows nothing about grants —
//! the host refuses any hwnd that is not the granted one before a call lands.

use std::collections::HashMap;
use std::io::{BufRead, Write};

use serde_json::{json, Value};
// The shared wire contract, compiled straight into this binary (a bin target
// cannot import the lib crate's modules without linking all of the host).
#[path = "../agent_wire.rs"]
#[allow(dead_code)] // the host's half of the contract (frames, pin) the driver itself never calls
mod agent_wire;

use windows::core::{BOOL, BSTR, Interface, PWSTR, Result as WResult};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationExpandCollapsePattern,
    IUIAutomationInvokePattern, IUIAutomationSelectionItemPattern, IUIAutomationTextPattern,
    IUIAutomationTogglePattern, IUIAutomationTreeWalker, IUIAutomationValuePattern,
    UIA_CONTROLTYPE_ID, UIA_PATTERN_ID, UIA_ButtonControlTypeId, UIA_CheckBoxControlTypeId,
    UIA_ComboBoxControlTypeId, UIA_DocumentControlTypeId, UIA_EditControlTypeId,
    UIA_ExpandCollapsePatternId, UIA_HyperlinkControlTypeId, UIA_InvokePatternId,
    UIA_ListItemControlTypeId, UIA_MenuItemControlTypeId, UIA_RadioButtonControlTypeId,
    UIA_SelectionItemPatternId, UIA_TabItemControlTypeId, UIA_TextPatternId,
    UIA_TogglePatternId, UIA_TreeItemControlTypeId, UIA_ValuePatternId,
    ExpandCollapseState_Collapsed, ExpandCollapseState_Expanded, ToggleState_Off,
    ToggleState_On,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
    GetWindowLongPtrW, GetWindowThreadProcessId, IsWindow, IsWindowVisible, GWL_EXSTYLE,
    WS_EX_TOOLWINDOW,
};

const NAME_CAP: usize = 160;
/// A field's value rides the observe snapshot WHOLE up to this bound (a plain
/// prefix cut, no ellipsis marker): the loop's verify reads the value back and
/// compares it with what a setValue wrote. A display cap with an ellipsis made
/// every long write fail verify (the live 8 B rewrite died "Could not verify"
/// on a ~200-character field). 8192 bounds the wire; a longer field still
/// verifies honestly unequal.
const VALUE_CAP: usize = 8192;
/// An Edit/Document that holds its text behind TextPattern ONLY (Word's canvas:
/// it exposes no Value pattern) still shows its text in the observe, read-only
/// and tightly capped. A whole document in the tree would crowd the model's
/// context window and squeeze the completion budget toward nothing — the very
/// first-step failure class this cap exists to prevent. The cut is an honest
/// prefix (cap_plain), never a decorated one.
const TEXT_READ_CAP: usize = 1024;
const DEFAULT_MAX_NODES: u32 = 300;
const MAX_DEPTH: u32 = 14;

/// One window session: the traversal generation and the elements the last
/// observe handed out references for. A reference is only ever valid against
/// the generation it was produced in — the "fresh window-scoped reference"
/// rule of the design.
struct Session {
    obs_gen: u64,
    nodes: Vec<IUIAutomationElement>,
}

#[derive(Default)]
struct Driver {
    sessions: HashMap<i64, Session>,
    automation: Option<IUIAutomation>,
    walker: Option<IUIAutomationTreeWalker>,
}

/// An error with a short code the loop can react to (`staleRef`, `windowGone`,
/// `noPattern`, …) and a human message. Never a bare string: the sidecar's
/// recovery and the host's logs read the code.
struct DriverError(String, String);

fn err(code: &str, message: impl Into<String>) -> DriverError {
    DriverError(code.to_string(), message.into())
}

fn emit(v: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn main() {
    // All COM on this one thread: requests are answered sequentially anyway.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let mut driver = Driver::default();
    emit(&json!({
        "t": "event",
        "name": "ready",
        "payload": { "name": agent_wire::DRIVER_NAME, "version": agent_wire::DRIVER_VERSION, "protocol": agent_wire::DRIVER_PROTOCOL }
    }));
    let stdin = std::io::stdin();
    let mut line = String::new();
    loop {
        line.clear();
        let n = match stdin.lock().read_line(&mut line) {
            Ok(n) => n,
            Err(_) => break,
        };
        if n == 0 {
            break; // stdin closed: the host is gone; exit quietly.
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<agent_wire::ReqFrame>(trimmed) else {
            eprintln!("[agent-desktop] unparseable line, skipped");
            continue;
        };
        let result = driver.handle(&frame.method, &frame.args);
        let res = match result {
            Ok(v) => agent_wire::ResFrame {
                t: "res".into(),
                id: frame.id.clone(),
                ok: true,
                result: v,
                error: None,
            },
            Err(e) => agent_wire::ResFrame {
                t: "res".into(),
                id: frame.id.clone(),
                ok: false,
                result: Value::Null,
                error: Some(format!("{}: {}", e.0, e.1)),
            },
        };
        emit(&serde_json::to_value(&res).unwrap_or(Value::Null));
    }
}

impl Driver {
    fn automation(&mut self) -> WResult<(&IUIAutomation, IUIAutomationTreeWalker)> {
        if self.automation.is_none() {
            unsafe {
                let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)?;
                let walker = automation.ControlViewWalker()?;
                self.automation = Some(automation);
                self.walker = Some(walker);
            }
        }
        Ok((
            self.automation.as_ref().unwrap(),
            self.walker.clone().ok_or_else(windows::core::Error::empty)?,
        ))
    }

    fn handle(&mut self, method: &str, args: &Value) -> Result<Value, DriverError> {
        match method {
            "ping" => Ok(json!({ "ok": true })),
            "listWindows" => self.list_windows(),
            "observe" => {
                let req: agent_wire::ObserveRequest = serde_json::from_value(args.clone())
                    .map_err(|e| err("badRequest", e.to_string()))?;
                self.observe(req)
            }
            "act" => {
                let req: agent_wire::ActRequest = serde_json::from_value(args.clone())
                    .map_err(|e| err("badRequest", e.to_string()))?;
                self.act(req)
            }
            other => Err(err(
                "unknownMethod",
                format!("the driver does not offer \"{other}\""),
            )),
        }
    }

    fn list_windows(&mut self) -> Result<Value, DriverError> {
        let _ = self.automation().map_err(|e| err("uia", e.to_string()))?;
        let mut hwnds: Vec<isize> = Vec::new();
        unsafe {
            EnumWindows(Some(enum_proc), LPARAM(&mut hwnds as *mut _ as isize))
                .map_err(|e| err("enumFailed", e.to_string()))?;
        }
        let mut windows = Vec::new();
        for raw in hwnds {
            let hwnd = HWND(raw as _);
            if !is_listable(hwnd) {
                continue;
            }
            let title = window_text(hwnd);
            if title.trim().is_empty() {
                continue;
            }
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            windows.push(agent_wire::DriverWindow {
                hwnd: raw as i64,
                pid,
                title: cap(&title, 120),
                process: process_image(pid),
                class_name: class_name_of(hwnd),
            });
        }
        Ok(serde_json::to_value(windows).unwrap_or(json!([])))
    }

    fn observe(&mut self, req: agent_wire::ObserveRequest) -> Result<Value, DriverError> {
        let hwnd = HWND(req.hwnd as _);
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return Err(err("windowGone", "the window is gone"));
        }
        let (automation, walker) = self.automation().map_err(|e| err("uia", e.to_string()))?;
        let root = unsafe { automation.ElementFromHandle(hwnd) }.map_err(|e| {
            err("windowGone", format!("no accessibility element for the window: {e}"))
        })?;
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        let window = agent_wire::DriverWindow {
            hwnd: req.hwnd,
            pid,
            title: cap(&window_text(hwnd), 120),
            process: process_image(pid),
            class_name: class_name_of(hwnd),
        };
        let focused = unsafe { GetForegroundWindow() } == hwnd;

        // A fresh generation for THIS observe; every earlier ref of the window
        // dies here. The elements of the new snapshot replace the old ones.
        let session = self
            .sessions
            .entry(req.hwnd)
            .or_insert(Session { obs_gen: 0, nodes: Vec::new() });
        session.obs_gen += 1;
        session.nodes.clear();
        let obs_gen = session.obs_gen;
        let mut nodes: Vec<agent_wire::NodeInfo> = Vec::new();
        let max = req.max_nodes.unwrap_or(DEFAULT_MAX_NODES).max(1) as usize;
        let truncated = walk(&walker, &root, 0, obs_gen, &mut session.nodes, &mut nodes, max);

        serde_json::to_value(agent_wire::ObserveResult {
            window,
            observe_gen: obs_gen,
            focused,
            truncated,
            nodes,
        })
        .map_err(|e| err("serialize", e.to_string()))
    }

    fn act(&mut self, req: agent_wire::ActRequest) -> Result<Value, DriverError> {
        let hwnd = HWND(req.hwnd as _);
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return Err(err("windowGone", "the window is gone"));
        }
        let walker = self.walker.clone().ok_or_else(|| err("uia", "the driver has no walker yet"))?;
        let (obs_gen, idx) = agent_wire::parse_ref(req.action.reference()).ok_or_else(|| {
            err(
                "badRef",
                format!("the reference \"{}\" is not a driver reference", req.action.reference()),
            )
        })?;
        let session = self
            .sessions
            .get(&req.hwnd)
            .ok_or_else(|| err("staleRef", "no observe session for this window yet"))?;
        if obs_gen != session.obs_gen {
            return Err(err(
                "staleRef",
                format!(
                    "the reference is from observe {obs_gen}, but the window's latest observe is {}",
                    session.obs_gen
                ),
            ));
        }
        let element = session
            .nodes
            .get(idx)
            .ok_or_else(|| {
                err(
                    "staleRef",
                    format!("the reference \"{}\" is outside the latest observe", req.action.reference()),
                )
            })?
            .clone();
        perform(&walker, &element, &req.action)
    }
}

/// Depth-first over the control view, capped by depth and count. Returns whether
/// the cap cut the traversal short. Each visited element goes to BOTH lists at
/// the same index: the element the driver keeps for `act`, and the record the
/// model reads.
fn walk(
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    depth: u32,
    obs_gen: u64,
    elements: &mut Vec<IUIAutomationElement>,
    nodes: &mut Vec<agent_wire::NodeInfo>,
    max: usize,
) -> bool {
    if nodes.len() >= max || depth > MAX_DEPTH {
        return nodes.len() >= max;
    }
    let (role, control_type) = describe(element);
    let name = property_name(element);
    let class = property_class(element);
    let enabled = property_enabled(element);
    let offscreen = property_offscreen(element);
    let rect = property_rect(element);
    let value = property_value(element, control_type);
    let state = property_state(element, control_type);
    // Patterns are only probed for elements an action could actually take:
    // enabled and on-screen. A disabled control offers nothing to press.
    let patterns = if enabled && !offscreen {
        pattern_candidates(control_type, element)
    } else {
        Vec::new()
    };
    elements.push(element.clone());
    nodes.push(agent_wire::NodeInfo {
        reference: agent_wire::format_ref(obs_gen, elements.len() - 1),
        role,
        name: name.map(|n| cap(&n, NAME_CAP)),
        value: value.map(|v| cap_plain(&v, VALUE_CAP)),
        class_name: class.map(|c| cap(&c, 80)),
        enabled,
        offscreen,
        rect,
        patterns,
        state,
    });
    let mut truncated = false;
    let mut child = unsafe { walker.GetFirstChildElement(element) }.ok();
    while let Some(c) = child {
        if nodes.len() >= max {
            return true;
        }
        if walk(walker, &c, depth + 1, obs_gen, elements, nodes, max) {
            truncated = true;
            break;
        }
        child = unsafe { walker.GetNextSiblingElement(&c) }.ok();
    }
    truncated
}

fn describe(element: &IUIAutomationElement) -> (String, UIA_CONTROLTYPE_ID) {
    let ct = unsafe { element.CurrentControlType() }.unwrap_or(UIA_CONTROLTYPE_ID(0));
    let role = match ct {
        x if x == UIA_ButtonControlTypeId => "Button",
        x if x == UIA_CheckBoxControlTypeId => "CheckBox",
        x if x == UIA_RadioButtonControlTypeId => "RadioButton",
        x if x == UIA_ComboBoxControlTypeId => "ComboBox",
        x if x == UIA_EditControlTypeId => "Edit",
        x if x == UIA_DocumentControlTypeId => "Document",
        x if x == UIA_ListItemControlTypeId => "ListItem",
        x if x == UIA_TabItemControlTypeId => "TabItem",
        x if x == UIA_TreeItemControlTypeId => "TreeItem",
        x if x == UIA_MenuItemControlTypeId => "MenuItem",
        x if x == UIA_HyperlinkControlTypeId => "Hyperlink",
        _ => "Other",
    };
    (role.to_string(), ct)
}

/// The action kinds this control type plausibly takes, probed for real
/// availability. At most five COM pattern lookups per element, only for
/// actionable elements.
fn pattern_candidates(ct: UIA_CONTROLTYPE_ID, element: &IUIAutomationElement) -> Vec<String> {
    let invoke = pattern::<IUIAutomationInvokePattern>(element, UIA_InvokePatternId).is_ok();
    let value = pattern::<IUIAutomationValuePattern>(element, UIA_ValuePatternId).is_ok();
    let toggle = pattern::<IUIAutomationTogglePattern>(element, UIA_TogglePatternId).is_ok();
    let select = pattern::<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId).is_ok();
    let expand = pattern::<IUIAutomationExpandCollapsePattern>(element, UIA_ExpandCollapsePatternId).is_ok();
    let mut out = Vec::new();
    if invoke {
        out.push("click".to_string());
    }
    if (ct == UIA_EditControlTypeId || ct == UIA_DocumentControlTypeId) && value {
        // A password field's value is never offered, for reading or for setting.
        let password =
            unsafe { element.CurrentIsPassword() }.map(|b| b.as_bool()).unwrap_or(false);
        if !password {
            out.push("setValue".to_string());
        }
    }
    if toggle {
        out.push("toggle".to_string());
    }
    if select {
        out.push("select".to_string());
    }
    if expand {
        out.push("expand".to_string());
        out.push("collapse".to_string());
    }
    out
}

fn pattern<T: Interface>(element: &IUIAutomationElement, id: UIA_PATTERN_ID) -> WResult<T> {
    unsafe { element.GetCurrentPattern(id)? }.cast::<T>()
}

fn property_name(element: &IUIAutomationElement) -> Option<String> {
    let n: BSTR = unsafe { element.CurrentName() }.ok()?;
    let s = n.to_string();
    if s.trim().is_empty() { None } else { Some(s) }
}

fn property_class(element: &IUIAutomationElement) -> Option<String> {
    let c: BSTR = unsafe { element.CurrentClassName() }.ok()?;
    let s = c.to_string();
    if s.trim().is_empty() { None } else { Some(s) }
}

fn property_enabled(element: &IUIAutomationElement) -> bool {
    unsafe { element.CurrentIsEnabled() }.map(|b| b.as_bool()).unwrap_or(true)
}

fn property_offscreen(element: &IUIAutomationElement) -> bool {
    unsafe { element.CurrentIsOffscreen() }.map(|b| b.as_bool()).unwrap_or(false)
}

/// The value the element holds (Edit, Document) — never a password's. When the
/// element takes no Value pattern, its text still rides the observe through
/// TextPattern, tightly capped: Word's document canvas is an Edit control whose
/// text is readable but not writable by any pattern the action union offers.
fn property_value(element: &IUIAutomationElement, ct: UIA_CONTROLTYPE_ID) -> Option<String> {
    if ct != UIA_EditControlTypeId && ct != UIA_DocumentControlTypeId {
        return None;
    }
    let password = unsafe { element.CurrentIsPassword() }.map(|b| b.as_bool()).unwrap_or(false);
    if password {
        return None;
    }
    match pattern::<IUIAutomationValuePattern>(element, UIA_ValuePatternId) {
        Ok(p) => {
            let v: BSTR = unsafe { p.CurrentValue() }.ok()?;
            let s = v.to_string();
            if s.is_empty() { None } else { Some(s) }
        }
        Err(_) => {
            // TextPattern readback: bounded, read-only. The observe stays honest
            // about WHAT the field holds even when no write can reach it.
            let p: IUIAutomationTextPattern = pattern(element, UIA_TextPatternId).ok()?;
            let range = unsafe { p.DocumentRange() }.ok()?;
            let t: BSTR = unsafe { range.GetText(TEXT_READ_CAP as i32) }.ok()?;
            let s = t.to_string();
            if s.trim().is_empty() { None } else { Some(cap_plain(&s, TEXT_READ_CAP)) }
        }
    }
}

/// The element's visible state where the tree shows one — the loop's verify
/// rules read this back on the re-observe (a toggle is verified by its state
/// flipping, a select by the chosen item reporting selected, an expand by the
/// state changing). Absent for everything else.
fn property_state(element: &IUIAutomationElement, ct: UIA_CONTROLTYPE_ID) -> Option<String> {
    if ct == UIA_CheckBoxControlTypeId || ct == UIA_RadioButtonControlTypeId {
        let p: IUIAutomationTogglePattern = pattern(element, UIA_TogglePatternId).ok()?;
        let s = unsafe { p.CurrentToggleState() }.ok()?;
        return Some(
            if s == ToggleState_On {
                "on"
            } else if s == ToggleState_Off {
                "off"
            } else {
                "indeterminate"
            }
            .to_string(),
        );
    }
    if ct == UIA_ComboBoxControlTypeId {
        let p: IUIAutomationExpandCollapsePattern =
            pattern(element, UIA_ExpandCollapsePatternId).ok()?;
        let s = unsafe { p.CurrentExpandCollapseState() }.ok()?;
        return Some(
            if s == ExpandCollapseState_Expanded {
                "expanded"
            } else if s == ExpandCollapseState_Collapsed {
                "collapsed"
            } else {
                return None;
            }
            .to_string(),
        );
    }
    if ct == UIA_ListItemControlTypeId {
        // IsSelected lives on the SelectionItem pattern, not on the element.
        let p: IUIAutomationSelectionItemPattern =
            pattern(element, UIA_SelectionItemPatternId).ok()?;
        let sel = unsafe { p.CurrentIsSelected() }.map(|b| b.as_bool()).ok()?;
        return Some(if sel { "selected" } else { "unselected" }.to_string());
    }
    None
}

fn property_rect(element: &IUIAutomationElement) -> Vec<i32> {
    let r: RECT = match unsafe { element.CurrentBoundingRectangle() } {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    vec![r.left, r.top, r.right - r.left, r.bottom - r.top]
}

/// One accessibility action on one element from the window's current observe.
fn perform(
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    action: &agent_wire::AgentAction,
) -> Result<Value, DriverError> {
    let disabled = unsafe { element.CurrentIsEnabled() }
        .map(|b| !b.as_bool())
        .unwrap_or(false);
    if disabled {
        return Err(err("notEnabled", "the element is disabled"));
    }
    // The sidecar judged the snapshot's name; this judges the element's name NOW,
    // so a label that changed after the observe ("Next" turned "Send") is refused.
    if let Some(why) = agent_wire::consequential_reason(action, property_name(element).as_deref()) {
        return Err(err("consequential", why));
    }
    match action {
        agent_wire::AgentAction::Click { .. } => {
            let p: IUIAutomationInvokePattern = pattern(element, UIA_InvokePatternId)
                .map_err(|_| err("noPattern", "the element does not take Invoke"))?;
            unsafe { p.Invoke() }.map_err(|e| err("invokeFailed", e.to_string()))?;
            Ok(json!({ "invoked": true }))
        }
        agent_wire::AgentAction::SetValue { text, .. } => {
            let p: IUIAutomationValuePattern = pattern(element, UIA_ValuePatternId)
                .map_err(|_| err("noPattern", "the element does not take a value"))?;
            unsafe { p.SetValue(&BSTR::from(text.as_str())) }
                .map_err(|e| err("setValueFailed", e.to_string()))?;
            Ok(json!({ "set": true }))
        }
        agent_wire::AgentAction::Toggle { .. } => {
            let p: IUIAutomationTogglePattern = pattern(element, UIA_TogglePatternId)
                .map_err(|_| err("noPattern", "the element does not toggle"))?;
            unsafe { p.Toggle() }.map_err(|e| err("toggleFailed", e.to_string()))?;
            Ok(json!({ "toggled": true }))
        }
        agent_wire::AgentAction::Select { value, .. } => {
            // Select by exact name: find the named item nearby, then SelectionItem.
            let target = find_named_item(walker, element, value)
                .ok_or_else(|| err("noMatch", format!("no selectable item named \"{value}\"")))?;
            let p: IUIAutomationSelectionItemPattern = pattern(&target, UIA_SelectionItemPatternId)
                .map_err(|_| err("noPattern", "the item does not take selection"))?;
            unsafe { p.Select() }.map_err(|e| err("selectFailed", e.to_string()))?;
            Ok(json!({ "selected": value }))
        }
        agent_wire::AgentAction::Expand { .. } => {
            let p: IUIAutomationExpandCollapsePattern = pattern(element, UIA_ExpandCollapsePatternId)
                .map_err(|_| err("noPattern", "the element does not expand or collapse"))?;
            unsafe { p.Expand() }.map_err(|e| err("expandFailed", e.to_string()))?;
            Ok(json!({ "expanded": true }))
        }
        agent_wire::AgentAction::Collapse { .. } => {
            let p: IUIAutomationExpandCollapsePattern = pattern(element, UIA_ExpandCollapsePatternId)
                .map_err(|_| err("noPattern", "the element does not expand or collapse"))?;
            unsafe { p.Collapse() }.map_err(|e| err("collapseFailed", e.to_string()))?;
            Ok(json!({ "collapsed": true }))
        }
    }
}

/// A descendant (to a small depth) whose name matches exactly: combos keep their
/// items behind an intermediate list.
fn find_named_item(
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    name: &str,
) -> Option<IUIAutomationElement> {
    let mut child = unsafe { walker.GetFirstChildElement(element) }.ok();
    while let Some(c) = child {
        if property_name(&c).as_deref() == Some(name) {
            return Some(c);
        }
        if let Some(deep) = find_named_item(walker, &c, name) {
            return Some(deep);
        }
        child = unsafe { walker.GetNextSiblingElement(&c) }.ok();
    }
    None
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe {
        let list = &mut *(lparam.0 as *mut Vec<isize>);
        list.push(hwnd.0 as isize);
    }
    true.into()
}

/// A window the person may grant: visible, top-level, not a floating tool
/// window, not cloaked (a UWP app suspended away from the desktop, for example).
fn is_listable(hwnd: HWND) -> bool {
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return false;
    }
    let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    if ex & WS_EX_TOOLWINDOW.0 != 0 {
        return false;
    }
    let mut cloaked = 0u32;
    let hr = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as _,
            std::mem::size_of::<u32>() as _,
        )
    };
    !(hr.is_ok() && cloaked != 0)
}

fn window_text(hwnd: HWND) -> String {
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; (len as usize) + 1];
    let read = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..(read as usize).min(len as usize)])
}

fn class_name_of(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..(n as usize).min(255)])
}

fn process_image(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return String::new();
        }
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        full.rsplit(['\\', '/']).next().unwrap_or("").to_string()
    }
}

fn cap(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let cut: String = s.chars().take(n).collect();
        format!("{cut}…")
    }
}

/// A value's prefix cut with NO ellipsis marker: the loop compares this string
/// with what was written, so the cut must be an honest prefix, never a
/// decorated one.
fn cap_plain(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{cap, cap_plain, NAME_CAP, VALUE_CAP};

    #[test]
    fn a_field_value_rides_the_wire_whole_up_to_the_value_cap() {
        let text = "line\n".repeat(900); // 4500 chars, under VALUE_CAP
        assert_eq!(cap_plain(&text, VALUE_CAP), text, "a value under the cap is never cut");
    }

    #[test]
    fn a_value_past_the_cap_is_an_honest_prefix_without_an_ellipsis() {
        let text = "x".repeat(VALUE_CAP + 500);
        let got = cap_plain(&text, VALUE_CAP);
        assert_eq!(got.len(), VALUE_CAP);
        assert!(!got.contains('…'), "no marker may corrupt the compare");
        assert!(text.starts_with(&got));
    }

    #[test]
    fn display_names_keep_their_ellipsis_cap() {
        assert_eq!(cap("short", NAME_CAP), "short");
        assert!(cap(&"y".repeat(NAME_CAP + 10), NAME_CAP).ends_with('…'));
    }
}
