import { createRoot } from "react-dom/client";
import "@fontsource/geist/200.css";
import "@fontsource/geist/300.css";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./tokens.css";
import "./global.css";
import "./card.css";
import "./board.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(<App />);
