import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { cn } from "../lib/utils.js";

const ALLOWED_PROTOCOL = /^(?:https?:|mailto:)/i;
const ANY_PROTOCOL = /^[a-z][a-z\d+.-]*:/i;

type MarkdownNode = {
  type: string;
  position?: {
    start: { line: number };
    end: { line: number };
  };
  children?: MarkdownNode[];
};

export function safeMarkdownHref(rawHref: string): string | null {
  const transformed = defaultUrlTransform(rawHref.trim());
  if (!transformed || transformed.startsWith("//")) return null;
  if (ANY_PROTOCOL.test(transformed) && !ALLOWED_PROTOCOL.test(transformed)) return null;
  return transformed;
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function tickRunEnd(value: string, start: number): number {
  let end = start + 1;
  while (value[end] === "`") end += 1;
  return end;
}

function matchingTickRun(value: string, start: number, tickCount: number): number {
  for (let cursor = start; cursor < value.length;) {
    // Once a code span is open, CommonMark treats backslashes as literal
    // content. A same-length backtick run closes even when preceded by `\`.
    if (value[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    const end = tickRunEnd(value, cursor);
    if (end - cursor === tickCount) return cursor;
    cursor = end;
  }
  return -1;
}

function escapeCodeSpanPipes(line: string): string {
  let output = "";
  for (let index = 0; index < line.length;) {
    if (line[index] !== "`" || isEscaped(line, index)) {
      output += line[index];
      index += 1;
      continue;
    }

    const openerEnd = tickRunEnd(line, index);
    const tickCount = openerEnd - index;
    const closerStart = matchingTickRun(line, openerEnd, tickCount);
    if (closerStart < 0) {
      output += line.slice(index, openerEnd);
      index = openerEnd;
      continue;
    }

    output += line.slice(index, openerEnd);
    for (let cursor = openerEnd; cursor < closerStart; cursor += 1) {
      if (line[cursor] === "|" && !isEscaped(line, cursor)) output += "\\";
      output += line[cursor];
    }
    output += line.slice(closerStart, closerStart + tickCount);
    index = closerStart + tickCount;
  }
  return output;
}

function parsedTableRowLines(markdown: string): ReadonlySet<number> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as MarkdownNode;
  const lines = new Set<number>();
  const stack = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const position = node.position;
    if (node.type === "tableRow" && position && position.start.line === position.end.line) {
      lines.add(position.start.line - 1);
    }
    if (node.children) stack.push(...node.children);
  }
  return lines;
}

// GFM requires a pipe in a table cell to be escaped even when it appears in a
// code span. Existing guides commonly omit that escape. First let the Markdown
// parser identify real table rows, then normalize only those rows. Literal
// examples in fenced or indented code blocks are never rewritten, while tables
// inside blockquotes and list containers still work. Stored source is untouched.
export function normalizeReviewGuideMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const tableRows = parsedTableRowLines(lines.join("\n"));
  return lines.map((line, index) => tableRows.has(index) ? escapeCodeSpanPipes(line) : line).join("\n");
}

export function MarkdownPreview({
  markdown,
  emptyText = "No review guide recorded.",
  className
}: {
  markdown: string;
  emptyText?: string;
  className?: string;
}) {
  const trimmed = markdown.trim();
  const normalized = normalizeReviewGuideMarkdown(trimmed);
  return (
    <div
      data-markdown-preview
      className={cn(
        "flex max-h-[640px] min-h-24 flex-col gap-3 overflow-auto rounded-sm border border-rule-soft bg-card-2 px-4 py-4 text-[13px] text-ink-2",
        "[&_code]:rounded-sm [&_code]:bg-paper-3 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.92em]",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[11.5px]",
        className
      )}
    >
      {trimmed ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) => safeMarkdownHref(url) ?? ""}
          components={{
            h1: ({ children }) => <h1 className="font-serif text-[24px] font-semibold tracking-[-0.015em] text-ink">{children}</h1>,
            h2: ({ children }) => <h2 className="font-serif text-[20px] font-semibold tracking-[-0.015em] text-ink">{children}</h2>,
            h3: ({ children }) => <h3 className="font-serif text-[16px] font-semibold tracking-[-0.015em] text-ink">{children}</h3>,
            h4: ({ children }) => <h4 className="font-serif text-[14px] font-semibold text-ink">{children}</h4>,
            h5: ({ children }) => <h5 className="font-serif text-[13px] font-semibold text-ink">{children}</h5>,
            h6: ({ children }) => <h6 className="font-serif text-[12px] font-semibold uppercase tracking-wide text-ink">{children}</h6>,
            p: ({ children }) => <p className="leading-[1.65] text-ink-2">{children}</p>,
            ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
            blockquote: ({ children }) => <blockquote className="border-l-2 border-rule-strong pl-3 italic text-ink-2">{children}</blockquote>,
            hr: () => <hr className="border-rule-soft" />,
            pre: ({ children }) => <pre className="overflow-auto rounded-sm border border-rule-soft bg-paper-3 p-3 font-mono leading-5 text-ink-2">{children}</pre>,
            table: ({ children }) => <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-[12px]">{children}</table></div>,
            th: ({ children }) => <th className="border border-rule-soft bg-paper-3 px-2 py-1.5 font-medium text-ink">{children}</th>,
            td: ({ children }) => <td className="border border-rule-soft px-2 py-1.5 align-top">{children}</td>,
            a: ({ href, children }) => href ? (
              <a href={href} className="underline decoration-rule-strong underline-offset-2 hover:text-ink" rel="noreferrer">{children}</a>
            ) : <span>{children}</span>,
            img: ({ src, alt }) => src ? <img src={src} alt={alt ?? ""} loading="lazy" className="max-w-full rounded-sm border border-rule-soft" /> : <span>{alt}</span>
          }}
        >
          {normalized}
        </ReactMarkdown>
      ) : <span className="text-ink-3">{emptyText}</span>}
    </div>
  );
}
