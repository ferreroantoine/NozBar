// Outils fichiers : retrouver un fichier par son nom approximatif, puis l'ouvrir.

import { native } from "../native";
import { str, type Tool } from "./types";

/** Extensions lancées comme des programmes : jamais sans confirmation. Même liste que files.rs. */
const PROGRAM_EXTENSIONS = new Set([
  "exe", "msi", "msix", "appx", "bat", "cmd", "ps1", "vbs", "js", "jse", "wsf", "scr", "com", "lnk", "reg",
  "jar", "hta", "cpl", "appref-ms",
]);

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function isProgram(path: string): boolean {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && PROGRAM_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export const FILE_TOOLS: Tool[] = [
  {
    name: "find_file",
    description:
      "Cherche un fichier par son nom approximatif dans Téléchargements, Bureau et Documents (sous-dossiers compris). " +
      "Renvoie jusqu'à 5 fichiers avec leur chemin complet. Si plusieurs fichiers correspondent, demande lequel avec ask_user.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nom ou partie du nom, ex. « horizon launcher »" },
        kind: {
          type: "string",
          enum: ["any", "program", "document"],
          description: "program pour un logiciel à lancer, document pour tout le reste",
        },
      },
      required: ["query"],
    },
    status: (a) => `Recherche de ${str(a.query) || "fichier"}…`,
    async run(a) {
      const query = str(a.query);
      const kind = str(a.kind) || undefined;
      const found = await native.findFiles(query, kind);
      if (!found.length) {
        return { ok: false, message: `Aucun fichier ne correspond à « ${query} » dans Téléchargements, Bureau ou Documents` };
      }
      return {
        ok: true,
        message: `${found.length} fichier(s) trouvé(s)`,
        data: { files: found.map(({ name, path, folder }) => ({ name, path, folder })) },
      };
    },
  },

  {
    name: "open_file",
    description:
      "Ouvre un fichier avec le programme par défaut de Windows. Utilise le chemin complet renvoyé par find_file. " +
      "Les programmes (.exe, .msi…) demandent une confirmation à l'utilisateur.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Chemin complet du fichier" } },
      required: ["path"],
    },
    status: (a) => `Ouverture de ${baseName(str(a.path)) || "fichier"}…`,
    async run(a, ctx) {
      const path = str(a.path);
      const name = baseName(path);
      if (isProgram(path) && !(await ctx.ui.confirm(`Lancer ${name} ?`, "Lancer"))) {
        return { ok: false, message: `Lancement de ${name} annulé par l'utilisateur` };
      }
      await native.openFile(path);
      return { ok: true, message: `${name} est ouvert` };
    },
  },
];
