import { contextBridge, ipcRenderer } from "electron";

/**
 * 렌더러에 노출되는 유일한 데스크톱 다리: 수동 업데이트 확인(DESIGN §7).
 * 자격 증명·페어링 토큰은 절대 건너가지 않는다 — 렌더러는 존재만 안다.
 */
contextBridge.exposeInMainWorld("drafthouseDesktop", {
  updateCheck: () => ipcRenderer.invoke("desktop:update-check"),
  macSelfUpdate: (input: { url: string; sha256: string }) =>
    ipcRenderer.invoke("desktop:mac-self-update", input),
});
