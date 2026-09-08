import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders an assistant message as GitHub-flavored markdown. Styling lives in
 * the `.md` rules in styles.css; the wrapper div keeps `white-space: normal`
 * so streamed prose wraps like a document instead of a pre block.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
