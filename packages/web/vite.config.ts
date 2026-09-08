import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Bind IPv4 explicitly. The default `localhost` resolves to ::1 only on
  // macOS, which makes the app unreachable at 127.0.0.1 while the daemon,
  // which does bind 127.0.0.1, is reachable. Matching them avoids confusion.
  server: { host: "127.0.0.1", port: 5273, strictPort: true },
});
