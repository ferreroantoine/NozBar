//! Clés API (Gemini, Anthropic, Groq) stockées dans le Gestionnaire d'identification Windows.

const SERVICE: &str = "NozBar";

/// Compte du Gestionnaire d'identification pour chaque fournisseur.
fn account(provider: &str) -> Result<&'static str, String> {
    match provider {
        "gemini" => Ok("gemini_api_key"),
        "anthropic" => Ok("anthropic_api_key"),
        "groq" => Ok("groq_api_key"),
        _ => Err(format!("Fournisseur inconnu : {provider}")),
    }
}

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account(provider)?).map_err(|e| e.to_string())
}

pub fn get(provider: &str) -> Result<Option<String>, String> {
    match entry(provider)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn set(provider: &str, key: &str) -> Result<(), String> {
    entry(provider)?.set_password(key).map_err(|e| e.to_string())
}

pub fn delete(provider: &str) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_existing_gemini_account() {
        assert_eq!(account("gemini").unwrap(), "gemini_api_key");
        assert_eq!(account("anthropic").unwrap(), "anthropic_api_key");
        assert_eq!(account("groq").unwrap(), "groq_api_key");
        assert!(account("autre").is_err());
    }
}
