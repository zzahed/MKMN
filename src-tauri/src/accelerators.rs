//! Physical-identity accelerator classification (M01–M05 of the recheck)
//! and the adapter device inventory that identifies the NPU.
//!
//! Every PDH "GPU Engine" instance is attributed to its PHYSICAL engine —
//! (adapter LUID, physical node, engine index, engine type) — and every displayed
//! number is "the busiest engine" over the contributions to each engine, the
//! convention Task Manager uses
//! (https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/). Sums of
//! independent engines are never presented as one percentage: 3D 60% + Compute 50%
//! on one GPU is "busiest engine 60%", not "110%" (M01). The same rule applies at
//! every scope — a process is the busiest engine IT uses, the MKMN tree is the
//! busiest engine over its processes' combined contributions, the machine is the
//! busiest engine overall (M02).
//!
//! Adapters are classified from a cached Windows device inventory (DXCore: LUID +
//! driver description), never from the absence of a 3D instance in one sample
//! (M04): an engine-instance snapshot is not a device inventory, and a compute-only
//! adapter Windows does not identify is reported as UNKNOWN — excluded from both
//! the GPU and the NPU numbers — rather than silently assigned to the Hexagon.
//!
//! Counter presence, validity and utilization are kept apart (M05): an idle-but-
//! supported accelerator is a measured 0 with `observed = true`; a counter whose
//! PDH status is not valid data sets `invalid = true` and its value is withheld.
//! An accelerator with no counters at all reports "unavailable", never a
//! measured-looking zero.

use std::collections::{HashMap, HashSet};

/// PDH formatted-value status codes that carry a usable reading.
pub const PDH_CSTATUS_VALID_DATA: u32 = 0x0000_0000;
pub const PDH_CSTATUS_NEW_DATA: u32 = 0x0001_0001;

/// One physical engine of one adapter. The `engtype` is part of the identity:
/// PDH names engine instances by node AND type, and two instances that share a
/// node number but differ in type are different hardware engines.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EngineId {
    /// Normalized adapter key: `luid_0x<high>_0x<low>`, lower-case hex.
    pub luid: String,
    pub phys: u32,
    pub eng: u32,
    /// Lower-cased engine type (3d, compute, npu, videoencode, …).
    pub engtype: String,
}

/// How Windows identifies an adapter — verified device metadata, not a guess
/// from one sample's engine mix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdapterClass {
    /// A graphics adapter (DXCore lists it under D3D12 graphics).
    Gpu,
    /// An accelerator Windows' own device metadata names as an NPU/Hexagon/
    /// neural processor.
    Npu,
    /// Present in the engine counters but not identified by device metadata.
    /// Its load is tracked separately and attributed to NOTHING.
    Unknown,
}

/// The cached adapter inventory: LUID key -> (class, driver description).
#[derive(Debug, Default, Clone)]
pub struct AdapterInventory {
    pub adapters: HashMap<String, (AdapterClass, String)>,
}

impl AdapterInventory {
    fn class_from_description(desc: &str) -> Option<AdapterClass> {
        let d = desc.to_lowercase();
        // Word boundaries: "npu" must not match inside a longer word.
        let has_word = |w: &str| d.split(|c: char| !c.is_ascii_alphanumeric()).any(|p| p == w);
        if has_word("npu") || has_word("hexagon") || has_word("neural") {
            Some(AdapterClass::Npu)
        } else {
            None
        }
    }

    pub fn class_of(&self, luid: &str) -> Option<AdapterClass> {
        self.adapters.get(luid).map(|(c, _)| *c)
    }

    pub fn description_of(&self, luid: &str) -> Option<&str> {
        self.adapters.get(luid).map(|(_, d)| d.as_str())
    }

