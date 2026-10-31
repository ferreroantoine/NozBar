# Expert Claude Code (abonnement) et pont MCP — design

Date : 2026-10-31

## Intention

L'utilisateur veut que l'expert de NozBar passe par **son abonnement Claude** plutôt que par une clé API
payante. NozBar pilote donc le binaire officiel Claude Code (`claude -p`), connecté par la procédure
d'Anthropic ; NozBar ne manipule jamais les identifiants. Les conditions Anthropic autorisent un
utilisateur à se connecter au binaire Claude Code non modifié avec son propre abonnement.

**Succès** = une demande complexe dans la bulle est traitée par Claude Code (Sonnet, ou Opus sur demande),
qui peut utiliser les outils NozBar (questions à boutons, confirmations, météo, fichiers…) et demande
dans la bulle avant toute commande système ou écriture hors de son dossier.

## Décisions prises avec l'utilisateur

| Sujet | Décision |
|---|---|
| Accès | Claude Code via abonnement (pilote API conservé en secours) |
| Modèle | Sonnet par défaut ; `!!` ou « réfléchis très bien » → Opus |
| Outils NozBar pour Claude Code | Oui, via un serveur MCP hébergé par NozBar |
| Construction | Approche A : Rust lance `claude -p` et héberge le serveur MCP |
| Permissions | Sans demander : lecture, web, écriture dans `Documents\NozBar`, outils NozBar. Avec confirmation dans la bulle : commandes système, écriture ailleurs |

## Faits vérifiés sur la machine (Claude Code 2.1.310)

- Exécutable : `%USERPROFILE%\.local\bin\claude.exe` (absent du PATH).
- `claude auth status` renvoie du JSON avec `loggedIn`. Hors de l'environnement Clyde : `loggedIn: false`
  → l'utilisateur doit se connecter une fois.
- `--output-format stream-json --verbose --include-partial-messages` : lignes JSON ; texte dans
  `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":…}}}` ;
  messages complets `{"type":"assistant","message":{"content":[…]}}` ; fin
  `{"type":"result","subtype":"success","is_error":false,"result":…,"session_id":…}`.
- Le `session_id` renvoyé peut différer de `--session-id` : on reprend toujours celui des événements.
- `--bare` n'utilise pas l'abonnement : interdit ici.

## Architecture

```
Bulle ─ Conversation ─ ClaudeCodeProvider (TS) ─invoke─▶ claude_code.rs ─spawn─▶ claude.exe -p
                                ▲                                                   │
                                │ événements mcp:call / mcp_reply                   │ HTTP JSON-RPC
                                └──────────────────── mcp.rs (127.0.0.1, jeton) ◀───┘
```

### Rust
| Fichier | Rôle |
|---|---|
| `mcp.rs` | Serveur MCP minimal (`tiny_http`) sur `127.0.0.1:<port aléatoire>/mcp`, jeton `Bearer` aléatoire. Gère `initialize`, `notifications/*` (202), `tools/list`, `tools/call`, `ping` ; GET → 405. Les appels d'outils sont relayés à l'interface (événement `mcp:call {id,name,args}`), réponse via la commande `mcp_reply(id, text, is_error)` ; un fil par requête. Fonction pure `handle(body, tools) -> Reply` testée. |
| `claude_code.rs` | Trouve `claude.exe` ; `status()` via `claude auth status` ; prépare `Documents\NozBar` (+ `CLAUDE.md`) ; `build_args()` pur et testé ; lance le processus (prompt sur stdin, `CREATE_NO_WINDOW`, variables `CLAUDECODE`/`CLAUDE_CODE_*`/`CLAUDE_AGENT_SDK_*`/`CLAUDE_PID` retirées), relaie chaque ligne via un `Channel` Tauri ; `cancel()` = `taskkill /T /F`. |

Arguments : `-p --output-format stream-json --verbose --include-partial-messages --model <sonnet|opus>
[--resume <id>] --strict-mcp-config --mcp-config <json> --permission-prompt-tool mcp__nozbar__approve
--permission-mode acceptEdits --allowedTools Read,Glob,Grep,WebSearch,WebFetch,mcp__nozbar
--append-system-prompt <consignes NozBar>`.

### TypeScript
| Fichier | Rôle |
|---|---|
| `lib/providers/claude-code-stream.ts` | Lecteur pur du flux : ligne → `{kind:"text"}`, `{kind:"tool", name, input}`, `{kind:"result", text, sessionId, error?}`. |
| `lib/providers/claude-code.ts` | `ClaudeCodeProvider` (interface `ClaudeLike`) : session par bulle, modèle, tour actif (ui, signal) exposé au pont MCP, annulation. |
| `lib/mcp-bridge.ts` | Écoute `mcp:call` ; `approve` → `ui.confirm` → `{"behavior":"allow","updatedInput":…}` / `{"behavior":"deny",…}` ; autres → `executeTool` dans le tour actif ; publie le catalogue (`mcp_set_tools`). |
| `lib/conversation.ts` | `forcedExpert` reconnaît aussi `!!` / « réfléchis très bien » → Opus. |
| `App.tsx` | Choix de l'expert (Claude Code connecté > API > aucun) ; badge Sonnet/Opus ; messages d'installation/connexion. |

Outils exposés à Claude Code : le catalogue NozBar sauf `web_search` et `ask_expert` (Claude Code a sa
propre recherche web), plus `approve`.

## Erreurs
| Cas | Message |
|---|---|
| Claude Code absent | Commande d'installation officielle |
| Non connecté | « Ouvrez un terminal, lancez `claude` et connectez-vous. » |
| Limite d'abonnement | « Limite de votre abonnement Claude atteinte… » (résultat en erreur / `rate_limit`) |
| Processus en échec | Dernière erreur lue sur stderr |
| Bulle fermée | Processus tué, tour annulé |

## Tests
- Rust : `build_args`, routage JSON-RPC, refus sans jeton, nettoyage d'environnement.
- TS : lecteur de flux (lignes réelles capturées), provider avec faux `native`, pont MCP (approve → confirm).
- Réel (test Rust ignoré par défaut) : `claude -p` contre le serveur MCP autonome : appel d'un outil
  NozBar, et format réel de la demande de permission.
