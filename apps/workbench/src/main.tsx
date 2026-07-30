import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/product-pages.css";
import "./styles/editor.css";
import "./styles/tools.css";
import "./styles/settings.css";
import "./styles/typography.css";
import "./styles/components.css";
import "./styles/cover.css";
import "./styles/assistant.css";
import "./styles/cloud-sync.css";
import "./styles/disassembly.css";
import "./styles/tutorial.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
