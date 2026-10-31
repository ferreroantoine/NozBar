//! Position de l'ordinateur via le service de localisation Windows.

use serde::Serialize;
use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

#[derive(Serialize)]
pub struct Position {
    pub lat: f64,
    pub lon: f64,
}

/// Bloquant (attend la réponse du service) : à appeler hors du fil principal.
pub fn locate() -> Result<Position, String> {
    unsafe {
        // Déjà initialisé sur ce fil : l'erreur est sans conséquence.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let access = Geolocator::RequestAccessAsync()
        .and_then(|op| op.get())
        .map_err(|e| format!("Localisation Windows indisponible : {e}"))?;
    if access != GeolocationAccessStatus::Allowed {
        return Err("Localisation Windows désactivée".into());
    }
    let point = Geolocator::new()
        .and_then(|g| g.GetGeopositionAsync())
        .and_then(|op| op.get())
        .and_then(|pos| pos.Coordinate())
        .and_then(|c| c.Point())
        .and_then(|p| p.Position())
        .map_err(|e| format!("Position introuvable : {e}"))?;
    Ok(Position { lat: point.Latitude, lon: point.Longitude })
}

#[cfg(test)]
mod tests {
    /// Dépend de la machine (localisation activée ou non) : `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn locates_this_computer() {
        match super::locate() {
            Ok(p) => println!("position : {:.1}, {:.1}", p.lat, p.lon),
            Err(e) => println!("erreur attendue si désactivée : {e}"),
        }
    }
}
