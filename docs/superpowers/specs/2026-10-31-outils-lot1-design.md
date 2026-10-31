# Lot 1 d'outils et expert Claude — design

Date : 2026-10-31

## Contexte et intention

NozBar répondait en ~20 s : `gemini-flash-latest` renvoyait 503 (saturé) après ~5 s, réessayé avant
de basculer sur Flash-Lite. Corrigé (commit `11cd496`) : Flash-Lite en premier, repli immédiat.
Mesures après correction : question simple 0,8 s, transcription 1,2 s.

Restent deux manques constatés à l'usage :

- « quelle météo à Lyon demain ? » → échec : la météo passe par la recherche Google, dont le quota
  de la clé Gemini est épuisé (429) ;
- « ouvre horizon launcher, il est dans mes téléchargements » → échec : aucun outil fichier.

Et une limite : Flash-Lite est rapide mais faible sur les demandes complexes (« où cette appli
fait ça ? »). L'utilisateur veut qu'il passe la main à un modèle plus fort, Claude Sonnet.

**Succès** = la météo répond sans dépendre de Google Search ; un fichier téléchargé se retrouve et
s'ouvre par son nom approximatif ; une demande complexe est traitée par Sonnet sans ralentir les
demandes simples.

## Décisions prises avec l'utilisateur

| Sujet | Décision |
|---|---|
| Architecture | Catalogue d'outils commun + deux pilotes (Gemini, Claude) + un chef d'orchestre. Agent SDK écarté pour l'instant (futur outil `run_agent`). |
| Expert | Claude Sonnet 5.5 (`claude-sonnet-5-5`), clé API Anthropic de l'utilisateur. |
| Durée de l'expert | Une fois appelé, Sonnet garde la main jusqu'à la fermeture de la bulle. |
| Programmes | Toujours une confirmation avant de lancer un programme ; documents, images, vidéos s'ouvrent directement. |
| Position météo | Localisation Windows ; si indisponible, l'IA demande la ville. |

## Périmètre du lot 1

Outils : `get_weather`, `find_file`, `open_file`, `ask_user`, `ask_expert`.
Hors périmètre : cartes visuelles (météo, fiche Wikipedia), `screenshot`, `clipboard`, le reste du
catalogue. La météo répond en texte dans ce lot ; ses données sont déjà structurées pour la carte
du lot 2.

## Architecture

```
App.tsx ─ routeur local (inchangé) ─ Conversation
                                       ├─ GeminiProvider (Flash-Lite, défaut)
                                       └─ ClaudeProvider (Sonnet, après ask_expert)
                                              ↓ mêmes outils
                                       tools/ ─ native (Rust) / Open-Meteo / Ui (questions)
```

### Fichiers TypeScript