    /// Probes Windows (DXCore) for the adapter inventory. DXCore is the one
    /// Windows API that enumerates compute-only accelerators alongside graphics
    /// adapters; the union of several attribute lists is taken so an adapter the
    /// NPU driver registers through a non-standard attribute is still found.
    /// An adapter listed under D3D12 graphics is a GPU; one whose driver
    /// description names an NPU is the NPU; anything else stays Unknown.
    /// A failed or empty probe yields an EMPTY inventory: every adapter is then
    /// Unknown and the readings honestly report "unavailable" (M04).
    #[allow(clippy::needless_return)]
    pub fn probe() -> Self {
        use windows::Win32::Foundation::LUID;
        use windows::Win32::Graphics::DXCore::{
            DXCoreCreateAdapterFactory, DXCORE_ADAPTER_ATTRIBUTE_D3D12_CORE_COMPUTE,
            DXCORE_ADAPTER_ATTRIBUTE_D3D12_GRAPHICS, IDXCoreAdapter, IDXCoreAdapterFactory, IDXCoreAdapterList,
            DriverDescription, InstanceLuid,
        };

        let Ok(factory) = (unsafe { DXCoreCreateAdapterFactory::<IDXCoreAdapterFactory>() }) else {
            return Self::default();
        };
        let mut adapters: HashMap<String, (AdapterClass, String)> = HashMap::new();

        // (attribute list, whether the list implies D3D12 graphics support)
        let lists: [(&[windows::core::GUID], bool); 3] = [
            (&[DXCORE_ADAPTER_ATTRIBUTE_D3D12_GRAPHICS], true),
            (&[DXCORE_ADAPTER_ATTRIBUTE_D3D12_CORE_COMPUTE], false),
            // The attribute the Hexagon NPU driver registers (verified on a
            // Snapdragon X2 Elite: it lists the GPU, the NPU and WARP alike).
            // A vendor-registered GUID — when it enumerates nothing, the union
            // above still classifies graphics adapters, and an NPU it misses
            // honestly reports unavailable rather than mislabeled.
            (&[windows::core::GUID::from_u128(0xb71b0d41_1088_422f_a27c_0250b7d3a988)], false),
        ];

        for (attrs, from_graphics_list) in lists {
            let Ok(list) = (unsafe { factory.CreateAdapterList::<IDXCoreAdapterList>(attrs) }) else {
                continue;
            };
            let count = unsafe { list.GetAdapterCount() };
            for i in 0..count {
                let Ok(adapter) = (unsafe { list.GetAdapter::<IDXCoreAdapter>(i) }) else {
                    continue;
                };
                let luid = unsafe {
                    let Ok(size) = adapter.GetPropertySize(InstanceLuid) else { continue };
                    if size != std::mem::size_of::<LUID>() {
                        continue;
                    }
                    let mut luid = LUID { LowPart: 0, HighPart: 0 };
                    if adapter.GetProperty(InstanceLuid, size, &mut luid as *mut _ as *mut _).is_err() {
                        continue;
                    }
                    format!("luid_0x{:08x}_0x{:08x}", luid.HighPart as u32, luid.LowPart)
                };
                let description = unsafe {
                    let Ok(size) = adapter.GetPropertySize(DriverDescription) else { continue };
                    if size == 0 {
                        continue;
                    }
                    let mut buf = vec![0u8; size];
                    if adapter.GetProperty(DriverDescription, size, buf.as_mut_ptr() as *mut _).is_err() {
                        continue;
                    }
                    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
                    String::from_utf8_lossy(&buf[..end]).to_string()
                };
                let npu = Self::class_from_description(&description) == Some(AdapterClass::Npu);
                let class = if npu {
                    AdapterClass::Npu
                } else if from_graphics_list {
                    AdapterClass::Gpu
                } else {
                    // Compute-capable or merely registered: not positively
                    // identified. Another list's entry (or a later probe) may
                    // classify it; keep any stronger existing classification.
                    AdapterClass::Unknown
                };
                let keep_class = match adapters.get(&luid) {
                    // A stronger identification (Npu > Gpu > Unknown) wins.
                    Some((AdapterClass::Npu, _)) => AdapterClass::Npu,
                    Some((AdapterClass::Gpu, _)) => {
                        if class == AdapterClass::Npu { AdapterClass::Npu } else { AdapterClass::Gpu }
                    }
                    Some((AdapterClass::Unknown, _)) | None => class,
                };
                adapters.entry(luid).or_insert((keep_class, description)).0 = keep_class;
            }
        }
        Self { adapters }
    }

