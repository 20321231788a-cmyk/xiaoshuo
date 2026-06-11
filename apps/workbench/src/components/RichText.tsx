import { parseRichText } from "../lib/richText.js";

export function RichText({ text, className = "" }: { text: string; className?: string }) {
  const blocks = parseRichText(text);

  if (!blocks.length) {
    return <p className={className}>没有可显示的文本。</p>;
  }

  return (
    <div className={`rich-text ${className}`.trim()}>
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Heading = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
          return <Heading key={index}>{block.text}</Heading>;
        }
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{item}</li>
              ))}
            </List>
          );
        }
        if (block.type === "code") {
          return (
            <pre key={index} className="rich-code">
              <code>{block.code}</code>
            </pre>
          );
        }
        return (
          <p key={index}>
            {block.lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {line}
                {lineIndex < block.lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