| Fichier | Rôle |
|---|---|
| `src/lib/conversation.ts` (nouveau) | Chef d'orchestre. `send(text, ui, signal)`, `reset()`, `transcribe()`, `search()`. Garde le pilote actif ; bascule sur Claude quand Gemini demande `ask_expert` ou quand le message force l'expert ; `reset()` revient à Gemini. |
| `src/lib/providers/gemini.ts` | Ex-`assistant.ts` (boucle d'outils, repli de modèles, recherche, transcription). Les outils lui arrivent via `parametersJsonSchema`. Sur un appel `ask_expert`, il arrête sa boucle et renvoie une demande de passage de main. |
| `src/lib/providers/claude.ts` (nouveau) | Pilote Sonnet : `@anthropic-ai/sdk`, streaming, boucle d'outils manuelle, recherche web serveur `web_search_20260209`, repli serveur `fallbacks: "default"`. |
| `src/lib/tools/index.ts` | Catalogue, `executeTool`, `toolStatus`, conversion vers les formats Gemini et Claude. |
| `src/lib/tools/types.ts` | Types partagés (`Tool`, `Ui`, `ToolContext`, `ToolResult`, `Args`, `Source`) et utilitaires `str`, `int`. |
| `src/lib/tools/system.ts` | Les 7 outils existants, déplacés tels quels. |
| `src/lib/tools/files.ts` | `find_file`, `open_file`, détection des programmes. |
| `src/lib/tools/weather.ts` | `get_weather` (Open-Meteo), table des codes météo WMO → français. |
| `src/lib/tools/dialog.ts` | `ask_user`. |
| `src/lib/tools/expert.ts` | `ask_expert` (déclaration seule : la Conversation l'intercepte). |

`src/lib/tools.ts` et `src/lib/assistant.ts` disparaissent (contenu déplacé).

### Fichiers Rust

| Fichier | Rôle |
|---|---|
| `src-tauri/src/fuzzy.rs` (nouveau) | `normalize` et `score` extraits de `apps.rs`, partagés avec `files.rs`. |
| `src-tauri/src/files.rs` (nouveau) | `find_files(query, kind)` : parcours de Téléchargements, Bureau, Documents (profondeur ≤ 3, dossiers cachés/`node_modules`/`.git` ignorés, 20 000 entrées max), score sur le nom sans extension, 5 meilleurs résultats triés par score puis date de modification. `open_file(path)` : vérifie que le fichier existe puis l'ouvre via `shell_open`. |
| `src-tauri/src/location.rs` (nouveau) | `locate()` : `Windows.Devices.Geolocation.Geolocator`, exécuté hors du thread principal ; erreur explicite si l'accès est refusé. |
| `src-tauri/src/secrets.rs` | Paramétré par fournisseur : comptes `gemini_api_key` et `anthropic_api_key`. |
| `src-tauri/src/lib.rs` | Nouvelles commandes `find_files`, `open_file`, `get_location` ; `get_api_key`/`set_api_key` prennent un `provider`. |

### Contrat entre outils et interface

`Ui` gagne :

- `ask(question: string, choices: string[], allowText: boolean): Promise<string | null>` — `null` si
  l'utilisateur annule ;
- `confirm(message: string, action: string): Promise<boolean>` ;
- `expert(): void` — affiche le badge « Sonnet ».

`ToolContext` gagne `signal: AbortSignal` (fetch Open-Meteo annulable).

## Outils du lot 1

### `get_weather`
- Paramètres : `city?` (string), `days_ahead?` (0 = aujourd'hui … 6).
- Ville donnée → géocodage Open-Meteo (`geocoding-api.open-meteo.com/v1/search?name=…&count=1&language=fr`).
  Sinon → `native.getLocation()` ; libellé « votre position ».
- Prévision : `api.open-meteo.com/v1/forecast` avec `current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m`
  et `daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`,
  `timezone=auto`, `forecast_days=7`.
- Résultat : `{ place, current: {temp, feels, label, wind}, day: {date, label, min, max, rain} }` +
  phrase courte. Codes WMO traduits en français.
- Localisation refusée ou ville introuvable → `ok: false` avec un message qui invite l'IA à
  demander la ville (`ask_user` ou question directe).

### `find_file`
- Paramètres : `query` (string), `kind?` (`any` | `program` | `document`).
- Renvoie jusqu'à 5 fichiers `{name, path, folder, modified}`. Aucun → `ok: false`.
- Consigne dans la description : si plusieurs résultats plausibles, utiliser `ask_user`.

### `open_file`
- Paramètre : `path` (chemin complet renvoyé par `find_file`).
- Extension de programme (`exe msi msix appx bat cmd ps1 vbs js jse wsf scr com lnk reg jar hta cpl appref-ms`)
  → `ui.confirm("Lancer HorizonLauncher.exe ?", "Lancer")`. Refus → `ok: false`, « Annulé ».
- Autres fichiers → ouverture directe.

### `ask_user`
- Paramètres : `question`, `choices` (2 à 6), `allow_text?`.
- Renvoie le choix (ou le texte tapé). Annulation → `ok: false`, « L'utilisateur n'a pas répondu ».

### `ask_expert`
- Paramètre : `task` (reformulation de ce que Sonnet doit faire).
- Gemini uniquement (non déclaré à Claude).
- La Conversation arrête Gemini, affiche « Je passe la main à Sonnet… », puis envoie à Claude :
  l'échange précédent (messages utilisateur et réponses texte) + la demande en cours + `task`.
- Pas de clé Anthropic → l'outil renvoie une erreur ; Lite répond lui-même et la bulle indique
  `/clé-claude`.
- Forcer l'expert : message commençant par `!`, « mode expert » ou « réfléchis bien » (le préfixe
  `!` est retiré avant l'envoi).
- Critères pour Lite (pré-prompt) : raisonnement en plusieurs étapes, explication détaillée,
  fonctionnement d'un logiciel précis, code, rédaction longue, ou échec d'une première tentative.

## Pilote Claude

- Client : `new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 60_000 })`.
  La clé vient du Gestionnaire d'identification ; l'app est locale, pas de serveur où la cacher.
- Requête : `client.beta.messages.stream` avec `model: "claude-sonnet-5-5"`, `max_tokens: 16000`,
  `output_config: { effort: "medium" }`, `betas: ["server-side-fallback-2026-07-01"]`,
  `fallbacks: "default"`, outils clients (avec `eager_input_streaming: true`) + `web_search_20260209`
  (`max_uses: 3`).
- Texte streamé via l'événement `text` ; `finalMessage()` ajouté tel quel à l'historique
  (blocs de réflexion compris).
- `stop_reason` : `tool_use` → exécuter tous les outils, renvoyer tous les `tool_result` dans un seul
  message ; `pause_turn` → relancer ; `refusal` → message d'erreur ; `max_tokens` → garder le
  texte reçu.
- Entrées d'outils validées par les outils eux-mêmes (`str`, `int`) ; entrée illisible → `tool_result`
  en erreur.
- 8 étapes maximum.

## Interface (App.tsx)

- **Questions** (`ask_user`) : la question et des boutons numérotés sous la réponse ; touches 1-6,
  clic, ou texte libre tapé dans la barre si `allow_text`. Échap annule la question (au lieu de
  fermer la bulle).
- **Confirmation** : « Lancer HorizonLauncher.exe ? » avec deux boutons ; Entrée = lancer,
  Échap = annuler.
- **Badge Sonnet** : petite étiquette dans la barre tant que Sonnet a la main.
- **Clés** : `/clé` (Gemini, inchangé) et `/clé-claude` (Anthropic). L'état `setup` devient
  `null | "gemini" | "anthropic"`.
- Fermer la bulle pendant une question ou une confirmation l'annule.
- CSP : ajout de `https://api.anthropic.com`, `https://api.open-meteo.com`,
  `https://geocoding-api.open-meteo.com`.

## Erreurs

| Cas | Comportement |
|---|---|
| Clé Claude absente/refusée | « Clé Claude refusée. Tapez /clé-claude pour la changer. » |
| Claude 429 / 529 / 5xx | Une relance SDK, puis message clair (« Claude est saturé… »). |
| `refusal` | « Claude a refusé cette demande. » |
| Open-Meteo injoignable | Outil en erreur ; l'IA le dit. |
| Localisation refusée | Outil en erreur avec invitation à demander la ville. |
| Fichier introuvable | Outil en erreur ; l'IA peut reformuler ou demander. |

## Tests

- **Rust** (`cargo test`) : correspondance approximative des fichiers (« horzon launcher » →
  `HorizonLauncher.exe`), détection des dossiers ignorés.
- **TypeScript** (Vitest, nouveau) : conversion des schémas Gemini/Claude ; détection des
  programmes ; météo (fetch simulé) : géocodage, choix du jour, codes WMO ; Conversation : passage
  de main sur `ask_expert`, maintien de Sonnet jusqu'au `reset`, préfixes de forçage.
- **Réel** : script de vérification Gemini (`scripts/verify-assistant.mjs`, adapté) ; test manuel
  dans l'app avec la clé Claude.