    /// Re-probes only when an engine counter names an adapter the inventory has
    /// never seen (a device/driver change, or the first probe failed): the
    /// inventory is otherwise trusted for the lifetime of the monitor.
    pub fn needs_refresh_for(&self, seen_luids: impl IntoIterator<Item = String>) -> bool {
        seen_luids
            .into_iter()
            .any(|l| !l.is_empty() && self.class_of(&l).is_none())
    }

    /// A process-wide shared inventory for callers that only need classification
    /// (NPU verification loops): probed once, never re-probed. Long-lived monitors
    /// keep their own re-probeable inventory instead.
    pub fn shared() -> &'static Self {
        static SHARED: std::sync::OnceLock<AdapterInventory> = std::sync::OnceLock::new();
        SHARED.get_or_init(AdapterInventory::probe)
    }
}

/// One accelerator class's physical engines for one sample.
#[derive(Debug, Default, Clone)]
pub struct EngineSet {
    /// Each physical engine's load: the SUM of the contributions of every
    /// process using it (an engine runs several processes' work at once).
    pub engines: HashMap<EngineId, f64>,
    /// Each process's contribution to each engine.
    pub pid_engine: HashMap<(EngineId, u32), f64>,
    /// Whether Windows exposed at least one valid counter instance for this set
    /// (an idle 0.0 counts): "supported", separate from any utilization (M05).
    pub observed: bool,
    /// This set saw counters whose PDH status was not valid data: readings were
    /// withheld and any number below is incomplete.
    pub invalid: bool,
}

impl EngineSet {
    /// SYSTEM scope: the busiest engine on the machine right now.
    pub fn busiest_engine(&self) -> f64 {
        self.engines.values().copied().fold(0.0f64, f64::max).clamp(0.0, 100.0)
    }

    /// PROCESS scope: the busiest engine this process contributes to (Task
    /// Manager's per-process convention).
    pub fn busiest_for_pid(&self, pid: u32) -> f64 {
        self.pid_engine
            .iter()
            .filter(|((_, p), _)| *p == pid)
            .map(|(_, v)| *v)
            .fold(0.0f64, f64::max)
            .clamp(0.0, 100.0)
    }

    /// APPLICATION scope: the contributions to each engine from the selected
    /// process set are summed (the engine runs them together), then the busiest
    /// engine is the headline. Never the sum of engines.
    pub fn busiest_within(&self, pids: &HashSet<u32>) -> f64 {
        let mut per_engine: HashMap<&EngineId, f64> = HashMap::new();
        for ((engine, pid), v) in &self.pid_engine {
            if pids.contains(pid) {
                *per_engine.entry(engine).or_insert(0.0) += v;
            }
        }
        per_engine.values().copied().fold(0.0f64, f64::max).clamp(0.0, 100.0)
    }

    /// Every engine's reading, for the detail view (M01: separate engine
    /// readings stay available up to the UI).
    pub fn engine_readings(&self) -> Vec<(EngineId, f64)> {
        let mut v: Vec<(EngineId, f64)> = self
            .engines
            .iter()
            .map(|(e, load)| (e.clone(), load.clamp(0.0, 100.0)))
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }
}

/// A classified sample of the GPU Engine counter set.
#[derive(Debug, Default, Clone)]
pub struct ClassifiedSample {
    pub gpu: EngineSet,
    pub npu: EngineSet,
    /// Engines on adapters no device metadata identifies. Tracked so their load
    /// is not silently attributed to the GPU or the NPU (M04).
    pub unknown: EngineSet,
}

/// The adapter identity of a GPU Engine instance name: its `luid_0x<hex>_0x<hex>`
/// part, and nothing after it. PDH writes the rest of the name with the same
/// underscore (`..._phys_0_eng_0_engtype_Compute`), so a parse that only stops at
/// punctuation would swallow those parts and give the same adapter's 3D and Compute
/// instances different keys — every non-3D engine would then look like its own
/// compute-only adapter.
pub fn luid_key(name: &str) -> Option<String> {
    let pos = name.find("luid_")?;
    let rest = &name.as_bytes()[pos + 5..];
    let mut out = String::from("luid_");
    let mut i = 0usize;
    for part in 0..2 {
        // each half is "0x" followed by hex digits
        if i + 1 < rest.len() && rest[i] == b'0' && (rest[i + 1] == b'x' || rest[i + 1] == b'X') {
            out.push_str("0x");
            i += 2;
        } else {
            return None;
        }
        let start = i;
        while i < rest.len() && rest[i].is_ascii_hexdigit() {
            i += 1;
        }
        if i == start {
            return None;
        }
        out.push_str(&String::from_utf8_lossy(&rest[start..i]).to_lowercase());
        if part == 0 {
            if i < rest.len() && rest[i] == b'_' {
                out.push('_');
                i += 1;
            } else {
                return None;
            }
        }
    }
    Some(out)
}

