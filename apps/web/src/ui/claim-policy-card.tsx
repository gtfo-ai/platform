/**
 * **What this machine takes** (the M26 UX spec § 1, S-26.7): the card the worker's local page and
 * the platform's Workers screen (S-26.8a) both draw, with the same words.
 *
 * - **One sentence says the result**, always visible, built from the **stored** setting only — the
 *   `stored` prop, which the caller sets from the answer it read or saved — never from a draft:
 *   "This machine takes **your tasks and unassigned ones**, in **Autix and Fontai**."
 * - *Change* (offered only when the caller passes `onSave`, i.e. to the machine's owner) opens two
 *   plain controls: *Which tasks* (four radios, the label the outcome and one line of help each) and
 *   *In which projects* (*All projects you can see*, or *Only these:* with a chip per project).
 * - **Save is explicit** and **secondary** (TD-033: the screen's one amber primary is somebody
 *   else's); a save that resolved says "Saved · applies to the next run" — a run in flight is never
 *   moved. A save that threw keeps the controls open and says the error's message, as text.
 * - **The consequence line** ("Unassigned tasks in Autix have nowhere to run.") is a warning, never
 *   a blocker, and it is shown only when it is **known** to be true: with *Only my tasks*, for a
 *   selected project whose `unassignedHasTaker` is `false` — the stored setting's, or the draft's
 *   while *Change* is open. A project the caller knows nothing about (no key, or no prop) says
 *   nothing.
 *
 * **Presentational**: props in, callbacks out. It asks nobody anything; the draft and the
 * open/closed state are the only state it keeps. Every project name is untrusted text (BD-022) and
 * is rendered through `UntrustedText`, alone or inside the sentence it was put in; the words are
 * `MACHINE_TAKES_WORDS` (`ui/humanize.ts`). Nothing here imports `viz/*`, the router or zod: the
 * worker page's 120 kB entry imports it.
 */
import type { WorkerClaimPolicy } from '@platform/contracts';
import { type ReactElement, useId, useState } from 'react';
import { Button } from './button.js';
import { Flash } from './flash.js';
import { projectListWords, MACHINE_TAKES_WORDS as W } from './humanize.js';
import { UntrustedText } from './untrusted.js';

/** A project the machine's person may take tasks in: its name is the chip's and the sentence's. */
export interface ClaimPolicyProject {
  readonly id: string;
  /** Untrusted (a person named it). An empty name falls back to `key`. */
  readonly name: string;
  readonly key?: string;
}

/** The setting: a policy over `null` (every project) or those projects. */
export interface ClaimPolicyValue {
  readonly policy: WorkerClaimPolicy;
  /** `null`: every project the person can see. Never `[]` (*pick only* is a policy). */
  readonly projectIds: readonly string[] | null;
}

export interface ClaimPolicyCardProps {
  /** The setting as it is **stored** — the sentence is built from this and nothing else. */
  readonly stored: ClaimPolicyValue;
  /** The projects the chips offer and the sentence names. */
  readonly projects: readonly ClaimPolicyProject[];
  /**
   * Saves a setting; resolve once it is stored (the caller then passes the new `stored`), reject
   * with an `Error` whose message the card shows. Absent: the card is read only (no *Change*).
   */
  readonly onSave?: (next: ClaimPolicyValue) => Promise<void>;
  /**
   * Per project id: whether another taker (the server or another person's machine) takes its
   * **unassigned** tasks by itself. A missing key is unknown, and an unknown says nothing.
   */
  readonly unassignedHasTaker?: Readonly<Record<string, boolean>>;
}

/** A project's display name: its name, else its key, else the words for a project gone. */
const nameOf = (project: ClaimPolicyProject | undefined): string =>
  (project?.name.trim() || project?.key) ?? W.projectLeft;

/**
 * The names a list of project ids reads as: each project's name in the ids' order, and the ids the
 * person can no longer see as one "a project you left" (a name is said once).
 */
export const projectNamesOf = (
  ids: readonly string[],
  projects: readonly ClaimPolicyProject[],
): string[] => [...new Set(ids.map((id) => nameOf(projects.find((project) => project.id === id))))];

/**
 * The setting in one sentence (the spec's three examples, and *Everything* in the same shape). The
 * header of the worker's page and the Workers row draw it too.
 */
export const ClaimPolicySentence = ({
  stored,
  projects,
}: {
  readonly stored: ClaimPolicyValue;
  readonly projects: readonly ClaimPolicyProject[];
}): ReactElement => {
  const names = stored.projectIds && (
    <strong className="font-semibold">
      <UntrustedText value={projectListWords(projectNamesOf(stored.projectIds, projects))} />
    </strong>
  );
  return (
    <span data-claim-policy-sentence="">
      {W.start}
      <strong className="font-semibold">{W.what[stored.policy]}</strong>
      {stored.policy === 'pick_only' ? (
        <>
          {W.pick}
          {names ? (
            <>
              {W.pickIn}
              {names}
              {W.pickOnly}
            </>
          ) : null}
          {W.end}
        </>
      ) : (
        <>
          {W.in}
          {names || <strong className="font-semibold">{W.allProjects}</strong>}
          {W.end}
        </>
      )}
    </span>
  );
};

/**
 * The selected projects the consequence line names: with *Only my tasks*, those whose unassigned
 * tasks are **known** to have no other taker. Empty for every other policy and every unknown.
 */
