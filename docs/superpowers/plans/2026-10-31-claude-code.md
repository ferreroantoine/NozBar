# Expert Claude Code — plan de réalisation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire de Claude Code (abonnement) l'expert de NozBar, avec les outils NozBar via un serveur MCP local et les permissions confirmées dans la bulle.

**Architecture:** `mcp.rs` (serveur JSON-RPC sur 127.0.0.1) et `claude_code.rs` (lancement de `claude -p`, flux relayé par `Channel`) côté Rust ; lecteur de flux, `ClaudeCodeProvider` et pont MCP côté TypeScript.

**Tech Stack:** Rust (`tiny_http`, `getrandom`), Tauri 2 `ipc::Channel`, TypeScript, Vitest, Claude Code 2.1.310.

**Spec:** `docs/superpowers/specs/2026-10-31-claude-code-design.md`

## Global Constraints
- Jamais `--bare` ; jamais de lecture/stockage des identifiants Claude par NozBar.
- Serveur MCP lié à `127.0.0.1` uniquement, jeton aléatoire de 32 octets, vérifié à chaque requête.
- Outils exposés : catalogue NozBar sans `web_search` ni `ask_expert`, plus `approve`.
- Modèles : alias `sonnet` (défaut) et `opus`.
- Textes visibles en français.

## Review Focus
1. Requête MCP sans jeton ou avec un mauvais jeton → 401, aucun outil exécuté. Test : Tâche 1.
2. Appel MCP alors qu'aucun tour n'est actif (bulle fermée) → erreur d'outil, pas de question fantôme. Test : Tâche 4.
3. Bulle fermée pendant que Claude Code travaille → processus et sous-processus tués. Test : Tâche 2 (arguments `taskkill /T`), vérification réelle Tâche 6.
4. Ligne de flux illisible ou inconnue → ignorée sans casser le tour. Test : Tâche 3.
5. Résultat `is_error` (non connecté, limite atteinte) → message français clair. Test : Tâche 3.

---

### Task 1: Serveur MCP minimal (Rust)
**Files:** Create `src-tauri/src/mcp.rs` ; Modify `Cargo.toml` (`tiny_http`, `getrandom`), `lib.rs` (démarrage, commandes `mcp_set_tools`, `mcp_reply`).
**Produces:** `pub fn handle(body: &str, tools: &[Value], call: impl FnOnce(&str, Value) -> ToolOutcome) -> Option<String>` (None = notification → 202) ; `McpServer { port, token }` ; événement `mcp:call {id, name, args}` ; commandes `mcp_set_tools(tools: Vec<Value>)`, `mcp_reply(id: u64, text: String, is_error: bool)`, `mcp_info() -> {port, token}`.
- [ ] Tests : `initialize` renvoie `protocolVersion` du client et `capabilities.tools` ; `tools/list` renvoie les outils + `approve` ; `tools/call` renvoie `content[0].text` et `isError` ; notification → None ; méthode inconnue → erreur -32601 ; `authorized("Bearer x", "x")` vrai, autre faux.
- [ ] RED, implémentation, GREEN, commit.

### Task 2: Lancement de Claude Code (Rust)
**Files:** Create `src-tauri/src/claude_code.rs` ; Modify `lib.rs` (commandes `claude_code_status`, `claude_code_send`, `claude_code_cancel`).
**Produces:** `build_args(model: &str, resume: Option<&str>, mcp_config: &str) -> Vec<String>` ; `status() -> {installed, logged_in}` ; `claude_code_send(prompt, model, resume, on_line: Channel<String>) -> Result<(), String>` ; `claude_code_cancel()`.
- [ ] Tests : `build_args` contient `-p`, `stream-json`, `--model opus`, `--resume X` seulement si fourni, `--permission-prompt-tool mcp__nozbar__approve`, jamais `--bare` ; `is_inherited_claude_var("CLAUDECODE")` vrai, `CLAUDE_CONFIG_DIR` faux ; `kill_args(pid)` = `["/PID", pid, "/T", "/F"]`.
- [ ] RED, implémentation, GREEN, commit.

### Task 3: Lecteur de flux et provider (TS)
**Files:** Create `src/lib/providers/claude-code-stream.ts`, `claude-code.ts`, tests ; Modify `native.ts`.
**Produces:** `parseLine(line: string): StreamItem | null` ; `class ClaudeCodeProvider implements ClaudeLike { model: "sonnet"|"opus"; active: {ui, signal} | null; send(text, ui, signal, context?); reset() }`.
- [ ] Tests : lignes réelles → texte "OK" et résultat avec `sessionId` ; `assistant` avec `tool_use` → `{kind:"tool"}` ; ligne invalide → null ; résultat `is_error` → erreur française ; 2e envoi utilise `--resume` (sessionId du 1er) ; `reset()` oublie la session ; annulation → `native.claudeCodeCancel`.
- [ ] RED, implémentation, GREEN, commit.

### Task 4: Pont MCP côté interface
**Files:** Create `src/lib/mcp-bridge.ts`, test ; Modify `native.ts`.
**Produces:** `handleMcpCall(call, provider): Promise<{text, isError}>` ; `mcpToolList(): Tool[]` ; `startMcpBridge(getProvider)`.
- [ ] Tests : `approve` Bash → `ui.confirm("Claude veut exécuter : dir", "Autoriser")` → allow avec `updatedInput` ; refus → deny ; outil NozBar → `executeTool` ; aucun tour actif → `isError` ; liste sans `web_search`/`ask_expert`.
- [ ] RED, implémentation, GREEN, commit.

### Task 5: Branchement dans l'app
**Files:** Modify `conversation.ts` (`forcedExpert` → `{text, opus}`), `App.tsx`, tests.
- [ ] Tests : `!!x` → opus ; « réfléchis très bien » → opus ; `!x` → sonnet.
- [ ] Choix de l'expert, badge modèle, messages statut, annulation à la fermeture. Commit.

### Task 6: Vérification réelle
- [ ] Test Rust ignoré : serveur MCP autonome + vrai `claude -p` : appel `get_time` factice, et capture de l'entrée de `approve` sur une commande Bash.
- [ ] Ajuster `approve` au format réel ; suites vertes ; commit.