fn digits_after(name: &str, marker: &str) -> Option<u32> {
    let pos = name.find(marker)?;
    let rest = &name[pos + marker.len()..];
    let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    num.parse::<u32>().ok()
}

pub fn pid_of(name: &str) -> Option<u32> {
    digits_after(name, "pid_")
}

pub fn phys_of(name: &str) -> Option<u32> {
    digits_after(name, "_phys_")
}

pub fn eng_of(name: &str) -> Option<u32> {
    // "_eng_" and not "engtype_": the type marker shares the prefix "eng" but
    // never has the underscore-number shape.
    digits_after(name, "_eng_")
}

pub fn engtype_of(name: &str) -> String {
    name.split("engtype_").nth(1).unwrap_or("").to_lowercase()
}

/// One PDH counter instance: its instance name, cooked value, and the PDH
/// status the formatted read reported (M05: validity travels with the value).
pub type CounterInstance = (String, f64, u32);

/// Splits a GPU Engine snapshot into GPU, NPU and unknown-adapter engine sets,
/// preserving physical-engine identity until the caller aggregates (M01/M02).
/// `instances` must be the COMPLETE formatted array of one sample; presence
/// (supported/idle) and invalidity are derived from it, never from the loads.
pub fn classify_gpu_counters(
    instances: &[CounterInstance],
    inventory: &AdapterInventory,
) -> ClassifiedSample {
    let mut out = ClassifiedSample::default();
    // Adapters Windows positively identifies as NPUs are the NPU. `engtype_NPU`
    // instances are positive Windows evidence too, whatever the adapter inventory
    // says. Everything else follows the adapter's class.
    let mut npu_adapters: HashSet<String> = HashSet::new();
    let mut adapter_engtypes: HashMap<String, HashSet<String>> = HashMap::new();
    for (name, _, _status) in instances {
        let luid = luid_key(name).unwrap_or_default();
        if luid.is_empty() {
            continue;
        }
        let engtype = engtype_of(name);
        adapter_engtypes.entry(luid.clone()).or_default().insert(engtype.clone());
        if engtype == "npu" {
            npu_adapters.insert(luid);
        }
    }

    for (name, val, status) in instances {
        // Non-finite and impossible readings are never used; an out-of-range
        // value is a wrap-around/first-sample glitch, the same one Task Manager
        // hides (but presence of the instance itself was recorded above).
        if !val.is_finite() || *val < 0.0 || *val > 100.5 {
            continue;
        }
        let valid_status = *status == PDH_CSTATUS_VALID_DATA || *status == PDH_CSTATUS_NEW_DATA;
        let luid = luid_key(name).unwrap_or_default();
        if luid.is_empty() {
            continue;
        }
        let engtype = engtype_of(name);
        let class = if npu_adapters.contains(&luid) || inventory.class_of(&luid) == Some(AdapterClass::Npu) {
            AdapterClass::Npu
        } else {
            inventory.class_of(&luid).unwrap_or(AdapterClass::Unknown)
        };
        let set = match class {
            AdapterClass::Npu => &mut out.npu,
            AdapterClass::Gpu => &mut out.gpu,
            AdapterClass::Unknown => &mut out.unknown,
        };
        if !valid_status {
            set.invalid = true;
            continue; // the reading is withheld; presence was already recorded
        }
        let id = EngineId {
            luid: luid.clone(),
            phys: phys_of(name).unwrap_or(0),
            eng: eng_of(name).unwrap_or(0),
            engtype,
        };
        set.observed = true;
        *set.engines.entry(id.clone()).or_insert(0.0) += val;
        if let Some(pid) = pid_of(name) {
            *set.pid_engine.entry((id, pid)).or_insert(0.0) += val;
        }
    }
    out
}

