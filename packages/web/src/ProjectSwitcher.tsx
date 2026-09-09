import { useState } from "react";
import type { Daemon } from "./daemon-client";
import { CheckIcon, ChevronDownIcon } from "./icons";

/**
 * Which project the header — and therefore every panel below it — means, and
 * the only place a second one can be started.
 *
 * The dropdown opens even with a single project: without it, a planner who
 * finished onboarding had no way to add another, and the whole registry was
 * unreachable after the first run.
 */
export function ProjectSwitcher({
  daemon,
  onNewProject,
}: {
  daemon: Daemon;
  /** Opens the wizard, which is where a project is described and created. */
  onNewProject: () => void;
}) {
  const { projects, activeSlug, api } = daemon;
  const [open, setOpen] = useState(false);
  /** Slug being activated, so the control can name where it is going. */
  const [switching, setSwitching] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // A registry that holds anything always names an active project — the
  // daemon re-points to the first one on load and on remove — so an unfound
  // active means an empty registry, which is the wizard's screen, not ours.
  const active = projects.find((project) => project.slug === activeSlug);
  if (!active) return null;

  const target = switching ? projects.find((project) => project.slug === switching) : null;

  const activate = async (slug: string) => {
    setOpen(false);
    if (slug === active.slug) return;
    setSwitching(slug);
    setFailed(false);
    try {
      await api.projectActivate(slug);
    } catch {
      // The daemon kept the old project: nothing moved, so the planner only
      // needs to pick again.
      setFailed(true);
    } finally {
      setSwitching(null);
    }
  };

  return (
    <span
      className="selector project"
      // Escape closes the menu from wherever focus sits inside it — the chip
      // or one of the rows — the same as clicking the backdrop.
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {open && (
        <button
          type="button"
          className="selector__backdrop"
          aria-label="프로젝트 목록 닫기"
          onClick={() => setOpen(false)}
        />
      )}
      <button
        type="button"
        className="selector__chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="프로젝트 선택"
        // Activation stops one preview server before starting the next, so it
        // takes seconds a planner would otherwise spend clicking again.
        disabled={switching !== null}
        title={switching ? undefined : active.name}
        onClick={() => setOpen((prev) => !prev)}
      >
        {/* "…로" instead of the name's own particle: 으로/로 depends on the
            last syllable, and a project name is whatever the planner typed. */}
        {target ? `${target.name} 프로젝트로 전환 중…` : active.name}
        <ChevronDownIcon size={10} />
      </button>
      {open && (
        <span className="selector__menu" role="listbox" aria-label="프로젝트">
          {projects.map((project) => (
            <button
              key={project.slug}
              type="button"
              role="option"
              aria-selected={project.slug === active.slug}
              className="selector__row"
              onClick={() => void activate(project.slug)}
            >
              <span className="selector__check">
                {project.slug === active.slug ? <CheckIcon size={11} /> : null}
              </span>
              <span className="selector__label">{project.name}</span>
              <span className="selector__hint">
                {project.roots.map((root) => root.title).join(" · ")}
              </span>
            </button>
          ))}
          <button
            type="button"
            role="option"
            aria-selected={false}
            className="selector__row"
            onClick={() => {
              setOpen(false);
              onNewProject();
            }}
          >
            <span className="selector__check" />
            <span className="selector__label">+ 새 프로젝트</span>
            <span className="selector__hint">다른 기획서 위치와 레포로</span>
          </button>
        </span>
      )}
      {failed && <span className="hint">프로젝트를 다시 선택해 주세요</span>}
    </span>
  );
}
