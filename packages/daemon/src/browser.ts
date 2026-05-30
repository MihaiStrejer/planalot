import { spawn } from "node:child_process";
import { release } from "node:os";

export function openBrowser(url: string): boolean {
  const browser = process.env.PLANALOT_BROWSER || process.env.BROWSER;
  const platform = process.platform;
  const wsl = platform === "linux" && release().toLowerCase().includes("microsoft");

  let command: string;
  let args: string[];

  if (browser) {
    if (platform === "darwin" && process.env.PLANALOT_BROWSER) {
      command = "open";
      args = ["-a", browser, url];
    } else if (platform === "win32" || wsl) {
      command = "cmd.exe";
      args = ["/c", "start", "", browser, url];
    } else {
      command = browser;
      args = [url];
    }
  } else if (platform === "win32" || wsl) {
    command = "cmd.exe";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
