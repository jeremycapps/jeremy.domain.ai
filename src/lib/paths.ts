import path from "node:path";

export function getProjectRoot(): string {
  return process.env.RESUME_ROUTER_ROOT
    ? path.resolve(process.env.RESUME_ROUTER_ROOT)
    : process.cwd();
}

export function toProjectRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}
