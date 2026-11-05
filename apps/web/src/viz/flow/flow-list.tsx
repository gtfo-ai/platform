/**
 * The flow canvas as an ordered list (TD-033 decision 8 (a)): the same stages, in pipeline order,
 * each the same `<button>` with its state in words — for a screen reader beside the canvas
 * (`sr-only`), and on its own below 768 px or when the reader picks *List*.
 *
 * Order is the main path first (the way a task goes when everything passes, `layout.ts` rule 1),
 * then every other stage in declaration order, so "Stage 3 of 9" means the same thing on the canvas
 * and here. Where a stage can send the task back, the list says so in words ("Can send back to
 * Implementation · Review ≤3"), because a curve below the row is the one thing a list cannot draw.
 */
import type { ReactElement } from 'react';
import { cx } from '../../ui/cx.js';
import { stageLabel } from '../../ui/humanize.js';
import { layoutFlow } from './layout.js';
import type { FlowGraph, FlowNode } from './model.js';
import { StageCard } from './stage-card.js';

/** The stages in list order: the main path, then the rest as declared. */
export const listOrder = (graph: FlowGraph): readonly FlowNode[] => {
  const { mainPath } = layoutFlow(graph.nodes, graph.edges);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const main = mainPath
    .map((id) => byId.get(id))
    .filter((node): node is FlowNode => node !== undefined);
  const onPath = new Set(mainPath);
  return [...main, ...graph.nodes.filter((node) => !onPath.has(node.id))];
};

/** "Can send back to Implementation (Review · used 1 of 3)", one per return out of the stage. */
export const returnsOf = (graph: FlowGraph, id: string): readonly string[] =>
  graph.edges
    .filter((edge) => edge.from === id && edge.loop !== null)
    .map(
      (edge) =>
        `Can send back to ${stageLabel(edge.to)}${edge.pill === null ? '' : ` (${edge.pill})`}`,
    );

export const FlowList = ({
  graph,
  onOpen,
  label,
  hidden = false,
}: {
  readonly graph: FlowGraph;
  readonly onOpen: (id: string) => void;
  readonly label: string;
  /** Beside the canvas: present for assistive tech, not drawn. */
  readonly hidden?: boolean;
}): ReactElement => {
  const nodes = listOrder(graph);
  return (
    <ol
      aria-label={label}
      data-flow-list={hidden ? 'screen-reader' : 'shown'}
      // Shown on its own, the list is bounded like the canvas, so a long pipeline does not push the
      // rest of the page a screen down; every card is a button, so the keyboard scrolls it.
      className={cx(hidden ? 'sr-only' : 'flex max-h-[28rem] flex-col gap-2 overflow-y-auto pr-1')}
    >
      {nodes.map((node, index) => {
        const returns = returnsOf(graph, node.id);
        return (
          <li
            key={node.id}
            aria-current={node.state === 'current' ? 'step' : undefined}
            className="flex flex-col gap-1"
          >
            <span className="sr-only">{`Stage ${index + 1} of ${nodes.length}`}</span>
            <StageCard node={node} onOpen={onOpen} className="min-h-16" tabbable={!hidden} />
            {returns.length === 0 ? null : (
              <ul className="flex flex-col gap-0.5 pl-3 text-xs text-fg-muted">
                {returns.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
};
