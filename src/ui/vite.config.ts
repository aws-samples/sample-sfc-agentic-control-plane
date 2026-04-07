import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load .env, .env.local, .env.production, etc. from the ui/ directory.
  // VITE_* variables are automatically exposed to import.meta.env by Vite,
  // but we also inject them explicitly via `define` so TypeScript can see them
  // and to make the values available at bundle time in production builds.
  const env = loadEnv(mode, process.cwd(), "VITE_");

  return {
    plugins: [react()],

    // ── Dev server ───────────────────────────────────────────────────
    server: {
      port: 5173,
      host: true,
      open: true,
    },

    // ── Build output ─────────────────────────────────────────────────
    build: {
      outDir: "dist",
    },

    // ── Compile-time constant injection ──────────────────────────────
    // These map import.meta.env.VITE_* to the values read from the
    // current .env file.  In production (CodeBuild) the values come
    // from .env.production written by the buildspec before `npm run build`.
    //
    // Required variables (set in ui/.env.local for local dev, or in
    // .env.production by the CDK CodeBuild buildspec for production):
    //
    //   VITE_API_BASE_URL          — API Gateway invoke URL
    //   VITE_COGNITO_DOMAIN        — Cognito Hosted UI base URL
    //   VITE_COGNITO_CLIENT_ID     — Cognito App Client ID
    //   VITE_COGNITO_REDIRECT_URI  — OAuth2 redirect URI
    //                                (http://localhost:5173/ for dev,
    //                                 CloudFront URL for production)
    define: {
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify(
        env.VITE_API_BASE_URL ?? ""
      ),
      "import.meta.env.VITE_COGNITO_DOMAIN": JSON.stringify(
        env.VITE_COGNITO_DOMAIN ?? ""
      ),
      "import.meta.env.VITE_COGNITO_CLIENT_ID": JSON.stringify(
        env.VITE_COGNITO_CLIENT_ID ?? ""
      ),
      "import.meta.env.VITE_COGNITO_REDIRECT_URI": JSON.stringify(
        env.VITE_COGNITO_REDIRECT_URI ?? ""
      ),
    },
  };
});
