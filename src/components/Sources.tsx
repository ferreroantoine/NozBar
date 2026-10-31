import type { Source } from "../lib/tools";

interface Props {
  sources: Source[];
  onOpen(url: string): void;
}

export function Sources({ sources, onOpen }: Props) {
  if (!sources.length) return null;
  return (
    <ol className="sources">
      {sources.map((s, i) => (
        <li key={s.url}>
          <button className="source" onClick={() => onOpen(s.url)} title={s.title}>
            <span className="source-index">{i + 1}</span>
            <img
              className="source-icon"
              src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(s.domain)}&sz=64`}
              alt=""
            />
            <span className="source-title">{s.title}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
