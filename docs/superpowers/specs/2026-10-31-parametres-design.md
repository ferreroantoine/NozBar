# Paramètres de NozBar — design

Date : 2026-10-31

## Intention
Trop de confirmations pour les commandes de Claude Code. L'utilisateur veut une fenêtre de paramètres :
connexion des comptes (Gemini, Claude) et règles d'autorisation par catégorie (Toujours / Demander / Refuser).

## Décisions
| Sujet | Décision |
|---|---|
| Granularité | Par catégorie (pas par commande) |
| Modèle de l'expert | Pas de réglage : Lite choisit |
| Fenêtre | Fenêtre Tauri séparée « settings » (même page, `#settings`), ouverte par l'icône de la barre des tâches ou `/paramètres` |
| Stockage | `settings.json` dans le dossier de configuration de l'app ; les clés restent dans le Gestionnaire d'identification |

## Catégories et valeurs par défaut
| Clé | Libellé | Outils Claude Code | Défaut |
|---|---|---|---|
| `web_search` | Recherche web | WebSearch | always |
| `web_fetch` | Lire des pages web | WebFetch | always |
| `read_outside` | Lire des fichiers hors de son dossier | Read, Glob, Grep | ask |
| `write_outside` | Écrire hors de son dossier | Write, Edit, NotebookEdit | ask |
| `commands` | Commandes système | Bash, PowerShell | ask |
| `programs` | Lancer des programmes | (outil NozBar open_file / open_app sur fichier) | ask |

## Application des règles
- **always** → outils ajoutés à `--allowedTools` (avec `mcp__nozbar`) au lancement de Claude Code.
- **ask / never** → la demande arrive à l'outil `approve` ; le pont MCP lit la règle : `never` refuse sans
  demander, `ask` affiche « Autoriser · Toujours autoriser · Refuser ». « Toujours autoriser » enregistre
  `always` pour la catégorie. (Passer par `approve` pour `never` évite d'interdire aussi les écritures dans
  le dossier de Claude, qu'un `--disallowedTools Write` bloquerait.)
- `programs` : appliqué par NozBar à l'ouverture d'un programme (open_file, open_app vers un fichier).
- Avertissement affiché pour `commands = always` (pages piégées).

## Comptes
- Gemini : état, remplacement, suppression.
- Claude Code : état (`claude auth status`), bouton « Connecter » (`claude auth login` dans une console
  visible), « Se déconnecter » (`claude auth logout`), actualiser.
- Clé API Claude (secours) : état, remplacement, suppression.

## Tests
- Rust : valeurs par défaut, lecture d'un fichier absent ou corrompu → défauts, liste `--allowedTools` selon les règles.
- TS : catégorie d'un outil, `approve` selon la règle (always/never/ask + « Toujours »), lancement de programme selon `programs`.
