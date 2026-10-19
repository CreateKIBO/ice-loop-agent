import * as React from "react";
import "../styles/conversation.css";

// Share the existing remark stack with the editor, but do not load it on welcome.
const Reading = React.lazy(() => import("./MarkdownView").then(module => ({ default: module.MarkdownView })));
export function MarkdownContent({ text }: { text: string }) {
  return <React.Suspense fallback={<div className="ice-markdown" style={{whiteSpace:"pre-wrap"}}>{text}</div>}>
    <Reading text={text} />
  </React.Suspense>;
}
