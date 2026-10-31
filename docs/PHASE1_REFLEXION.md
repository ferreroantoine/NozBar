# NozBar — Phase 1 : Réflexion et cadrage

> Assistant vocal et textuel pour Windows, style Siri / Gemini. Document de cadrage rédigé avant toute ligne de code.
> Date : 2026-10-30 · Cible : Windows 11 (Windows 10 22H2 en best-effort)

---

## 0. Synthèse des décisions recommandées

| Sujet | Recommandation | Alternative |
|---|---|---|
| Stack | **Tauri 2** (cœur Rust + WebView2) + front **Svelte ou React** | Electron si l'équipe ne veut que du JS ; WinUI 3 si 100 % natif |
| Raccourci | **`Alt+Espace`** par défaut, configurable. Appui court = mode texte, appui long = mode vocal (push-to-talk) | `Ctrl+Alt+Espace` en repli si conflit (PowerToys) |
| API raccourci | `RegisterHotKey` (Win32), **pas** de hook clavier bas niveau | `WH_KEYBOARD_LL` seulement si on veut un jour la double pression de Ctrl |
| Fenêtre | Overlay transparent pré-créé et caché, topmost, sans bordure, hors barre des tâches et hors Alt+Tab, effet **Acrylic** DWM | Fond assombri sans flou si le GPU est faible |
| Animations | CSS/WAAPI sur `transform` + `opacity` uniquement, ressorts (spring), orbe WebGL réactif au micro | — |
| Notifications | **Toasts natifs** pour l'asynchrone (bulle fermée) + **HUD overlay** maison pour le retour immédiat | — |
| LLM | **Couche d'abstraction multi-fournisseurs**. Gemini Flash pour le rapide, le pas cher et la recherche web (grounding Google) ; Claude Sonnet/Opus pour les commandes multi-étapes et les outils système | Un seul fournisseur au MVP |
| Voix | STT **Whisper local** (whisper.cpp) + VAD Silero ; TTS **Piper** local ou voix Windows | Gemini Live API (audio temps réel) si Gemini est le fournisseur par défaut |
| Routage | **Intentions locales d'abord** (« ouvre X », « volume 30 ») → LLM seulement si nécessaire | Tout envoyer au LLM (plus simple, mais plus lent et plus cher) |

Le point d'architecture le plus important : **aucune API LLM n'exécute de commande sur la machine**. Gemini comme Claude renvoient des *appels d'outils* (nom + arguments JSON). C'est NozBar qui les exécute en local. La question « Gemini ou Claude pour exécuter des commandes » revient donc à « lequel choisit et paramètre le mieux les outils », et la sécurité dépend entièrement de notre code.

---

## 1. Raccourci clavier global sous Windows

### 1.1 Les mécanismes disponibles

| Mécanisme | Fonctionnement | Avantages | Inconvénients |
|---|---|---|---|
| **`RegisterHotKey`** (Win32) | Le système envoie `WM_HOTKEY` à notre fenêtre | Simple, fiable, coût CPU nul, aucune alerte antivirus. Échoue proprement si la combinaison est déjà prise, ce qui permet de détecter les conflits | Pas d'événement au relâchement. Pas de combinaison à touche unique (double Ctrl…). La plupart des `Win+lettre` sont réservées par l'OS |
| **Hook bas niveau `WH_KEYBOARD_LL`** | Reçoit toutes les frappes du système | Tout est possible : double pression, maintien, touche Copilot, `Win+…` | Code à risque : si le callback dépasse le délai (`LowLevelHooksTimeout`), Windows retire le hook **sans prévenir**. Heuristiques antivirus de type keylogger. Ne reçoit pas les frappes destinées aux fenêtres élevées (UIPI) si NozBar n'est pas élevé |
| **Raw Input** | `WM_INPUT` avec `RIDEV_INPUTSINK` | Moins intrusif qu'un hook | Ne peut pas *consommer* la touche, donc l'application active la reçoit aussi |

Ce qu'utilisent les frameworks : `globalShortcut` d'Electron et `tauri-plugin-global-shortcut` (crate `global-hotkey`) reposent tous les deux sur `RegisterHotKey`.

### 1.2 Combinaisons candidates

