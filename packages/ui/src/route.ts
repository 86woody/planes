import { useCallback, useEffect, useState } from "react";

export type Route =
  | { page: "deck" }
  | { page: "session"; id: string }
  | { page: "run"; id: string; traceId: string };

const DECK: Route = { page: "deck" };

const decode = (seg: string): string | null => {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
};

/** DESIGN 3a: `#/`, `#/s/<id>`, `#/s/<id>/run/<traceId>`; anything else reads as the deck. */
export function parseRoute(hash: string): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  const parts = path.split("/");
  if (parts[0] !== "" || parts[1] !== "s") return DECK;
  if (parts.length === 3) {
    const id = decode(parts[2] ?? "");
    return id === null ? DECK : { page: "session", id };
  }
  if (parts.length === 5 && parts[3] === "run") {
    const id = decode(parts[2] ?? "");
    const traceId = decode(parts[4] ?? "");
    if (id === null || traceId === null) return DECK;
    return { page: "run", id, traceId };
  }
  return DECK;
}

export function routeHref(r: Route): string {
  switch (r.page) {
    case "deck":
      return "#/";
    case "session":
      return `#/s/${encodeURIComponent(r.id)}`;
    case "run":
      return `#/s/${encodeURIComponent(r.id)}/run/${encodeURIComponent(r.traceId)}`;
  }
}

const current = (): Route => parseRoute(typeof location === "undefined" ? "" : location.hash);

/** The current route, updated on hashchange; the setter assigns location.hash so Back works. */
export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(current);

  useEffect(() => {
    const onChange = (): void => setRoute(current());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((r: Route): void => {
    location.hash = routeHref(r);
  }, []);

  return [route, navigate];
}
