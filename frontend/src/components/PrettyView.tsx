import { memo } from 'react';
import type { Block } from '../lib/parser';
import { ansiToHtml } from '../lib/ansi';

interface Props {
  blocks: Block[];
}

// One renderer for every block type the parsers can emit. Inline switch
// because the per-type components in pretty-tmux carry markdown / copy /
// diff dependencies we don't need yet — Phase 3 is "show structured
// content", Phase 3+ is "render it beautifully".
function renderBlock(block: Block): React.ReactNode {
  switch (block.type) {
    case 'banner':
      return (
        <div className="pretty-banner">
          <div className="pretty-banner-title">
            Claude Code{block.metadata.version ? ` v${block.metadata.version}` : ''}
          </div>
          <div className="pretty-banner-meta">
            {block.metadata.model ? <span>{block.metadata.model}</span> : null}
            {block.metadata.cwd ? <span className="pretty-mono">{block.metadata.cwd}</span> : null}
          </div>
        </div>
      );

    case 'session_divider':
      return <div className="pretty-divider"><span>session ended</span></div>;

    case 'permissions_badge':
      return <div className="pretty-badge pretty-badge-warn">⏵⏵ permissions bypassed</div>;

    case 'system_notice':
      return <div className="pretty-notice">✻ {block.content}</div>;

    case 'user_input':
      return (
        <div className={`pretty-user${block.metadata.isSlashCommand ? ' is-slash' : ''}`}>
          <div className="pretty-user-content">{block.content}</div>
          {block.metadata.responses?.map((r, i) => (
            <div key={i} className={`pretty-user-response is-${r.type}`}>{r.content}</div>
          ))}
        </div>
      );

    case 'claude_message':
      return (
        <div className="pretty-message">
          <AnsiText text={block.content} />
        </div>
      );

    case 'thinking_active':
      return (
        <div className="pretty-thinking is-active">
          <span className="pretty-thinking-glyph">✳</span>
          <span className="pretty-thinking-text">Thinking…</span>
          {block.metadata.timer ? <span className="pretty-thinking-timer">{block.metadata.timer}</span> : null}
          {block.metadata.tokens ? <span className="pretty-thinking-tokens">{block.metadata.tokens} tokens</span> : null}
        </div>
      );

    case 'thinking':
      return (
        <details className="pretty-thinking">
          <summary>Thought</summary>
          <pre className="pretty-thinking-body"><AnsiText text={block.content} /></pre>
        </details>
      );

    case 'search_status':
      return (
        <div className="pretty-search">
          <span className="pretty-search-query">{block.metadata.query}</span>
          {block.metadata.detail ? (
            <span className="pretty-search-detail">
              <AnsiText text={block.metadata.detail} />
            </span>
          ) : null}
        </div>
      );

    case 'tool_chip':
      return <div className="pretty-chip">{block.content}</div>;

    case 'tool_use':
      return (
        <div className={`pretty-tool${block.streaming ? ' is-streaming' : ''}`}>
          <div className="pretty-tool-head">
            <span className="pretty-tool-name">{block.metadata.toolName}</span>
            <span className="pretty-tool-args">{block.metadata.toolArgs}</span>
            {block.metadata.doneSummary ? (
              <span className="pretty-tool-done">{block.metadata.doneSummary}</span>
            ) : null}
          </div>
          {block.content ? (
            <pre className="pretty-tool-body"><AnsiText text={block.content} /></pre>
          ) : null}
        </div>
      );

    case 'command':
      return (
        <div className={`pretty-command${block.streaming ? ' is-streaming' : ''}`}>
          <div className="pretty-command-line">
            <span className="pretty-command-prompt">$</span>
            <span className="pretty-command-text">{block.metadata.command}</span>
          </div>
          {block.metadata.output ? (
            <pre className="pretty-command-output"><AnsiText text={block.metadata.output} /></pre>
          ) : null}
        </div>
      );

    case 'file_read':
    case 'file_write':
      return (
        <div className={`pretty-file is-${block.type === 'file_write' ? 'write' : 'read'}`}>
          <div className="pretty-file-head">
            <span className="pretty-file-kind">{block.type === 'file_write' ? '✎' : '◉'}</span>
            <span className="pretty-file-name">{block.metadata.filename ?? block.summary}</span>
          </div>
          {block.content ? (
            <pre className="pretty-file-body"><AnsiText text={block.content} /></pre>
          ) : null}
        </div>
      );

    case 'error':
      return <div className="pretty-error">⚠ {block.content || block.summary}</div>;

    case 'terminal_passthrough':
      return (
        <pre className="pretty-passthrough"><AnsiText text={block.content} /></pre>
      );

    case 'unknown':
    default:
      return <pre className="pretty-unknown"><AnsiText text={block.content || block.summary} /></pre>;
  }
}

// dangerouslySetInnerHTML on ANSI-escaped text — safe because anser HTML-
// escapes &, <, > internally before emitting the spans.
function AnsiText({ text }: { text: string }): JSX.Element {
  return <span dangerouslySetInnerHTML={{ __html: ansiToHtml(text) }} />;
}

const BlockItem = memo(
  function BlockItem({ block }: { block: Block }) {
    return <div className="pretty-block">{renderBlock(block)}</div>;
  },
  (prev, next) =>
    prev.block.id === next.block.id &&
    prev.block.content === next.block.content &&
    prev.block.streaming === next.block.streaming &&
    prev.block.metadata.timer === next.block.metadata.timer &&
    prev.block.metadata.tokens === next.block.metadata.tokens &&
    prev.block.metadata.doneSummary === next.block.metadata.doneSummary
);

export function PrettyView({ blocks }: Props): JSX.Element {
  if (blocks.length === 0) {
    return (
      <div className="pretty-empty">
        <div className="pretty-empty-text">
          Waiting for output…<br />
          <span className="text-faint">parser: detecting</span>
        </div>
      </div>
    );
  }
  return (
    <div className="pretty-view">
      {blocks.map((b) => (
        <BlockItem key={b.id} block={b} />
      ))}
    </div>
  );
}
