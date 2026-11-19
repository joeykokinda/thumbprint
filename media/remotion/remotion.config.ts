import path from "node:path";
import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

Config.overrideWebpackConfig((config) => {
  const c = enableTailwind(config);
  return { ...c, resolve: { ...c.resolve, alias: { ...c.resolve?.alias, "@": path.join(process.cwd(), "src") } } };
});
