//! Serveur MCP minimal : expose les outils de NozBar à Claude Code, sur 127.0.0.1 uniquement.
//!
//! Transport « Streamable HTTP » réduit à l'essentiel : chaque POST JSON-RPC reçoit une réponse JSON
//! (ou 202 pour une notification) ; pas de flux SSE (GET → 405, permis par la spécification).
//! Les appels d'outils sont relayés à l'interface, qui les exécute avec le code TypeScript existant.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

const DEFAULT_PROTOCOL: &str = "2025-06-18";
/// Une confirmation peut attendre l'utilisateur longtemps ; au-delà, on rend la main à Claude Code.
const CALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct ToolOutcome {
    pub text: String,
    pub is_error: bool,
}

/// Outil de permission de Claude Code (`--permission-prompt-tool mcp__nozbar__approve`).
fn approve_tool() -> Value {
    json!({
        "name": "approve",
        "description": "Demande à l'utilisateur d'autoriser une action de Claude Code.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tool_name": { "type": "string" },
                "input": { "type": "object" },
                "tool_use_id": { "type": "string" }
            },
            "required": ["tool_name", "input"]
        }
    })
}

fn rpc_result(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn rpc_error(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

/// Traite un message JSON-RPC. `None` : notification, rien à renvoyer (HTTP 202).
pub fn handle(body: &str, tools: &[Value], call: impl FnOnce(&str, Value) -> ToolOutcome) -> Option<String> {
    let Ok(msg) = serde_json::from_str::<Value>(body) else {
        return Some(rpc_error(&Value::Null, -32700, "JSON invalide"));
    };
    let method = msg["method"].as_str().unwrap_or_default();
    let Some(id) = msg.get("id").cloned() else { return None };
    let params = &msg["params"];
    Some(match method {
        "initialize" => rpc_result(
            &id,
            json!({
                "protocolVersion": params["protocolVersion"].as_str().unwrap_or(DEFAULT_PROTOCOL),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "nozbar", "version": env!("CARGO_PKG_VERSION") }
            }),
        ),
        "ping" => rpc_result(&id, json!({})),
        "tools/list" => {
            let mut list = tools.to_vec();
            list.push(approve_tool());
            rpc_result(&id, json!({ "tools": list }))
        }
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let out = call(name, args);
            rpc_result(&id, json!({ "content": [{ "type": "text", "text": out.text }], "isError": out.is_error }))
        }
        _ => rpc_error(&id, -32601, &format!("Méthode inconnue : {method}")),
    })
}