export const nowhereToRunOf = (
  value: ClaimPolicyValue,
  projects: readonly ClaimPolicyProject[],
  unassignedHasTaker: Readonly<Record<string, boolean>> | undefined,
): string[] =>
  value.policy === 'mine' && unassignedHasTaker
    ? (value.projectIds ?? projects.map((project) => project.id))
        .filter((id) => unassignedHasTaker[id] === false)
        .map((id) => nameOf(projects.find((project) => project.id === id)))
    : [];

/** A setting as a comparable key: the policy, and the projects as a set. */
export const claimPolicyKey = (value: ClaimPolicyValue): string =>
  `${value.policy}:${value.projectIds ? [...value.projectIds].sort().join() : '*'}`;

export const ClaimPolicyCard = ({
  stored,
  projects,
  onSave,
  unassignedHasTaker,
}: ClaimPolicyCardProps): ReactElement => {
  const id = useId();
  const [draft, setDraft] = useState<{
    readonly policy: WorkerClaimPolicy;
    readonly some: boolean;
    readonly chosen: readonly string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wanted: ClaimPolicyValue | null = draft && {
    policy: draft.policy,
    projectIds: draft.some ? draft.chosen : null,
  };
  const incomplete = draft?.some === true && draft.chosen.length === 0;
  const nowhere = nowhereToRunOf(wanted ?? stored, projects, unassignedHasTaker);

  const save = async (next: ClaimPolicyValue): Promise<void> => {
    setBusy(true);
    try {
      await onSave?.(next);
      setDraft(null);
      setSaved(true);
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** One radio; `help` is its one line, outside the label so the name stays the outcome. */
  const radio = (
    group: string,
    value: string,
    checked: boolean,
    onChange: () => void,
    label: string,
    help?: string,
  ): ReactElement => (
    <div key={value} className="flex flex-col">
      <label className="flex items-center gap-2 text-sm text-fg">
        <input
          type="radio"
          name={id + group}
          checked={checked}
          aria-describedby={help && id + value}
          onChange={onChange}
        />
        {label}
      </label>
      {help ? (
        <span id={id + value} className="ml-6 text-xs text-fg-muted">
          {help}
        </span>
      ) : null}
    </div>
  );

  return (
    <section
      aria-label={W.title}
      className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-semibold text-fg">{W.title}</h2>
          <p className="text-sm text-fg">
            <ClaimPolicySentence stored={stored} projects={projects} />
          </p>
          {saved ? (
            <p role="status" className="text-xs text-fg-muted">
              {W.saved}
            </p>
          ) : null}
        </div>
        {onSave && !draft ? (
          <Button
            size="sm"
            onClick={() => {
              setDraft({
                policy: stored.policy,
                some: stored.projectIds !== null,
                // A project the person left is not offered back: saving it would be refused.
                chosen: (stored.projectIds ?? []).filter((entry) =>
                  projects.some((project) => project.id === entry),
                ),
              });
              setSaved(false);
              setError(null);
            }}
          >
            {W.change}
          </Button>
        ) : null}
      </div>
      {nowhere.length > 0 ? (
        <p className="text-sm text-attention">
          <UntrustedText value={W.nowhere(projectListWords(nowhere))} />
        </p>
      ) : null}
      {draft && wanted ? (
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-fg">{W.whichTasks}</legend>
            {(Object.keys(W.options) as WorkerClaimPolicy[]).map((policy) =>
              radio(
                'p',
                policy,
                draft.policy === policy,
                () => setDraft({ ...draft, policy }),
                W.options[policy].label,
                W.options[policy].help,
              ),
            )}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-fg">{W.whichProjects}</legend>
            {radio(
              's',
              'all',
              !draft.some,
              () => setDraft({ ...draft, some: false }),
              W.projectsAll,
            )}
            {radio(
              's',
              'some',
              draft.some,
              () => setDraft({ ...draft, some: true }),
              W.projectsSome,
            )}
            {draft.some ? (
              projects.length === 0 ? (
                <p className="ml-6 text-sm text-fg-muted">{W.noProjects}</p>
              ) : (
                <ul className="ml-6 flex flex-wrap gap-2">
                  {projects.map((project) => (
                    <li key={project.id}>
                      <label className="flex items-center gap-1.5 rounded-full border border-line px-2 text-sm text-fg">
                        <input
                          type="checkbox"
                          checked={draft.chosen.includes(project.id)}
                          onChange={() =>
                            setDraft({
                              ...draft,
                              chosen: draft.chosen.includes(project.id)
                                ? draft.chosen.filter((entry) => entry !== project.id)
                                : [...draft.chosen, project.id],
                            })
                          }
                        />
                        <UntrustedText value={nameOf(project)} />
                      </label>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </fieldset>
          {error === null ? null : (
            <Flash tone="danger" title={W.refused}>
              <UntrustedText value={error} />
            </Flash>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              disabled={busy || incomplete || claimPolicyKey(wanted) === claimPolicyKey(stored)}
              onClick={() => void save(wanted)}
            >
              {W.save}
            </Button>
            <Button size="sm" tone="invisible" disabled={busy} onClick={() => setDraft(null)}>
              {W.cancel}
            </Button>
            {incomplete ? <span className="text-xs text-fg-muted">{W.noneChosen}</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
};
