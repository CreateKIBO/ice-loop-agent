import { createContext, useContext } from "react";

// Keep panel state mounted, but suspend list polling while its surface is hidden.
export const PaneActivity = createContext(true);
export const usePaneActive = () => useContext(PaneActivity);