| Combinaison | Statut | Verdict |
|---|---|---|
| `Win+Espace` | Réservée (changement de langue de saisie) | ❌ |
| `Win+S`, `Win+H`, `Win+C`… | Réservées par le shell (recherche, dictée, etc.) | ❌ |
| `Ctrl+Espace` | Conflits IME (asiatiques) et autocomplétion dans tous les IDE | ❌ |
| **`Alt+Espace`** | Ouvre normalement le menu système de la fenêtre active. **PowerToys Run** l'utilise déjà par défaut | ✅ Ergonomique (une main, proche de Spotlight `Cmd+Espace`). Désactive le menu système, ce qui est rarement gênant |
| `Ctrl+Alt+Espace` | Généralement libre | ✅ Bon repli |
| `Win+Alt+Espace` | Utilisée par la Command Palette de PowerToys | ⚠️ |
| Touche **Copilot** (claviers 2024+, envoie `Win+Shift+F23`) | Réaffectable dans *Paramètres > Personnalisation > Saisie*, mais seulement vers une application **packagée et signée** (MSIX) | 💡 Très « Siri », à prévoir en V2 avec le packaging MSIX |

### 1.3 Recommandation

- **`Alt+Espace` par défaut**, modifiable dans les réglages. Au premier lancement, si `RegisterHotKey` échoue, on bascule sur `Ctrl+Alt+Espace` et on prévient l'utilisateur.
- **Deux modes sur une seule touche, sans hook bas niveau** :
  - à la réception de `WM_HOTKEY` (enregistré avec `MOD_NOREPEAT`), on démarre un minuteur de 250 ms ;
  - on interroge `GetAsyncKeyState(VK_SPACE)` toutes les 15 ms environ ;
  - touche relâchée avant 250 ms : **mode texte** (focus sur le champ de saisie) ;
  - touche encore enfoncée : **mode vocal push-to-talk**, avec enregistrement jusqu'au relâchement.
  - Ce sondage ne dure que pendant l'appui, son coût est négligeable.
- **Toggle** : un nouvel appui sur le raccourci, ou `Échap`, ferme la bulle.

### 1.4 Points à valider par un prototype

- **Vol de focus** : Windows limite `SetForegroundWindow`. Le processus qui reçoit `WM_HOTKEY` y est normalement autorisé (le raccourci compte comme dernière entrée). À vérifier, avec en repli l'astuce `AttachThreadInput` ou un `SendInput` d'une touche neutre.
- **Applications élevées** (gestionnaire de tâches, installeurs) au premier plan : `RegisterHotKey` fonctionne, mais l'injection de texte ou de touches vers ces fenêtres non.
- **Jeux en plein écran exclusif** : le raccourci est reçu, mais l'overlay ne peut pas s'afficher par-dessus (voir §2.5).

---

## 2. Plein écran sans bordure, glassmorphism et animations

### 2.1 Choix du framework UI

| Critère | **Tauri 2** | Electron | WinUI 3 / .NET | WPF | Python/Qt |
|---|---|---|---|---|---|
| Glassmorphism du contenu | CSS `backdrop-filter` ✅ | ✅ | `AcrylicBrush` ✅ | Limité | Bricolage |
| Flou **du bureau** derrière la fenêtre | crate `window-vibrancy` : `apply_acrylic` ✅ | `backgroundMaterial: 'acrylic'` ✅ | `DesktopAcrylicController` ✅ | ❌ | ❌ |
| Fluidité des animations | Compositeur Chromium (WebView2) ✅ | ✅ | Composition API, excellente ✅ | Moyenne (rendu logiciel avec `AllowsTransparency`) | Moyenne |
| RAM au repos (ordre de grandeur) | ~40–80 Mo | ~150–300 Mo | ~50–100 Mo | ~60 Mo | ~80 Mo |
| Accès aux API Win32/WinRT | crate `windows` (Rust) ✅ | Modules natifs (N-API), plus pénible | Natif ✅ | Natif ✅ | `pywin32` |
| Typographie dynamique et rendu riche (markdown, cartes de résultats) | HTML/CSS, idéal ✅ | ✅ | XAML, plus verbeux | Verbeux | Moyen |
| Plugins prêts à l'emploi | global-shortcut, notification, autostart, single-instance, updater ✅ | Équivalents ✅ | À coder | À coder | À coder |

