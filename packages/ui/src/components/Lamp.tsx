import type { JSX } from "react";

// DESIGN.md 3: a 6px dot in one of the two signal colours, or hollow when off/unknown.
export function Lamp(p: { color: "go" | "look" | "off" }): JSX.Element {
  return <span className="lamp" data-color={p.color} aria-hidden="true" />;
}
