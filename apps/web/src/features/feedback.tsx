/**
 * The feedback control of product/10: 👍/👎 plus text, scoped to a stage or to the task.
 *
 * One component for both screens, because feedback is one command
 * (`POST /api/tasks/:id/feedback`, `submitFeedbackRequestSchema`) and two forms that drift are two
 * bugs. The task screen sends `scope: 'task'`; the run screen sends `scope: 'stage'` with the run's
 * stage, since a run is one attempt at a stage and the retrospective reads the stage.
 *
 * **The thumbs are a 1–5 rating.** product/10 asks for 👍/👎 and the published schema carries
 * `rating: 1..5`, so this maps 👍 to 5 and 👎 to 1 rather than inventing a second field on the
 * wire. Nothing is sent when neither is pressed: `rating` is optional and an unset opinion is not
 * a neutral 3.
 */
import { type ReactElement, useState } from 'react';
import { Button, Card, ErrorNotice, SectionHeading } from '../ui/kit.js';

export const THUMBS_UP_RATING = 5;
export const THUMBS_DOWN_RATING = 1;

export interface FeedbackFormProps {
  readonly heading: string;
  readonly hint: string;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly accepted: boolean;
  readonly onSubmit: (input: { readonly text: string; readonly rating?: number }) => void;
}

export const FeedbackForm = ({
  heading,
  hint,
  pending,
  failed,
  accepted,
  onSubmit,
}: FeedbackFormProps): ReactElement => {
  const [rating, setRating] = useState<number | null>(null);
  const [text, setText] = useState('');

  return (
    <Card className="flex flex-col gap-2">
      <SectionHeading>{heading}</SectionHeading>
      <p className="text-[11px] text-fg-muted">{hint}</p>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ text, ...(rating === null ? {} : { rating }) });
          setText('');
          setRating(null);
        }}
      >
        <div className="flex gap-2">
          <Button
            type="button"
            aria-pressed={rating === THUMBS_UP_RATING}
            tone={rating === THUMBS_UP_RATING ? 'primary' : 'default'}
            onClick={() => {
              setRating(rating === THUMBS_UP_RATING ? null : THUMBS_UP_RATING);
            }}
          >
            Good
          </Button>
          <Button
            type="button"
            aria-pressed={rating === THUMBS_DOWN_RATING}
            tone={rating === THUMBS_DOWN_RATING ? 'primary' : 'default'}
            onClick={() => {
              setRating(rating === THUMBS_DOWN_RATING ? null : THUMBS_DOWN_RATING);
            }}
          >
            Bad
          </Button>
        </div>
        <textarea
          aria-label={heading}
          value={text}
          rows={2}
          onChange={(event) => {
            setText(event.target.value);
          }}
          placeholder="What was good or wrong about this work?"
          className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
        />
        <Button type="submit" tone="primary" disabled={pending || text.trim() === ''}>
          Send feedback
        </Button>
      </form>
      {failed ? <ErrorNotice title="That feedback was refused." /> : null}
      {accepted ? <p className="text-xs text-fg-muted">Feedback recorded.</p> : null}
    </Card>
  );
};
