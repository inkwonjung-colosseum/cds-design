import { StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CDSProvider } from "@colosseumcoinckr/cds/components/cds-provider";
import { MaterialIconsFont } from "@colosseumcoinckr/cds/components/icon";
import { Toaster } from "@colosseumcoinckr/cds/components/sonner";
import { AdminFrame } from "./frames/AdminFrame";
import { PreviewError } from "./PreviewError";
import { ScreenIndex } from "./ScreenIndex";
import { screens } from "./screens";
import "./index.css";

/** `#/<feature>/<Screen>?state=&frame=&theme=` — the chat UI drives this. */
interface Route {
  id: string;
  state: string | undefined;
  frame: "admin" | "none" | undefined;
  theme: "light" | "dark" | undefined;
}

function parseHash(hash: string): Route {
  const [path, search] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(search ?? "");
  const frame = params.get("frame");
  const theme = params.get("theme");
  return {
    id: decodeURIComponent(path ?? ""),
    state: params.get("state") ?? undefined,
    frame: frame === "admin" || frame === "none" ? frame : undefined,
    theme: theme === "dark" || theme === "light" ? theme : undefined,
  };
}

function App() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const screen = screens.find((candidate) => candidate.id === route.id);
  const frame = route.frame ?? screen?.meta.frame ?? "none";
  // An unknown state in the URL would render the screen's default branch
  // silently, which looks like the screen ignoring the picker. Drop it instead.
  const state =
    route.state && screen?.meta.states?.includes(route.state) ? route.state : undefined;

  let body = <ScreenIndex missing={route.id || null} />;
  if (screen) {
    const content = (
      <PreviewError key={`${screen.id}:${state ?? ""}`} screen={screen.id}>
        <screen.Component state={state} />
      </PreviewError>
    );
    body = frame === "admin" ? <AdminFrame screen={screen}>{content}</AdminFrame> : content;
  }

  return (
    <CDSProvider locale="ko" theme={route.theme ?? "light"}>
      <MaterialIconsFont />
      {body}
      <Toaster />
    </CDSProvider>
  );
}

// Vite re-runs this module on hot reload, and a second createRoot() on the
// same container tears the tree in half: React warns and hooks start failing.
// Keep the root on the container itself so a reload re-renders instead.
const container = document.getElementById("root")! as HTMLElement & { __root?: Root };
container.__root ??= createRoot(container);
container.__root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
