import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo, type MouseEvent } from "react";

interface Props {
  text: string;
  className?: string;
  onLink(url: string): void;
}

export function Markdown({ text, className, onLink }: Props) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string),
    [text],
  );

  // Les liens s'ouvrent dans le navigateur par défaut, jamais dans la bulle.
  const onClick = (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest("a");
    if (link?.href) {
      e.preventDefault();
      onLink(link.href);
    }
  };

  return <div className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