/// Comparaison en temps constant : le jeton ne doit pas fuiter par la durée de la vérification.
pub fn authorized(header: Option<&str>, token: &str) -> bool {
    let Some(given) = header.and_then(|h| h.strip_prefix("Bearer ")) else { return false };
    given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Prévient l'interface d'un appel d'outil : (id, nom, arguments).
pub type OnCall = Box<dyn Fn(u64, &str, &Value) + Send + Sync>;

pub struct McpServer {
    pub port: u16,
    pub token: String,
    tools: Mutex<Vec<Value>>,
    pending: Mutex<HashMap<u64, mpsc::Sender<ToolOutcome>>>,
    next_id: AtomicU64,
    on_call: OnCall,
}

impl McpServer {
    pub fn start(on_call: OnCall) -> Result<Arc<McpServer>, String> {
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("adresse MCP inconnue")?;
        let mcp = Arc::new(McpServer {
            port,
            token: random_token()?,
            tools: Mutex::new(Vec::new()),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            on_call,
        });
        let me = mcp.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                // Une confirmation peut durer : chaque requête a son propre fil.
                let me = me.clone();
                std::thread::spawn(move || me.serve(request));
            }
        });
        Ok(mcp)
    }

    /// Configuration à passer à `claude --mcp-config`.
    pub fn config_json(&self) -> String {
        json!({
            "mcpServers": {
                "nozbar": {
                    "type": "http",
                    "url": format!("http://127.0.0.1:{}/mcp", self.port),
                    "headers": { "Authorization": format!("Bearer {}", self.token) }
                }
            }
        })
        .to_string()
    }

    pub fn set_tools(&self, tools: Vec<Value>) {
        *self.tools.lock().unwrap() = tools;
    }

    pub fn reply(&self, id: u64, outcome: ToolOutcome) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(outcome);
        }
    }

    fn relay(&self, name: &str, args: Value) -> ToolOutcome {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        (self.on_call)(id, name, &args);
        let outcome = rx.recv_timeout(CALL_TIMEOUT).unwrap_or(ToolOutcome {
            text: "NozBar n'a pas répondu à temps".into(),
            is_error: true,
        });
        self.pending.lock().unwrap().remove(&id);
        outcome
    }

    fn serve(&self, mut request: tiny_http::Request) {
        use tiny_http::{Header, Method, Response};
        let status = |code: u16| Response::from_string("").with_status_code(code);
        if !request.url().starts_with("/mcp") {
            let _ = request.respond(status(404));
            return;
        }
        let auth = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("Authorization"))
            .map(|h| h.value.as_str().to_string());
        if !authorized(auth.as_deref(), &self.token) {
            let _ = request.respond(status(401));
            return;
        }
        if *request.method() != Method::Post {
            let _ = request.respond(status(405));
            return;
        }
        let mut body = String::new();
        if request.as_reader().read_to_string(&mut body).is_err() {
            let _ = request.respond(status(400));
            return;
        }
        let tools = self.tools.lock().unwrap().clone();
        match handle(&body, &tools, |name, args| self.relay(name, args)) {
            Some(json) => {
                let header = Header::from_bytes("Content-Type", "application/json").unwrap();
                let _ = request.respond(Response::from_string(json).with_header(header));
            }
            None => {
                let _ = request.respond(status(202));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn tools() -> Vec<Value> {
        vec![json!({"name": "get_weather", "description": "Météo", "inputSchema": {"type": "object"}})]
    }

    fn reply(body: Value, call: impl FnOnce(&str, Value) -> ToolOutcome) -> Value {
        serde_json::from_str(&handle(&body.to_string(), &tools(), call).expect("réponse attendue")).unwrap()
    }

    fn no_call(_: &str, _: Value) -> ToolOutcome {
        panic!("aucun outil ne devait être appelé")
    }

    #[test]
    fn initialize_echoes_the_protocol_version() {
        let r = reply(
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}),
            no_call,
        );
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert!(r["result"]["capabilities"]["tools"].is_object());
        assert_eq!(r["result"]["serverInfo"]["name"], "nozbar");
    }

    #[test]
    fn lists_nozbar_tools_and_the_permission_tool() {
        let r = reply(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}), no_call);
        let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["get_weather", "approve"]);
    }

    #[test]
    fn relays_tool_calls() {
        let r = reply(
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_weather", "arguments": {"city": "Lyon"}}}),
            |name, args| {
                assert_eq!(name, "get_weather");
                assert_eq!(args["city"], "Lyon");
                ToolOutcome { text: "Lyon : 12 °C".into(), is_error: false }
            },
        );
        assert_eq!(r["result"]["content"][0]["type"], "text");
        assert_eq!(r["result"]["content"][0]["text"], "Lyon : 12 °C");
        assert_eq!(r["result"]["isError"], false);
    }

    #[test]
    fn notifications_get_no_body() {
        let body = json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string();
        assert!(handle(&body, &tools(), no_call).is_none());
    }

    #[test]
    fn unknown_methods_and_garbage_are_errors() {
        let r = reply(json!({"jsonrpc": "2.0", "id": 4, "method": "resources/list"}), no_call);
        assert_eq!(r["error"]["code"], -32601);
        let garbage: Value = serde_json::from_str(&handle("pas du json", &tools(), no_call).unwrap()).unwrap();
        assert_eq!(garbage["error"]["code"], -32700);
    }

    #[test]
    fn checks_the_bearer_token() {
        assert!(authorized(Some("Bearer secret"), "secret"));
        assert!(!authorized(Some("Bearer autre"), "secret"));
        assert!(!authorized(Some("secret"), "secret"));
        assert!(!authorized(None, "secret"));
    }
}
