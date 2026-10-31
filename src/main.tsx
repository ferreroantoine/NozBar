import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { SettingsPage } from "./components/SettingsPage";
import "./styles.css";

// La même page sert la bulle et la fenêtre de paramètres (index.html#settings).
const isSettings = window.location.hash === "#settings";
if (isSettings) document.documentElement.classList.add("is-settings");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isSettings ? <SettingsPage /> : <App />}</StrictMode>,
);
