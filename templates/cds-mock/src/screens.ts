import type { ComponentType } from "react";

/**
 * A screen is one `*.screen.tsx` file under `src/screens/`. The registry is
 * built by glob so a newly written file shows up without anyone editing an
 * index: the daemon writes the file, Vite reloads, the preview lists it.
 *
 * Nothing imports a screen from anywhere but here. Each screen has to stand
 * alone so a developer can lift its folder into the real app.
 */
export interface ScreenMeta {
  /** Screen name as the planning document writes it. */
  title: string;
  /** Planning document this screen came from, relative to the project root. */
  spec?: string;
  /** One line for the index page. */
  description?: string;
  /** Variants the screen renders through its `state` prop. */
  states?: string[];
  /** Dummy app shell to wrap the screen in. */
  frame?: "admin" | "none";
}

export interface ScreenEntry {
  /** `<feature>/<ScreenName>`, from the file path. */
  id: string;
  feature: string;
  /** Path relative to the project root, for developer handoff. */
  file: string;
  meta: ScreenMeta;
  Component: ComponentType<{ state?: string }>;
}

const modules = import.meta.glob<{
  default: ComponentType<{ state?: string }>;
  meta?: Partial<ScreenMeta>;
}>("./screens/**/*.screen.tsx", { eager: true });

export const screens: ScreenEntry[] = Object.entries(modules)
  .map(([path, mod]) => {
    const id = path.replace(/^\.\/screens\//, "").replace(/\.screen\.tsx$/, "");
    const slash = id.indexOf("/");
    return {
      id,
      feature: slash === -1 ? "_root" : id.slice(0, slash),
      file: `src/screens/${id}.screen.tsx`,
      meta: { title: id.slice(id.lastIndexOf("/") + 1), ...mod.meta },
      Component: mod.default,
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

export const features: Array<{ name: string; screens: ScreenEntry[] }> = [
  ...new Set(screens.map((screen) => screen.feature)),
].map((name) => ({ name, screens: screens.filter((screen) => screen.feature === name) }));
