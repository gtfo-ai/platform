/**
 * NavList: the left column of a screen — sub-sections, filters or a job list (TD-033 § 1).
 *
 * Groups take an optional heading. The current item carries `aria-current="page"`, a subtle fill and
 * a bar in the link colour on its leading edge, as GitHub's settings sidebar does.
 */
import type { ReactElement } from 'react';
import { useId } from 'react';
import { cx, FOCUS_RING } from './cx.js';
import type { NavItem } from './nav-item.js';
import { renderNavItem } from './nav-render.js';

export interface NavListGroup {
  readonly label?: string;
  readonly items: readonly NavItem[];
}

const Group = ({ group }: { readonly group: NavListGroup }): ReactElement => {
  const headingId = useId();
  return (
    <div className="flex flex-col gap-0.5 pb-2">
      {group.label === undefined ? null : (
        <h3 id={headingId} className="px-2 pt-2 pb-1 text-xs font-semibold text-fg-muted">
          {group.label}
        </h3>
      )}
      <ul
        className="flex flex-col gap-0.5"
        {...(group.label === undefined ? {} : { 'aria-labelledby': headingId })}
      >
        {group.items.map((item) => (
          <li key={item.id} className="relative">
            {item.current === true ? (
              <span
                aria-hidden="true"
                data-selected-bar=""
                className="absolute top-1.5 bottom-1.5 -left-2 w-1 rounded-full bg-link"
              />
            ) : null}
            {renderNavItem(
              item,
              cx(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                FOCUS_RING,
                item.current === true
                  ? 'bg-muted font-semibold text-fg'
                  : 'text-fg hover:bg-subtle',
              ),
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

export const NavList = ({
  label,
  groups,
  className,
}: {
  readonly label: string;
  readonly groups: readonly NavListGroup[];
  readonly className?: string;
}): ReactElement => (
  <nav aria-label={label} className={cx('pl-2', className)}>
    {groups.map((group, index) => (
      <Group key={group.label ?? index} group={group} />
    ))}
  </nav>
);
