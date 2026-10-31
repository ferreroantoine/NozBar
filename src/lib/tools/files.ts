// Outils fichiers : retrouver un fichier par son nom approximatif, puis l'ouvrir.

import { native } from "../native";
import { str, type Tool, type ToolContext, type ToolResult } from "./types";

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

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
      "Tout ce qui n'est pas un document ou un média (programmes, scripts…) demande une confirmation à l'utilisateur.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Chemin complet du fichier" } },
      required: ["path"],
    },
    status: (a) => `Ouverture de ${baseName(str(a.path)) || "fichier"}…`,
    run: (a, ctx) => openPath(str(a.path), ctx),
  },
];

/** Ouvre un fichier ; le cœur Rust résout le vrai fichier et décide, l'interface ne fait que relayer la question. */
export async function openPath(path: string, ctx: ToolContext): Promise<ToolResult> {
  const { name, needsConfirmation } = await native.checkFile(path);
  if (needsConfirmation && !(await ctx.ui.confirm(`Lancer ${name} ?`, "Lancer"))) {
    return { ok: false, message: `Lancement de ${name} annulé par l'utilisateur`, data: { cancelled: true } };
  }
  await native.openFile(path, needsConfirmation);
  return { ok: true, message: `${name} est ouvert` };
}
