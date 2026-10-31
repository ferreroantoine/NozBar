import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { native, type Provider } from "../lib/native";
import { CATEGORIES, DEFAULT_SETTINGS, type Category, type Policy, type Settings } from "../lib/settings";
import { errorMessage } from "../lib/tools";

const POLICIES: { value: Policy; label: string }[] = [
  { value: "always", label: "Toujours" },
  { value: "ask", label: "Demander" },
  { value: "never", label: "Refuser" },
];

/** Après « Connecter », on surveille la connexion faite dans la console. */
const LOGIN_POLL_MS = 3000;
const LOGIN_POLL_MAX = 60;

type ClaudeStatus = { installed: boolean; loggedIn: boolean } | null;

function KeyRow({ provider, title, hint }: { provider: Provider; title: string; hint: string }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    native.getApiKey(provider).then((k) => setSaved(Boolean(k)), () => setSaved(false));
  }, [provider]);

  async function save(key: string) {
    try {
      await native.setApiKey(provider, key);
      setSaved(Boolean(key.trim()));
      setValue("");
      setNote(key.trim() ? "Clé enregistrée." : "Clé supprimée.");
    } catch (e) {
      setNote(errorMessage(e));
    }
  }

  return (
    <div className="settings-row">
      <div className="settings-label">
        <strong>{title}</strong>
        <span>{saved === null ? "…" : saved ? "Clé enregistrée" : "Aucune clé"} · {hint}</span>
      </div>
      <form
        className="settings-key"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void save(value);
        }}
      >
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={saved ? "Remplacer la clé…" : "Coller la clé…"}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={!value.trim()}>
          Enregistrer
        </button>
        {saved && (
          <button type="button" className="secondary" onClick={() => void save("")}>
            Supprimer
          </button>
        )}
      </form>
      {note && <p className="settings-note">{note}</p>}
    </div>
  );
}

function ClaudeRow() {
  const [status, setStatus] = useState<ClaudeStatus>(null);
  const [note, setNote] = useState("");

  const refresh = () => native.claudeCodeStatus().then(setStatus, () => setStatus({ installed: false, loggedIn: false }));

  useEffect(() => {
    void refresh();
  }, []);

  async function login() {
    try {
      await native.claudeCodeLogin();
      setNote("Terminez la connexion dans la fenêtre qui vient de s'ouvrir (et dans le navigateur).");
      for (let i = 0; i < LOGIN_POLL_MAX; i++) {
        await new Promise((r) => setTimeout(r, LOGIN_POLL_MS));
        const s = await native.claudeCodeStatus();
        setStatus(s);
        if (s.loggedIn) {
          setNote("Compte Claude connecté.");
          return;
        }
      }
    } catch (e) {
      setNote(errorMessage(e));
    }
  }

  async function logout() {
    try {
      await native.claudeCodeLogout();
      setNote("Compte Claude déconnecté.");
      await refresh();
    } catch (e) {
      setNote(errorMessage(e));
    }
  }

  const label = !status ? "…" : !status.installed ? "Claude Code n'est pas installé" : status.loggedIn ? "Connecté" : "Non connecté";
  return (
    <div className="settings-row">
      <div className="settings-label">
        <strong>Compte Claude</strong>
        <span>{label} · l'expert utilise votre abonnement via Claude Code</span>
      </div>
      <div className="settings-actions">
        {status?.installed && !status.loggedIn && <button onClick={() => void login()}>Connecter mon compte Claude</button>}
        {status?.loggedIn && (
          <button className="secondary" onClick={() => void logout()}>
            Se déconnecter
          </button>
        )}
        <button className="secondary" onClick={() => void refresh()}>
          Actualiser
        </button>
      </div>
      {status && !status.installed && (
        <p className="settings-note">
          Installez Claude Code depuis code.claude.com, puis revenez ici pour vous connecter.
        </p>
      )}
      {note && <p className="settings-note">{note}</p>}
    </div>
  );
}

function PermissionsSection() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [note, setNote] = useState("");

  useEffect(() => {
    native.getSettings().then(setSettings, (e) => setNote(errorMessage(e)));
    // « Toujours autoriser » cliqué dans la bulle pendant que la fenêtre est ouverte.
    const unlisten = listen<Settings>("settings:changed", ({ payload }) => setSettings(payload));
    return () => void unlisten.then((stop) => stop());
  }, []);

  async function change(key: Category, policy: Policy) {
    const next = { permissions: { ...settings.permissions, [key]: policy } };
    setSettings(next);
    try {
      await native.setSettings(next);
      setNote("");
    } catch (e) {
      setNote(errorMessage(e));
    }
  }

  return (
    <section className="settings-section">
      <h2>Permissions de Claude</h2>
      <p className="settings-intro">
        Ce que l'expert peut faire sans vous demander. Dans son dossier <code>Documents\NozBar</code>, il lit et
        écrit toujours librement.
      </p>
      {CATEGORIES.map(({ key, label, hint }) => (
        <div className="settings-row settings-permission" key={key}>
          <div className="settings-label">
            <strong>{label}</strong>
            <span>{hint}</span>
          </div>
          <div className="segmented" role="radiogroup" aria-label={label}>
            {POLICIES.map((p) => (
              <button
                key={p.value}
                role="radio"
                aria-checked={settings.permissions[key] === p.value}
                className={settings.permissions[key] === p.value ? "is-active" : ""}
                onClick={() => void change(key, p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {key === "commands" && settings.permissions.commands === "always" && (
            <p className="settings-warning">
              Attention : une page web piégée pourrait faire exécuter une commande sans que vous la voyiez.
            </p>
          )}
        </div>
      ))}
      {note && <p className="settings-note">{note}</p>}
    </section>
  );
}

export function SettingsPage() {
  return (
    <main className="settings-page">
      <h1>Paramètres de NozBar</h1>
      <section className="settings-section">
        <h2>Comptes</h2>
        <KeyRow provider="gemini" title="Clé Gemini" hint="assistant rapide (obligatoire)" />
        <ClaudeRow />
        <KeyRow provider="anthropic" title="Clé API Claude" hint="secours si Claude Code n'est pas connecté (payant)" />
      </section>
      <PermissionsSection />
    </main>
  );
}
