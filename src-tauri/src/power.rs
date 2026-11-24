use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use serde::{Deserialize, Serialize};
use windows_sys::Win32::System::Power::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PowerStatusInfo {
    #[serde(rename = "onAcPower")]
    pub on_ac_power: bool,
    #[serde(rename = "batteryPercent")]
    pub battery_percent: Option<u8>,
    #[serde(rename = "powerSaverRecommended")]
    pub power_saver_recommended: bool,
    #[serde(rename = "acLineStatus")]
    pub ac_line_status: u8,
    /// Windows Energy Saver (battery saver) is on: the person asked the whole PC to save power.
    #[serde(rename = "energySaverOn", default)]
    pub energy_saver_on: bool,
}

/// 0 = system may sleep, 1 = sleep inhibited.
static INHIBIT_REQUESTED: AtomicU8 = AtomicU8::new(0);
static INHIBIT_OWNER: OnceLock<std::thread::Thread> = OnceLock::new();

/// `SetThreadExecutionState` only affects the calling thread, so the request is
/// serviced by ONE dedicated owner thread. Any worker can call set_sleep_inhibit
/// and the state is global, owned, and survives worker-thread turnover; when the
/// flag is cleared the owner releases the inhibition deterministically.
fn ensure_inhibit_owner_thread() {
    let _ = INHIBIT_OWNER.get_or_init(|| {
        std::thread::Builder::new()
            .name("sleep-inhibit-owner".to_string())
            .spawn(|| {
                let mut applied: u8 = 2; // force first application
                loop {
                    let requested = INHIBIT_REQUESTED.load(Ordering::SeqCst);
                    if requested != applied {
                        unsafe {
                            if requested == 1 {
                                // Keep system awake during token generation / benchmark
                                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
                            } else {
                                // Release: back to normal idle behavior
                                SetThreadExecutionState(ES_CONTINUOUS);
                            }
                        }
                        applied = requested;
                    }
                    // Every change unparks this thread (set_sleep_inhibit), and an unpark that
                    // lands before the park makes it return at once, so there is nothing to poll
                    // for: a timed park only woke the CPU twice a second for the whole session.
                    std::thread::park();
                }
            })
            .expect("failed to spawn sleep-inhibit owner thread")
            .thread()
            .clone()
    });
}

pub fn set_sleep_inhibit(prevent_sleep: bool) {
    ensure_inhibit_owner_thread();
    INHIBIT_REQUESTED.store(u8::from(prevent_sleep), Ordering::SeqCst);
    if let Some(owner) = INHIBIT_OWNER.get() {
        owner.unpark();
    }
}

pub fn get_power_status() -> PowerStatusInfo {
    let mut status: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetSystemPowerStatus(&mut status) };
    if ok != 0 {
        let on_ac = status.ACLineStatus == 1;
        let battery = if status.BatteryLifePercent <= 100 {
            Some(status.BatteryLifePercent)
        } else {
            None
        };
        let energy_saver_on = status.SystemStatusFlag == 1;
        let power_saver = energy_saver_on || (!on_ac && battery.is_some_and(|b| b <= 20));
        PowerStatusInfo {
            on_ac_power: on_ac,
            battery_percent: battery,
            power_saver_recommended: power_saver,
            ac_line_status: status.ACLineStatus,
            energy_saver_on,
        }
    } else {
        // Fallback: assume AC power if query fails
        PowerStatusInfo {
            on_ac_power: true,
            battery_percent: None,
            power_saver_recommended: false,
            ac_line_status: 255,
            energy_saver_on: false,
        }
    }
}

pub fn resolve_effective_power_mode(requested: &str) -> &'static str {
    match requested.to_lowercase().as_str() {
        "burst" | "maximum" | "max" => "burst",
        "power_saver" | "battery" | "saver" => "power_saver",
        "sustained_high_performance" | "sustained" => "sustained_high_performance",
        // The other modes GenieX's own --power-mode documents pass through unchanged:
        // they are valid HTP clock modes, not guesses to be coerced.
        "low_power_saver" => "low_power_saver",
        "high_power_saver" => "high_power_saver",
        "low_balanced" => "low_balanced",
        "balanced" => "balanced",
        "high_performance" => "high_performance",
        "auto" | "adaptive" => {
            let p = get_power_status();
            auto_power_mode(p.on_ac_power, p.battery_percent, p.energy_saver_on)
        }
        _ => "sustained_high_performance",
    }
}

/// "Automatic" is quiet-first: the NPU never runs at its peak clocks unless the person
/// picks "burst" themselves, because peak clocks over a long answer are what heat the PC
/// and spin the fans up. Plugged in it runs balanced; on battery it steps further down as
/// the charge falls. Windows Energy Saver wins over everything: the person asked the
/// whole PC to save power.
pub fn auto_power_mode(on_ac: bool, battery_percent: Option<u8>, energy_saver_on: bool) -> &'static str {
    if energy_saver_on {
        return "power_saver";
    }
    if on_ac {
        return "balanced";
    }
    match battery_percent {
        Some(b) if b <= 25 => "power_saver",
        Some(b) if b <= 50 => "high_power_saver",
        _ => "low_balanced",
    }
}

#[cfg(test)]
mod tests {
    use super::{auto_power_mode, resolve_effective_power_mode};

    #[test]
    fn auto_saves_power_on_battery_and_under_energy_saver() {
        // never the peak clocks on its own: those are what spin the fans up
        assert_eq!(auto_power_mode(true, Some(100), false), "balanced");
        assert_eq!(auto_power_mode(true, None, false), "balanced");
        assert_eq!(auto_power_mode(false, Some(90), false), "low_balanced");
        assert_eq!(auto_power_mode(false, None, false), "low_balanced");
        assert_eq!(auto_power_mode(false, Some(50), false), "high_power_saver");
        assert_eq!(auto_power_mode(false, Some(25), false), "power_saver");
        // Energy Saver is the person's own request: it wins on mains power too
        assert_eq!(auto_power_mode(true, Some(100), true), "power_saver");
        assert_eq!(auto_power_mode(false, Some(90), true), "power_saver");
    }

    #[test]
    fn every_geniex_power_mode_passes_through() {
        // The eight HTP modes GenieX's own --power-mode documents are valid values:
        // none of them may be coerced to a different mode.
        for mode in [
            "burst",
            "high_performance",
            "sustained_high_performance",
            "balanced",
            "low_balanced",
            "power_saver",
            "high_power_saver",
            "low_power_saver",
        ] {
            assert_eq!(resolve_effective_power_mode(mode), mode, "mode {mode} must pass through unchanged");
        }
    }

    #[test]
    fn legacy_synonyms_and_unknowns_still_resolve() {
        assert_eq!(resolve_effective_power_mode("maximum"), "burst");
        assert_eq!(resolve_effective_power_mode("battery"), "power_saver");
        assert_eq!(resolve_effective_power_mode("sustained"), "sustained_high_performance");
        assert_eq!(resolve_effective_power_mode("nonsense"), "sustained_high_performance");
    }
}
