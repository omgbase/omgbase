import { baseConfig } from "../../eslint.config.base.js";

export default baseConfig(import.meta.dirname, { files: ["src/**/*.ts", "corpus/**/*.ts"] });
