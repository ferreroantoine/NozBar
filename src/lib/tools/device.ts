// Périphériques et PC : sortie audio, micro, luminosité, mode sombre, verrouillage et arrêt, état du PC.

import { native, type PowerAction } from "../native";
import { claudeAllowed, isResult, pick, REFUSED } from "./shared";
import { int, str, type Tool } from "./types";

const POWER: Record<PowerAction, { status: string; confirm?: string; done: string }> = {
  lock: { status: "Verrouillage…", done: "PC verrouillé" },
  sleep: { status: "Mise en veille…", confirm: "Mettre le PC en veille ?", done: "Mise en veille" },
  shutdown: { status: "Arrêt…", confirm: "Éteindre le PC maintenant ?", done: "Le PC s'éteint" },
  restart: { status: "Redémarrage…", confirm: "Redémarrer le PC maintenant ?", done: "Le PC redémarre" },
};

const MIC: Record<string, boolean | undefined> = { mute: true, unmute: false, toggle: undefined };

export const DEVICE_TOOLS: Tool[] = [
  {
    name: "audio_output",
    description:
      "Change la sortie audio par défaut (« passe sur le casque », « mets les enceintes JBL »). " +
      "Sans `name`, liste les sorties branchées.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Nom ou type de sortie, ex. « casque », « JBL »" } },
    },
    status: (a) => (str(a.name) ? `Passage sur ${str(a.name)}…` : "Lecture des sorties audio…"),
    async run(a, ctx) {
      const name = str(a.name);
      if (!name) {
        const outputs = await native.audioOutputs();
        return {
          ok: true,
          message: `${outputs.length} sorties audio`,
          data: { outputs: outputs.map((o) => (o.default ? `${o.name} (actuelle)` : o.name)) },
        };
      }
      let found = await native.resolveAudioOutput(name);
      // « Les enceintes » ne figure dans aucun nom : on propose toutes les sorties.
      if (found.kind === "nothing") {
        const outputs = await native.audioOutputs();
        const all = outputs.map((o) => ({ label: o.name, kind: "audio" as const, target: o.id, detail: o.default ? "actuelle" : "sortie audio" }));
        found = all.length ? { kind: "choose", candidates: all } : found;
      }
      const output = await pick(found, ctx, "Sur quelle sortie ?", name);
      if (isResult(output)) return output;
      await native.setAudioOutput(output.target);
      return { ok: true, message: `Le son sort maintenant sur ${output.label}` };
    },
  },

  {
    name: "microphone",
    description: "Coupe (mute), rétablit (unmute) ou bascule (toggle) le micro par défaut.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: Object.keys(MIC) } },
      required: ["action"],
    },
    status: () => "Réglage du micro…",
    async run(a) {
      const muted = await native.setMicrophone(MIC[str(a.action)]);
      return { ok: true, message: muted ? "Micro coupé" : "Micro rétabli", data: { muted } };
    },
  },

  {
    name: "set_brightness",
    description:
      "Règle la luminosité de l'écran : `level` (0 à 100) en absolu, ou `delta` (ex. 20, -20) en relatif.",
    parameters: {
      type: "object",
      properties: {
        level: { type: "integer", description: "Luminosité cible en pourcents" },
        delta: { type: "integer", description: "Variation en points de pourcentage" },
      },
    },
    status: () => "Réglage de la luminosité…",
    async run(a) {
      const level = await native.setBrightness(int(a.level), int(a.delta));
      return { ok: true, message: `Luminosité à ${level} %`, data: { level } };
    },
  },

  {
    name: "dark_mode",
    description: "Passe Windows en mode sombre (dark), clair (light) ou bascule (toggle).",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", enum: ["dark", "light", "toggle"] } },
      required: ["mode"],
    },
    status: () => "Changement de thème…",
    async run(a) {
      const mode = str(a.mode);
      if (mode !== "dark" && mode !== "light" && mode !== "toggle") return { ok: false, message: `Mode inconnu : ${mode}` };
      const dark = await native.setDarkMode(mode);
      return { ok: true, message: dark ? "Mode sombre activé" : "Mode clair activé" };
    },
  },

  {
    name: "power",
    description:
      "Verrouille (lock), met en veille (sleep), éteint (shutdown) ou redémarre (restart) le PC. " +
      "La veille, l'arrêt et le redémarrage demandent toujours confirmation à l'utilisateur.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: Object.keys(POWER) } },
      required: ["action"],
    },
    status: (a) => POWER[str(a.action) as PowerAction]?.status ?? "…",
    async run(a, ctx) {
      const action = str(a.action) as PowerAction;
      const spec = POWER[action];
      if (!spec) return { ok: false, message: `Action inconnue : ${action}` };
      if (spec.confirm && !(await ctx.ui.confirm(spec.confirm, "Confirmer"))) {
        return { ok: false, message: "Annulé", data: { cancelled: true } };
      }
      if (!spec.confirm && !(await claudeAllowed(ctx, "Claude veut verrouiller le PC"))) return REFUSED;
      await native.power(action);
      return { ok: true, message: spec.done };
    },
  },

  {
    name: "system_status",
    description:
      "État du PC : charge du processeur, mémoire, applications les plus gourmandes, batterie " +
      "(« pourquoi ça rame ? », « il me reste combien de batterie ? »).",
    parameters: { type: "object", properties: {} },
    status: () => "Analyse du PC…",
    async run() {
      const s = await native.systemStatus();
      const battery = s.battery
        ? `, batterie ${s.battery.percent} %${s.battery.charging ? " (en charge)" : ""}`
        : "";
      return {
        ok: true,
        message: `Processeur ${s.cpu} %, mémoire ${s.memoryUsedGb} / ${s.memoryTotalGb} Go${battery}`,
        data: {
          ...s,
          byCpu: s.byCpu.map((p) => `${p.name} : ${p.cpu} % du processeur`),
          byMemory: s.byMemory.map((p) => `${p.name} : ${p.memory_mb} Mo`),
        },
      };
    },
  },
];