/// The adapters that are the NPU, by the same evidence `classify_gpu_counters` uses: an
/// `engtype_NPU` engine instance, or the device inventory naming the adapter an NPU.
/// Only the instance names are read, so the values of `engine` need not be a valid rate.
pub fn npu_adapter_luids(engine: &[CounterInstance], inventory: &AdapterInventory) -> HashSet<String> {
    let mut out: HashSet<String> = inventory
        .adapters
        .iter()
        .filter(|(_, (class, _))| *class == AdapterClass::Npu)
        .map(|(luid, _)| luid.clone())
        .collect();
    for (name, _, _) in engine {
        if engtype_of(name) == "npu"
            && let Some(luid) = luid_key(name)
        {
            out.insert(luid);
        }
    }
    out
}

/// The NPU's memory in use, in bytes: the shared plus dedicated usage of the "GPU Adapter
/// Memory" instances of the NPU's adapters (`memory` holds both counters' rows). None when
/// no valid row belongs to an NPU adapter: unknown, never a measured 0.
pub fn npu_memory_bytes(memory: &[CounterInstance], npu: &HashSet<String>) -> Option<f64> {
    let mut total = 0.0f64;
    let mut seen = false;
    for (name, val, status) in memory {
        let valid = *status == PDH_CSTATUS_VALID_DATA || *status == PDH_CSTATUS_NEW_DATA;
        if !valid || !val.is_finite() || *val < 0.0 {
            continue;
        }
        if luid_key(name).is_some_and(|l| npu.contains(&l)) {
            total += val;
            seen = true;
        }
    }
    seen.then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The NPU's memory is the sum of its own adapter's shared and dedicated rows; the
    /// GPU's rows and invalid rows never count, and no NPU row is unknown, not 0.
    #[test]
    fn npu_memory_counts_only_the_npu_adapters_valid_rows() {
        let npu: HashSet<String> = [NPU.to_string()].into();
        let rows = vec![
            (format!("{NPU}_phys_0"), 12_730_368.0, PDH_CSTATUS_VALID_DATA), // shared
            (format!("{NPU}_phys_0"), 1_000.0, PDH_CSTATUS_VALID_DATA),      // dedicated
            (format!("{GPU}_phys_0"), 932_007_936.0, PDH_CSTATUS_VALID_DATA),
            (format!("{NPU}_phys_0"), 5e9, 0xC000_0BBA),                      // not valid data
        ];
        assert_eq!(npu_memory_bytes(&rows, &npu), Some(12_731_368.0));
        assert_eq!(npu_memory_bytes(&rows[2..3], &npu), None, "only the GPU's row: unknown");
        assert_eq!(npu_memory_bytes(&[], &npu), None);
    }

    /// The NPU adapters come from engtype_NPU instances and from the inventory alike:
    /// on a Snapdragon X the NPU is a compute-only adapter the inventory names.
    #[test]
    fn npu_adapters_come_from_engines_and_the_inventory() {
        let by_inventory = inv(&[(GPU, AdapterClass::Gpu), (NPU, AdapterClass::Npu)]);
        let engines = vec![inst(1, GPU, 0, 0, "3D", 0.0), inst(1, NPU, 0, 0, "Compute", 0.0)];
        assert_eq!(npu_adapter_luids(&engines, &by_inventory), [NPU.to_string()].into());
        let other = "luid_0x00000000_0x0000beef";
        let by_engine = vec![inst(1, other, 0, 0, "NPU", 0.0)];
        assert_eq!(npu_adapter_luids(&by_engine, &inv(&[])), [other.to_string()].into());
    }

    fn inv(entries: &[(&str, AdapterClass)]) -> AdapterInventory {
        AdapterInventory {
            adapters: entries
                .iter()
                .map(|(l, c)| (l.to_string(), (*c, String::new())))
                .collect(),
        }
    }

    const GPU: &str = "luid_0x00000000_0x00010c23";
    const NPU: &str = "luid_0x00000000_0x00010f31";

    fn classify(instances: Vec<CounterInstance>) -> ClassifiedSample {
        let inventory = inv(&[
            (GPU, AdapterClass::Gpu),
            (NPU, AdapterClass::Npu),
        ]);
        classify_gpu_counters(&instances, &inventory)
    }

    fn inst(pid: u32, luid: &str, phys: u32, eng: u32, engtype: &str, val: f64) -> CounterInstance {
        (
            format!("pid_{pid}_{luid}_phys_{phys}_eng_{eng}_engtype_{engtype}"),
            val,
            PDH_CSTATUS_VALID_DATA,
        )
    }

    #[test]
    fn parses_the_full_instance_identity() {
        let name = "pid_42108_luid_0x00000000_0x00010F31_phys_0_eng_3_engtype_Compute";
        assert_eq!(pid_of(name), Some(42108));
        assert_eq!(luid_key(name).as_deref(), Some("luid_0x00000000_0x00010f31"));
        assert_eq!(phys_of(name), Some(0));
        assert_eq!(eng_of(name), Some(3));
        assert_eq!(engtype_of(name), "compute");
        assert_eq!(eng_of("pid_1_x_phys_0_engtype_3D"), None);
    }

    /// M01: independent engines are NEVER summed into one percentage — at any
    /// scope. (The old test pinned 30+20=50 for one process; the Task-Manager
    /// contract is the busiest engine.)
    #[test]
    fn independent_engines_take_the_busiest_never_the_sum() {
        let s = classify(vec![
            inst(100, GPU, 0, 0, "3D", 60.0),
            inst(100, GPU, 0, 1, "Compute", 50.0),
        ]);
        assert!((s.gpu.busiest_engine() - 60.0).abs() < 1e-9, "system = busiest engine, not {}", s.gpu.busiest_engine());
        assert!((s.gpu.busiest_for_pid(100) - 60.0).abs() < 1e-9);
        let owned: HashSet<u32> = [100u32].into();
        assert!((s.gpu.busiest_within(&owned) - 60.0).abs() < 1e-9);
    }

    /// M02 (shared engine): two processes on ONE engine add up to the engine's
    /// load; each process still reads its own contribution.
    #[test]
    fn shared_engine_sums_contributions_per_scope() {
        let s = classify(vec![
            inst(100, NPU, 0, 0, "Compute", 40.0),
            inst(200, NPU, 0, 0, "Compute", 30.0),
        ]);
        assert!((s.npu.busiest_engine() - 70.0).abs() < 1e-9);
        assert!((s.npu.busiest_for_pid(100) - 40.0).abs() < 1e-9);
        assert!((s.npu.busiest_for_pid(200) - 30.0).abs() < 1e-9);
        let both: HashSet<u32> = [100u32, 200].into();
        let one: HashSet<u32> = [100u32].into();
        assert!((s.npu.busiest_within(&both) - 70.0).abs() < 1e-9, "the application's engines run both processes' work");
        assert!((s.npu.busiest_within(&one) - 40.0).abs() < 1e-9);
    }

    /// M02 (independent engines of the same type): two NPU engines at 40/30 are
    /// two engines — the machine's NPU headline is 40 (busiest), not 70.
    #[test]
    fn independent_npu_engines_are_not_summed() {
        let s = classify(vec![
            inst(100, NPU, 0, 0, "Compute", 40.0),
            inst(100, NPU, 0, 1, "Compute", 30.0),
        ]);
        assert!((s.npu.busiest_engine() - 40.0).abs() < 1e-9);
        assert!((s.npu.busiest_for_pid(100) - 40.0).abs() < 1e-9);
    }

    /// M04: an adapter the device inventory does not identify is UNKNOWN, even
    /// when it shows a Compute engine and no 3D — a compute instance with no 3D
    /// in the sample is not proof of an NPU.
    #[test]
    fn unidentified_computes_only_adapter_is_unknown_not_npu() {
        let other = "luid_0x00000000_0x0000dead";
        let inventory = inv(&[(GPU, AdapterClass::Gpu)]);
        let s = classify_gpu_counters(
            &[inst(100, other, 0, 0, "Compute", 30.0)],
            &inventory,
        );
        assert!((s.gpu.busiest_engine()).abs() < 1e-9);
        assert_eq!(s.npu.busiest_engine(), 0.0);
        assert!(!s.npu.observed, "no verified NPU counter: the NPU reads UNAVAILABLE, not 0");
        assert!(s.unknown.observed);
        assert!((s.unknown.busiest_engine() - 30.0).abs() < 1e-9);
    }

    /// M04 positive path: `engtype_NPU` counters are Windows' own evidence.
    #[test]
    fn engtype_npu_counters_identify_the_npu_without_inventory() {
        let inventory = AdapterInventory::default();
        let s = classify_gpu_counters(
            &[inst(100, NPU, 0, 0, "NPU", 55.0)],
            &inventory,
        );
        assert!(s.npu.observed);
        assert!((s.npu.busiest_engine() - 55.0).abs() < 1e-9);
        assert!(s.unknown.engines.is_empty());
    }

    /// M05: a valid idle counter is a MEASURED ZERO with observed = true —
    /// distinguishable from "no counters at all".
    #[test]
    fn idle_counter_is_observed_zero_not_unavailable() {
        let s = classify(vec![inst(100, NPU, 0, 0, "NPU", 0.0)]);
        assert!(s.npu.observed);
        assert!((s.npu.busiest_engine()).abs() < 1e-9);
        assert!((s.npu.busiest_for_pid(100)).abs() < 1e-9);
    }

    /// M05: an invalid PDH status withholds the reading and flags the set.
    #[test]
    fn invalid_status_withholds_the_reading() {
        let s = classify(vec![inst(100, NPU, 0, 0, "NPU", 42.0)]);
        let mut bad = inst(100, NPU, 0, 0, "NPU", 42.0);
        bad.2 = 0xC000_0BBC; // PDH_INVALID_DATA
        let s2 = classify(vec![bad]);
        assert!(s2.npu.invalid);
        assert!(!s2.npu.observed, "no valid reading: availability must not be implied");
        assert!((s2.npu.busiest_engine()).abs() < 1e-9);
        let _ = s;
    }

    /// Non-finite and out-of-range values never become load.
    #[test]
    fn impossible_values_are_skipped() {
        let s = classify(vec![
            (format!("pid_100_{GPU}_phys_0_eng_0_engtype_3D"), f64::NAN, PDH_CSTATUS_VALID_DATA),
            (format!("pid_100_{GPU}_phys_0_eng_0_engtype_3D"), f64::INFINITY, PDH_CSTATUS_VALID_DATA),
            inst(100, GPU, 0, 0, "3D", 959.5), // wrap-around glitch
        ]);
        assert!((s.gpu.busiest_engine()).abs() < 1e-9);
        assert!(!s.gpu.observed);
    }

    /// The busiest-engine rule applied per PID never exceeds 100.
    #[test]
    fn per_process_value_stays_within_100() {
        let s = classify(vec![
            inst(100, GPU, 0, 0, "3D", 80.0),
            inst(100, GPU, 0, 1, "Compute", 70.0),
        ]);
        assert!((s.gpu.busiest_for_pid(100) - 80.0).abs() < 1e-9);
    }

    /// Engine readings stay available for the detail view, keyed by identity.
    #[test]
    fn engine_readings_carry_physical_identity() {
        let s = classify(vec![
            inst(100, GPU, 0, 0, "3D", 10.0),
            inst(200, GPU, 0, 0, "3D", 20.0),
        ]);
        let readings = s.gpu.engine_readings();
        assert_eq!(readings.len(), 1);
        let (id, load) = &readings[0];
        assert_eq!(id.luid, GPU);
        assert_eq!((id.phys, id.eng), (0, 0));
        assert!((load - 30.0).abs() < 1e-9, "one engine, two processes: engine total = 30");
    }

    /// The inventory classifies from the driver description (device metadata).
    #[test]
    fn description_identifies_the_npu() {
        assert_eq!(AdapterInventory::class_from_description("Snapdragon(R) X2 Elite - X2E88100 - Qualcomm(R) Hexagon(TM) NPU"), Some(AdapterClass::Npu));
        assert_eq!(AdapterInventory::class_from_description("Qualcomm(R) Adreno(TM) X2-90 GPU"), None);
        assert_eq!(AdapterInventory::class_from_description("Microsoft Basic Render Driver"), None);
    }
}
