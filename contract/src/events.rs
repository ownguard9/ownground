//! NEP-297 events. Every state change emits one event with
//! standard "ownground" (a code identifier; it stays "ownground"
//! regardless of the final brand name).

use near_sdk::serde_json::json;
use near_sdk::{env, serde_json};

pub fn emit(event: &str, data: serde_json::Value) {
    let log = json!({
        "standard": "ownground",
        "version": "1.0.0",
        "event": event,
        "data": data,
    });
    env::log_str(&log.to_string());
}
