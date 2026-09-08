import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "@agent-hub/protocol";
import { SessionManager } from "./session-manager.js";
import { RepoWorkspace, loadRepoSettings, resolveRepoConfig } from "./repo.js";
import {
  buildStatus,
  filterFiles,
  listFiles,
  resolveClaudeExecutable,
} from "./environment.js";

// Session permission policy lives in Session itself: it pins the CLI to
// `default` mode (so a user's own global defaultMode cannot widen hub
// sessions) and answers edit-class tools in-process. See session.ts.

export interface DaemonConfig {
  host: string;
  port: number;
  /** Shared secret a client must present. Generated on first run. */
  token: string;
  claudeExecutable?: string;
}

export class DaemonServer {
  private readonly clients = new Set<WebSocket>();
  private readonly manager: SessionManager;
  private readonly repo: RepoWorkspace;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private claudeExecutable: string | null = null;

  constructor(private readonly config: DaemonConfig) {
    this.manager = new SessionManager({
      onEvent: (sessionId, event) => this.broadcast({ type: "session.event", sessionId, event }),
      onState: (sessionId, state, detail) =>
        this.broadcast({ type: "session.state", sessionId, state, ...(detail ? { detail } : {}) }),
      onPermissionRequest: (payload) =>
        this.broadcast({ type: "permission.request", ...payload }),
      onQuestionRequest: (payload) => this.broadcast({ type: "question.request", ...payload }),
    });
    // The environment url (fixture remotes in tests) wins over stored settings.
    const { root, url } = resolveRepoConfig();
    const settings = loadRepoSettings();
    this.repo = new RepoWorkspace({
      root,
      url: url ?? settings.url,
      pat: settings.pat,
      onStatus: (status) => this.broadcast({ type: "repo.status", status }),
    });
  }

  async start(): Promise<void> {
    this.claudeExecutable = await resolveClaudeExecutable(this.config.claudeExecutable);

    this.http = createServer((req, res) => {
      // A tiny health endpoint so `hub doctor` and launchd can probe the daemon.
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }));
        return;
      }
      res.writeHead(404).end();
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.searchParams.get("token") !== this.config.token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    });

    await new Promise<void>((resolve) =>
      this.http!.listen(this.config.port, this.config.host, resolve),
    );
  }

  async stop(): Promise<void> {
    await this.manager.closeAll();
    await this.repo.stop();
    for (const client of this.clients) client.close();
    this.wss?.close();
    await new Promise<void>((resolve) => this.http?.close(() => resolve()));
  }

  private attach(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("message", (raw) => void this.onMessage(ws, String(raw)));

    void this.status().then((status) =>
      this.send(ws, { type: "hello", protocolVersion: PROTOCOL_VERSION, status }),
    );
    void this.repo.status().then((status) => this.broadcast({ type: "repo.status", status }));
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  private broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  private async status() {
    return await buildStatus({
      executable: this.claudeExecutable,
      liveSessions: this.manager.liveCount,
      pendingPermissions: this.manager.pendingCount,
      // The registry probe only makes sense inside a repo that declares one.
      registryProbeDir: this.repo.registry() ? this.repo.root : null,
    });
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.send(ws, { type: "error", id: parsed.id, message: parsed.error, code: "bad_request" });
      return;
    }
    const message = parsed.value;
    try {
      const data = await this.dispatch(message);
      this.send(ws, { type: "ok", id: message.id, data });
    } catch (error) {
      this.send(ws, {
        type: "error",
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async dispatch(message: ClientMessage): Promise<unknown> {
    switch (message.type) {
      case "daemon.status":
        return await this.status();

      case "session.list":
        return await this.manager.list(this.repo.root, message.limit ?? 50);

      case "session.history":
        return await this.manager.history(message.sessionId, this.repo.root);

      case "session.create": {
        if (!this.claudeExecutable) {
          throw new Error("Claude Code CLI not found on this machine");
        }
        if (!existsSync(this.repo.root)) {
          throw new Error("연결 레포가 아직 준비되지 않았습니다 — 잠시 후 다시 시도해 주세요.");
        }
        // A session start is the moment the design tab goes back to the
        // remote: pull so Claude works on what the team pushed, without
        // blocking the session on it.
        void this.repo.pull();
        const session = this.manager.create({
          cwd: this.repo.root,
          claudeExecutable: this.claudeExecutable,
          ...(message.resume ? { resume: message.resume } : {}),
        });
        return { sessionId: session.id, state: session.state };
      }

      case "session.send":
        this.manager.require(message.sessionId).send(message.text, message.images, message.files);
        return { ok: true };

      case "session.interrupt":
        await this.manager.require(message.sessionId).interrupt();
        return { ok: true };

      case "session.close":
        await this.manager.close(message.sessionId);
        return { ok: true };

      case "session.delete":
        await this.manager.remove(message.sessionId, this.repo.root);
        return { ok: true };

      case "session.contextUsage":
        return await this.manager.require(message.sessionId).contextUsage();

      case "repo.files": {
        const files = await listFiles(this.repo.root);
        return filterFiles(files, message.query ?? "", message.limit ?? 40);
      }

      case "permission.respond": {
        const session = this.manager.findByRequest(message.requestId);
        if (!session) throw new Error("permission request is no longer pending");
        session.respondPermission(
          message.requestId,
          message.decision,
          message.message,
          message.updatedInput,
        );
        return { ok: true };
      }

      case "question.respond": {
        const session = this.manager.findByRequest(message.requestId);
        if (!session) throw new Error("question is no longer pending");
        session.respondQuestion(message.requestId, message.answers, message.response);
        return { ok: true };
      }

      case "repo.status":
        return await this.repo.status();

      case "repo.sync":
        return await this.repo.sync();

      case "repo.update":
        return await this.repo.update({
          ...(message.url !== undefined ? { url: message.url } : {}),
          ...(message.pat !== undefined ? { pat: message.pat } : {}),
        });
    }
  }
}