**Choix : Tauri 2.** On garde la liberté visuelle du web (glassmorphism, typographie, markdown, cartes) avec un cœur natif léger et performant (hooks, audio, exécution d'outils). Pour un assistant qui tourne en permanence, l'empreinte mémoire compte beaucoup. Electron reste un repli valable si le Rust est un frein.

### 2.2 La fenêtre « overlay »

Interprétation retenue du « plein écran sans bordure » : une **fenêtre transparente qui couvre tout le moniteur actif**, avec un voile sombre et flouté sur le bureau, et la **bulle de verre** au centre ou en bas. Cliquer en dehors de la bulle la ferme, comme Spotlight.

Propriétés de la fenêtre :
- `decorations: false`, `transparent: true`, `alwaysOnTop: true`, `skipTaskbar: true`, `resizable: false`, `shadow: false`.
- Style étendu `WS_EX_TOOLWINDOW` pour la cacher d'Alt+Tab.
- **Multi-écrans** : à chaque ouverture, on la place sur le moniteur qui contient le curseur (`MonitorFromPoint`), avec la prise en charge du DPI par moniteur (Per-Monitor v2, déjà géré par Tauri).
- **On ne passe pas en « vrai » plein écran** (`setFullscreen`). On dimensionne la fenêtre aux bornes du moniteur. Le vrai plein écran change le comportement de la barre des tâches et de DWM.
- ⚠️ Windows peut considérer une fenêtre topmost qui couvre tout le moniteur comme une **application plein écran**, ce qui active « Ne pas déranger en plein écran » et masque les toasts. C'est acceptable pendant que la bulle est ouverte, mais à confirmer. En repli, on laisse 1 px de marge.

### 2.3 Rendu du verre (glassmorphism)

Deux couches cumulées :
1. **Fond de fenêtre** : Acrylic DWM, qui floute le *vrai* bureau derrière. Mica ne convient pas : il n'échantillonne que le fond d'écran, pas les fenêtres situées derrière.
2. **Bulle** : rendue en CSS.
   ```css
   background: rgba(20, 20, 28, 0.55);
   backdrop-filter: blur(40px) saturate(160%);
   border: 1px solid rgba(255, 255, 255, 0.08);
   border-radius: 28px;
   box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);
   ```
   On ajoute un léger grain (bruit SVG, 2–3 % d'opacité) pour éviter l'aspect « plastique » et le banding.

Risque : un Acrylic plein écran coûte du GPU, et `window-vibrancy` est connu pour ramer **pendant les redimensionnements**. Comme notre fenêtre ne bouge jamais, le risque est faible. On prévoit un mode « performance » sans Acrylic (simple voile `rgba(0,0,0,0.6)`).

### 2.4 Animations et transitions fluides

- **Fenêtre pré-créée au démarrage, puis cachée.** C'est la clé d'une ouverture en moins de 100 ms. Créer une WebView à la volée prend 300 à 800 ms, avec un flash blanc.
- Séquence d'**ouverture** :
  1. on positionne la fenêtre (encore invisible, opacité 0) ;
  2. `show()` puis `focus()` ;
  3. animation CSS : voile 0 → 1 en 180 ms, bulle `scale(0.92) translateY(12px)` → `scale(1)` avec un ressort (stiffness ~300, damping ~28).
- **Fermeture** : animation inverse en 140 ms, puis `hide()`. La fermeture doit être plus rapide que l'ouverture.
- On n'anime **que `transform` et `opacity`**, qui sont gérés par le compositeur. Jamais `width`, `height`, `top` ou `font-size` directement. Pour les changements de taille de la bulle, on utilise la technique **FLIP**.
- Bibliothèque : **Motion** (ex-Framer Motion / Motion One) pour les ressorts, ou les transitions natives de Svelte.
- **Orbe / onde « Siri »** : un shader WebGL (ou Canvas 2D) piloté par l'amplitude RMS du micro, que le cœur Rust envoie environ 30 fois par seconde. L'état modifie couleur et rythme : écoute = ondulation réactive, réflexion = rotation lente, réponse = pulsation douce.
- **Accessibilité** : on respecte `prefers-reduced-motion`, que WebView2 relie au réglage Windows *Effets d'animation*.

### 2.5 Typographie dynamique

- Police : **Segoe UI Variable**. Elle est native sur Windows 11, variable (graisse et tailles optiques Display/Text) et ne demande aucun téléchargement. Repli : Inter Variable.
- Taille selon le contenu :

  | Contenu | Taille | Graisse |
  |---|---|---|
  | Réponse courte (< 60 caractères, ex. « Il est 14 h 32 ») | 40–48 px | 600 (Display) |
  | Réponse moyenne (< 300 caractères) | 24–28 px | 500 |
  | Réponse longue, markdown, listes | 16–18 px | 400 (Text) |
  | Transcription en direct de la voix | 28 px, blanc à 70 % | 500 |
  | **État de réflexion (texte gris)** | 18–20 px, `rgba(255,255,255,0.55)` + effet *shimmer* | 500 |

- On calcule la taille **une fois par palier**, pas à chaque token : pendant le streaming, le texte ne doit pas « sauter » de taille sans arrêt. On change de palier au plus 1 ou 2 fois par réponse, avec un fondu enchaîné.
- **Contraste** : blanc sur fond sombre ≥ 12:1. Le gris de réflexion doit rester ≥ 4.5:1 (WCAG AA). On vérifie sur le fond le plus clair possible, celui où l'Acrylic laisse passer un bureau blanc.

### 2.6 Limites connues

- **Jeux et vidéos en plein écran exclusif** (DirectX exclusive) : aucune fenêtre ne peut s'afficher par-dessus. Dans ce cas, on détecte l'état avec `SHQueryUserNotificationState` (valeur `QUNS_RUNNING_D3D_FULL_SCREEN`) et on répond par la **voix seule**, ou par un toast. Les jeux en « plein écran fenêtré », la norme aujourd'hui, ne posent pas de problème.

---

## 3. Notifications push et overlays système

### 3.1 Trois besoins distincts

| Besoin | Exemple | Solution |
|---|---|---|
| **Retour immédiat** pendant que la bulle est ouverte | « Ouverture de Spotify… » | Directement dans la bulle (texte gris) |
| **HUD éphémère** quand la bulle est fermée ou se ferme | « Volume 40 % », « Spotify ouvert ✓ » | **Fenêtre overlay maison** : petite pilule de verre en haut au centre, 1,5 s |
| **Résultat asynchrone ou différé** | Minuteur terminé, rappel, longue tâche finie | **Toast natif Windows** (Centre de notifications) |

### 3.2 HUD overlay maison

- Seconde fenêtre Tauri, elle aussi pré-créée : transparente, topmost.
- Styles `WS_EX_LAYERED | WS_EX_TRANSPARENT` (les clics la traversent) et `WS_EX_NOACTIVATE` (**ne vole jamais le focus** à l'application en cours, ce qui est essentiel).
- Elle ne passe pas par le système de notifications : elle s'affiche même en mode Ne pas déranger. On s'impose donc nos propres règles : on la masque si `SHQueryUserNotificationState` indique une présentation ou un jeu.

### 3.3 Toasts natifs

- Par `tauri-plugin-notification` (WinRT `ToastNotificationManager`), ou par la Windows App SDK (`AppNotificationManager`) pour les toasts riches : boutons, champ de réponse, images.
- **Prérequis souvent oublié** : un **AppUserModelID** enregistré, soit par un raccourci du menu Démarrer qui porte l'AUMID (installeur NSIS ou MSI), soit par un package MSIX. Sinon, les toasts n'apparaissent pas ou sont attribués à « PowerShell », comme en mode dev avec Tauri.
- **Activation** : un clic sur le toast (ou sur un bouton « Rouvrir ») rouvre la bulle avec le contexte de la conversation, via le plugin single-instance et des arguments d'activation.
- Les toasts respectent automatiquement le mode Concentration / Ne pas déranger, et c'est le comportement souhaité.

### 3.4 Le « push » au sens serveur

Un vrai push distant (WNS, Windows Push Notification Services) demande une application packagée **et** un backend cloud. **Hors périmètre** : NozBar est local. Tous les événements (rappels, minuteurs, fin de tâche) sont planifiés par le processus NozBar, qui tourne en arrière-plan avec une icône dans la zone de notification et un démarrage automatique à l'ouverture de session.

---

## 4. LLM : Gemini vs Claude

### 4.1 Mise au point préalable

« Exécuter des commandes système » n'est **pas** une capacité de l'API. Le cycle est toujours le même :

```
Utilisateur → NozBar → API LLM (avec la liste des outils en JSON Schema)
                       ← appel d'outil {name: "open_app", args: {"name": "Spotify"}}
NozBar exécute open_app localement → renvoie le résultat → LLM → réponse finale
```

Les deux fournisseurs proposent aussi des outils exécutés **côté serveur** : recherche web, exécution de code dans un bac à sable cloud. Ils s'exécutent chez le fournisseur, **jamais sur le PC de l'utilisateur**.

### 4.2 Comparatif fonctionnel

| Capacité | **Claude** (Anthropic) | **Gemini** (Google) |
|---|---|---|
| Familles de modèles | Haiku 5.5 (rapide), Sonnet 5.5 (équilibré), Opus 5.5 (le plus capable) | Flash-Lite / Flash (rapides, très bon marché) / Pro. *Vérifier les ID exacts au moment de l'implémentation* |
| Tool-calling client | ✅ Très fiable : choix d'outil précis, appels parallèles, bon respect des schémas, sait demander confirmation. Fort sur les tâches **agentiques multi-étapes** | ✅ Function calling avec modes `AUTO` / `ANY` / `NONE`, appels parallèles et compositionnels. Bon sur les intentions simples, à évaluer sur les chaînes longues |
| Streaming des arguments d'outils | ✅ (permet d'afficher l'état avant la fin de l'appel) | ✅ Streaming de la réponse ; streaming partiel des arguments à vérifier |
| Recherche web intégrée | Outil serveur *web search* avec citations | **Grounding Google Search** natif, avec sources et métadonnées : index Google, très bonne fraîcheur |
| Lecture d'URL | Outil serveur *web fetch* | *URL context* |
| Exécution de code (bac à sable cloud) | ✅ | ✅ |
| « Computer use » (pilotage d'écran par captures) | ✅ Outil dédié, mature | Disponible sur certains modèles, à vérifier |
| **Audio natif temps réel** (voix entrante et sortante en streaming) | ❌ À ma connaissance, pas d'entrée audio : STT et TTS doivent être externes | ✅ **Live API** : audio bidirectionnel à faible latence, gestion des interruptions, appels d'outils pendant la session vocale. **Gros atout pour un assistant vocal** |
| Génération de texte | Qualité rédactionnelle, nuance et suivi d'instructions de premier plan | Très bonne, et Flash est très rapide |
| Contexte long | Très large | Très large |
| Coût | Haiku bon marché, Opus premium | Flash et Flash-Lite parmi les moins chers du marché |
| Prudence sur les actions destructrices | Tendance marquée à demander confirmation : **précieux** pour un agent qui touche au système | Correcte, mais à verrouiller côté client de toute façon |

### 4.3 Conclusion et stratégie

1. **Pas de dépendance à un seul fournisseur.** On définit une interface `LlmProvider` (chat en streaming, outils normalisés en JSON Schema, événements `text_delta` / `tool_call_start` / `tool_call_args_delta` / `tool_result` / `done`). Les outils sont définis **une seule fois** et traduits vers chaque API.
2. **Routage en trois niveaux** (latence et coût) :
   - **Niveau 0, local, sans LLM** (< 20 ms) : grammaire et correspondance floue pour « ouvre / lance / ferme X », « volume / luminosité N », « quelle heure », « minuteur N min ». C'est la majorité des commandes d'un assistant.
   - **Niveau 1, modèle rapide** (Gemini Flash ou Claude Haiku) : questions générales, recherche web, commandes simples ambiguës.
   - **Niveau 2, modèle fort** (Claude Sonnet/Opus) : tâches multi-étapes (« range mes téléchargements par type », « prépare un mail résumant cette page ») et outils sensibles.
3. **Recherche web** : le grounding Google de Gemini est le chemin le plus direct pour obtenir des résultats sourcés et frais. Si Claude est actif, on utilise son outil *web search*. Option indépendante : une API de recherche dédiée (Brave Search, Tavily). Les API Bing Search de Microsoft ont été retirées en août 2025.
4. **Voix** : si l'on veut l'expérience la plus fluide, **Gemini Live API** règle STT, LLM et TTS d'un coup. Sinon, pipeline modulaire (§5) compatible avec les deux fournisseurs.
5. **Clé API apportée par l'utilisateur** (BYOK), stockée dans le **Gestionnaire d'identification Windows** (crate `keyring`), jamais en clair dans un fichier.

### 4.4 Catalogue d'outils initial

| Outil | Description | Message gris | Niveau de risque |
|---|---|---|---|
| `open_app(name)` | Lance une application (index du menu Démarrer + applications Store) | « Ouverture de {name}… » | Faible |
| `open_url(url)` | Ouvre une URL dans le navigateur par défaut | « Ouverture de {domaine}… » | Faible |
| `web_search(query)` | Recherche et affiche les résultats sous forme de cartes | « Recherche web en cours… » | Faible |
| `media_control(action)` | Lecture, pause, piste suivante (touches multimédias virtuelles) | « Lecture… » | Faible |
| `set_volume(level)` / `set_brightness(level)` | Réglages système | « Réglage du volume… » | Faible |
| `open_settings(page)` | URI `ms-settings:` | « Ouverture des paramètres… » | Faible |
| `search_files(query)` | Windows Search (index) | « Recherche de fichiers… » | Moyen (vie privée) |
| `timer(duration)` / `reminder(text, at)` | Planification locale + toast | « Minuteur réglé… » | Faible |
| `run_shell(command)` | PowerShell | « Exécution d'une commande… » | **Élevé : confirmation obligatoire** |

**Lancement d'applications sous Windows** (outil le plus utilisé, à soigner) :
- On indexe au démarrage, puis on surveille les changements : les raccourcis `.lnk` de `%ProgramData%\Microsoft\Windows\Start Menu\Programs` et `%AppData%\Microsoft\Windows\Start Menu\Programs`, plus le dossier virtuel **`shell:AppsFolder`** (énumération `FOLDERID_AppsFolder`), qui couvre **aussi les applications Store/UWP** avec leur AUMID. Exemple : Spotify peut être installé en version Store ou en version classique.
- Lancement par `ShellExecuteW("shell:AppsFolder\\<AUMID>")` ou par l'exécutable cible. Correspondance floue (Jaro-Winkler ou trigrammes) + alias appris (« musique » → Spotify) + **protocoles URI** (`spotify:`, `ms-settings:`, `mailto:`).

---

## 5. Voix : reconnaissance (STT) et synthèse (TTS)

### 5.1 Capture et détection de fin de parole

- Capture micro dans le cœur Rust (`cpal` / WASAPI) en 16 kHz mono.
- **VAD** (détection d'activité vocale) avec **Silero VAD** (ONNX, ~2 Mo, < 1 ms par trame) pour détecter la fin de phrase en mode « appui court puis parler », et pour couper les silences avant le STT.
- En mode push-to-talk, la fin de parole correspond au relâchement de la touche : le plus simple et le plus fiable.
- Prérequis système : *Paramètres > Confidentialité > Microphone > Autoriser les applications de bureau*. On détecte le refus et on affiche un message clair.

### 5.2 STT

| Option | Qualité en français | Latence | Coût | Confidentialité |
|---|---|---|---|---|
| `Windows.Media.SpeechRecognition` | Moyenne | Bonne | Gratuit | Locale |
| **Whisper local** (whisper.cpp / `whisper-rs`, modèle small ou medium, quantifié) | Très bonne | ~0,5–2 s sur CPU, < 0,5 s sur GPU | Gratuit | **100 % locale** |
| Cloud (Deepgram, Azure Speech, Gemini audio) | Excellente, transcription partielle en continu | Très bonne | Payant | Audio envoyé |
| Gemini Live API | Excellente | La meilleure (bout en bout) | Payant | Audio envoyé |

**Recommandation** : **Whisper local par défaut**. C'est cohérent avec « assistant local », sans coût, avec une bonne qualité en français. On affiche des transcriptions partielles en relançant le décodage sur la fenêtre audio glissante toutes les 500 ms environ. Option « Gemini Live » dans les réglages pour une latence minimale.

### 5.3 TTS

| Option | Qualité | Hors ligne |
|---|---|---|
| Voix Windows (SAPI / OneCore) | Robotique | ✅ |
| **Piper** (neuronal local, voix françaises disponibles) | Bonne | ✅ |
| Cloud (ElevenLabs, Azure Neural, Gemini TTS) | Excellente | ❌ |

**Recommandation** : Piper par défaut, et le cloud en option. Par défaut, la voix ne lit que les **réponses courtes** ; les réponses longues restent affichées à l'écran, comme Siri.

### 5.4 Mot d'activation (« Hey Noz »)

Faisable (openWakeWord ou Porcupine), mais micro ouvert en permanence, coût CPU et faux positifs. **Reporté à la V2.**

---

## 6. Architecture cible

### 6.1 Vue d'ensemble

```
┌──────────────────────── Processus NozBar (Tauri 2) ────────────────────────┐
│                                                                            │
│  Cœur Rust                                    Front WebView2 (Svelte/React)│
│  ├─ hotkey      RegisterHotKey + sondage     ├─ Overlay (voile + bulle)    │
│  ├─ window      positionnement, acrylic      ├─ Orbe WebGL                 │
│  ├─ audio       capture WASAPI, RMS, VAD     ├─ Texte dynamique (paliers)  │
│  ├─ stt / tts   whisper.cpp, Piper           ├─ Ligne d'état grise         │
│  ├─ router      intentions locales           ├─ Cartes de résultats web    │
│  ├─ llm         providers Claude / Gemini    └─ Réglages                   │
│  ├─ tools       open_app, web_search, …                                    │
│  ├─ app_index   menu Démarrer + AppsFolder    HUD (2ᵉ fenêtre, no-activate)│
│  ├─ notify      toasts WinRT                                               │
│  └─ secrets     Gestionnaire d'identification                              │
│                                                                            │
│  IPC : commandes Tauri (front → cœur) + événements (cœur → front)          │
└────────────────────────────────────────────────────────────────────────────┘
```

Le cœur possède **toute** la logique et l'état. Le front ne fait qu'afficher les événements, ce qui le rend facile à tester et à redessiner.

### 6.2 Machine à états de la bulle

```
Hidden ──hotkey──▶ Opening ──▶ Idle(texte) | Listening(voix)
Listening ──fin parole──▶ Transcribing ──▶ Thinking
Idle ──Entrée──▶ Thinking
Thinking ──intention/outil détecté──▶ Acting{tool, status:"Ouverture de Spotify…"}
Acting ──résultat──▶ Thinking (boucle d'outils) | Responding(stream)
Responding ──fin──▶ Done ──(action simple: 1,5 s)──▶ Closing ──▶ Hidden
Tout état ──Échap / clic dehors / hotkey──▶ Closing
Tout état ──erreur──▶ Error(message, retry)
```

### 6.3 Le feedback « texte gris » : comment l'afficher *immédiatement*

L'exigence est d'afficher l'état **avant** l'action et le résultat. Trois sources, de la plus rapide à la plus lente :

1. **t + 0 ms** : dès l'envoi, on affiche un état générique « Réflexion… » en gris avec shimmer. L'interface n'est jamais vide.
2. **t + 5–20 ms (niveau 0 local)** : le routeur reconnaît « ouvre Spotify », émet `status("Ouverture de Spotify…")` **avant** d'appeler `ShellExecute`, puis `done("Spotify est ouvert")`.
3. **t + 300–1 500 ms (via LLM)** : dès que le flux contient le **début d'un appel d'outil** (le nom de l'outil arrive avant les arguments), on affiche le message générique de l'outil (« Recherche web en cours… »). On l'affine quand l'argument utile arrive (« Recherche : météo Lyon… »).

Chaque outil déclare son **gabarit de message d'état** (colonne « Message gris » du §4.4). Le LLM n'a pas à le produire : c'est déterministe, instantané et toujours en français.

Ordre d'affichage garanti : `status` est émis, puis le front est assuré de l'avoir rendu, puis l'action s'exécute. Le texte gris reste affiché au moins ~400 ms, même si l'action est instantanée, pour que l'œil ait le temps de le lire. Il se transforme ensuite (fondu vers le blanc) en résultat.

### 6.4 Budgets de latence

| Étape | Cible |
|---|---|
| Raccourci → bulle visible et animée | **< 100 ms** |
| Fin de parole → transcription finale (Whisper small, CPU moderne) | < 1 s |
| Envoi → premier texte gris | **< 50 ms** |
| Commande locale (ouvrir une app) → app lancée | < 300 ms (plus le démarrage de l'app) |
| Envoi → premier token LLM (modèle rapide) | < 1 s |
| Mémoire au repos | < 120 Mo hors modèle Whisper chargé à la demande |

### 6.5 Recherche web : affichage intégré

- Résultat sous forme de **cartes** (favicon, titre, domaine, extrait), précédées d'une **synthèse IA courte avec citations numérotées**.
- Clic sur une carte : ouverture dans le navigateur par défaut. Option V2 : un aperçu dans une WebView enfant Tauri, qui n'est pas une iframe, donc pas bloquée par `X-Frame-Options`.
- La bulle s'agrandit en hauteur (animation FLIP) pour accueillir les cartes. Défilement interne au-delà de 70 % de la hauteur d'écran.

### 6.6 Distribution

- Installeur **NSIS** (Tauri) au MVP, **MSIX** en V2 (touche Copilot, identité de package, toasts propres).
- **Signature de code** recommandée pour éviter les avertissements SmartScreen.
- Démarrage automatique à l'ouverture de session (`tauri-plugin-autostart`), instance unique, icône dans la zone de notification (menu Réglages / Quitter).

---

## 7. Sécurité, risques et questions ouvertes

### 7.1 Sécurité

- **Injection de prompt** : une page web lue par l'IA peut contenir « exécute `Remove-Item`… ». Parades :
  - les outils **à risque élevé** (`run_shell`, suppression ou déplacement de fichiers) demandent **toujours une confirmation explicite** dans la bulle, avec la commande exacte affichée ;
  - une fois que des contenus externes (web, fichiers) sont entrés dans le contexte d'un tour, les outils à risque sont **verrouillés** (« taint tracking ») ;
  - PowerShell est lancé **sans élévation**, avec un délai maximal et une sortie tronquée.
- **Secrets** : clés API dans le Gestionnaire d'identification Windows, jamais dans les journaux.
- **Vie privée** : indicateur visuel clair quand le micro est actif. Historique local, effaçable. Envoi audio au cloud uniquement si l'utilisateur l'a activé.
- **Pas de hook clavier bas niveau** : moins de faux positifs antivirus, et aucune ambiguïté de type keylogger.

### 7.2 Risques techniques

| Risque | Probabilité | Impact | Mitigation |
|---|---|---|---|
| Vol de focus refusé par Windows | Moyenne | Fort | Prototype dès le 1er jour ; repli `AttachThreadInput` |
| Acrylic plein écran lent sur certains GPU | Moyenne | Moyen | Mode performance (voile sans flou) |
| Latence de Whisper sur CPU modeste | Moyenne | Moyen | Modèle base/small quantifié ; option cloud |
| Toasts invisibles faute d'AUMID | Élevée en dev | Faible | Raccourci avec AUMID dès l'installeur |
| Correspondance floue des apps erronée (« ouvre Code » → ?) | Moyenne | Moyen | Désambiguïsation dans la bulle + alias appris |
| Coût LLM incontrôlé | Faible | Moyen | Routage local d'abord ; plafond de tokens par requête |

### 7.3 Questions à trancher avant la Phase 2

1. **Stack** : Tauri 2 (Rust) vous convient-il, ou préférez-vous Electron (tout en JS/TS) ou .NET ?
2. **« Plein écran »** : overlay plein écran (bureau flouté + bulle centrale, recommandé), ou bulle flottante seule (coin ou bas de l'écran, sans voile) ?
3. **Voix** : 100 % locale (Whisper + Piper) par défaut, ou priorité à la fluidité avec Gemini Live (cloud) ?
4. **Fournisseur LLM par défaut** et **mode de clés** (BYOK pour chaque fournisseur ?).
5. **Langue** : français seul au MVP, ou FR + EN ?
6. **Périmètre MVP proposé** : raccourci, bulle et animations ; mode texte ; lancement d'apps (niveau 0) ; recherche web (cartes) ; un fournisseur LLM avec outils ; push-to-talk avec Whisper ; HUD et toasts. Hors MVP : mot d'activation, touche Copilot/MSIX, `run_shell`, computer use.
